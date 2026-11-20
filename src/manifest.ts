import * as path from 'path';

export interface ColumnInfo {
  name: string;
  dataType?: string;
  description?: string;
}

export interface ModelEntry {
  uniqueId: string;
  name: string;
  package: string;
  version?: number | string;
  latestVersion?: number | string;
  materialized?: string;
  description?: string;
  columns: ColumnInfo[];
  file: string;
}

export interface SourceEntry {
  uniqueId: string;
  source: string;
  table: string;
  package: string;
  description?: string;
  sourceDescription?: string;
  loader?: string;
  identifier?: string;
  columns: ColumnInfo[];
  file: string;
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

/** Documented columns of a manifest node / source, in YAML order. */
function columnsOf(cols: unknown): ColumnInfo[] {
  return Object.values<any>(cols && typeof cols === 'object' ? cols : {})
    .filter(c => c?.name)
    .map(c => ({
      name: String(c.name),
      ...(text(c.data_type) ? { dataType: c.data_type } : {}),
      ...(text(c.description) ? { description: c.description } : {})
    }));
}

export interface MacroEntry {
  name: string;
  package: string;
  /** Absolute path, or undefined when the file can't be located (e.g. dbt's own macros without a venv). */
  file?: string;
  /** dbt's own (`dbt`) or the adapter's macros: callable without a package prefix, like the project's. */
  internal?: boolean;
}

/** A seed, snapshot or test in the root project. */
export interface NodeEntry {
  uniqueId: string;
  name: string;
  package: string;
  file: string;
  /** For tests: the model (or `source.table`) the test is attached to. */
  attachedTo?: string;
  /** For generic tests: the column the test is on. */
  columnName?: string;
  /** For tests: a singular test (its own .sql file) rather than a generic test declared in YAML. */
  singular?: boolean;
}

export interface ManifestIndex {
  models: ModelEntry[];
  sources: SourceEntry[];
  macros: MacroEntry[];
  seeds: NodeEntry[];
  snapshots: NodeEntry[];
  tests: NodeEntry[];
  /** Root-project model name → the YAML file that already describes it (`patch_path`). */
  patches: Map<string, string>;
}

function fileFor(root: string, rootPackage: string, pkg: string, original: string): string {
  const rel = original.split(/[\\/]/);
  return pkg === rootPackage ? path.join(root, ...rel) : path.join(root, 'dbt_packages', pkg, ...rel);
}

/**
 * Where a macro's file lives: the project, an installed package (dbt_packages/<pkg>), dbt's global project
 * (package `dbt`) or an adapter (`dbt_<adapter>`) inside the venv's `dbt/include` folder.
 */
export function macroFile(
  root: string,
  rootPackage: string,
  pkg: string,
  original: string,
  dbtIncludeDir: string | undefined,
  exists: (p: string) => boolean
): string | undefined {
  const rel = original.split(/[\\/]/);
  if (pkg === rootPackage) {
    return path.join(root, ...rel);
  }
  if (pkg !== 'dbt' && exists(path.join(root, 'dbt_packages', pkg))) {
    return path.join(root, 'dbt_packages', pkg, ...rel);
  }
  if (!dbtIncludeDir) {
    return pkg === 'dbt' ? undefined : path.join(root, 'dbt_packages', pkg, ...rel);
  }
  if (pkg === 'dbt') {
    return path.join(dbtIncludeDir, 'global_project', ...rel);
  }
  if (pkg.startsWith('dbt_')) {
    return path.join(dbtIncludeDir, pkg.slice('dbt_'.length), ...rel);
  }
  return path.join(root, 'dbt_packages', pkg, ...rel);
}

/** The macro a call refers to: the named package if given, else the project, then packages/adapters, then dbt. */
export function resolveMacro(macros: MacroEntry[], name: string, pkg?: string, rootPackage?: string): MacroEntry | undefined {
  // Like dbt: `pkg.name()` looks in that package; a bare `name()` sees the project and dbt's internal macros only.
  const candidates = macros.filter(m => m.name === name && (pkg ? m.package === pkg : m.package === rootPackage || m.internal));
  const rank = (m: MacroEntry) => (m.package === rootPackage ? 0 : m.package === 'dbt' ? 2 : 1);
  return candidates.sort((a, b) => rank(a) - rank(b))[0];
}

/** 0-based line of `{% macro <name>(` (any whitespace control) in a macro file; 0 if not found. */
export function macroDefinitionLine(text: string, name: string): number {
  const re = new RegExp(`\\{%-?\\s*macro\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
  const i = text.split(/\r?\n/).findIndex(l => re.test(l));
  return Math.max(0, i);
}

/** Models and sources from a dbt-core 1.x target/manifest.json, with absolute file paths. */
export function parseManifest(
  json: string,
  root: string,
  rootPackage: string,
  dbtIncludeDir?: string,
  exists: (p: string) => boolean = p => require('fs').existsSync(p)
): ManifestIndex | undefined {
  let m: any;
  try {
    m = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!m || typeof m !== 'object') {
    return undefined;
  }
  const models: ModelEntry[] = [];
  for (const [id, n] of Object.entries<any>(m.nodes ?? {})) {
    if (n?.resource_type !== 'model' || !n.name || !n.original_file_path) {
      continue;
    }
    models.push({
      uniqueId: n.unique_id ?? id,
      name: n.name,
      package: n.package_name,
      ...(n.version !== null && n.version !== undefined ? { version: n.version } : {}),
      ...(n.latest_version !== null && n.latest_version !== undefined ? { latestVersion: n.latest_version } : {}),
      ...(typeof n.config?.materialized === 'string' ? { materialized: n.config.materialized } : {}),
      ...(text(n.description) ? { description: n.description } : {}),
      columns: columnsOf(n.columns),
      file: fileFor(root, rootPackage, n.package_name, n.original_file_path)
    });
  }
  const sources: SourceEntry[] = [];
  for (const [id, s] of Object.entries<any>(m.sources ?? {})) {
    if (s?.source_name && s.name && s.original_file_path) {
      sources.push({
        uniqueId: s.unique_id ?? id,
        source: s.source_name,
        table: s.name,
        package: s.package_name,
        ...(text(s.description) ? { description: s.description } : {}),
        ...(text(s.source_description) ? { sourceDescription: s.source_description } : {}),
        ...(text(s.loader) ? { loader: s.loader } : {}),
        ...(text(s.identifier) && s.identifier !== s.name ? { identifier: s.identifier } : {}),
        columns: columnsOf(s.columns),
        file: fileFor(root, rootPackage, s.package_name, s.original_file_path)
      });
    }
  }

  const macros: MacroEntry[] = [];
  for (const mc of Object.values<any>(m.macros ?? {})) {
    if (mc?.name && mc.package_name && mc.original_file_path) {
      const file = macroFile(root, rootPackage, mc.package_name, mc.original_file_path, dbtIncludeDir, exists);
      const internal =
        mc.package_name === 'dbt' ||
        mc.package_name === `dbt_${m.metadata?.adapter_type}` ||
        (!!dbtIncludeDir && !!file && file.startsWith(dbtIncludeDir) && exists(file));
      macros.push({ name: mc.name, package: mc.package_name, file, ...(internal ? { internal } : {}) });
    }
  }

  const seeds: NodeEntry[] = [];
  const snapshots: NodeEntry[] = [];
  const tests: NodeEntry[] = [];
  const patches = new Map<string, string>();
  for (const [id, n] of Object.entries<any>(m.nodes ?? {})) {
    if (!n?.name || !n.original_file_path || n.package_name !== rootPackage) {
      continue;
    }
    const entry: NodeEntry = {
      uniqueId: n.unique_id ?? id,
      name: n.name,
      package: n.package_name,
      file: fileFor(root, rootPackage, n.package_name, n.original_file_path)
    };
    if (n.resource_type === 'seed') {
      seeds.push(entry);
    } else if (n.resource_type === 'snapshot') {
      snapshots.push(entry);
    } else if (n.resource_type === 'test') {
      // Model tests carry attached_node; tests on sources only list the source in depends_on ("raw.orders").
      const src = (n.depends_on?.nodes ?? []).find((d: unknown) => typeof d === 'string' && d.startsWith('source.'));
      const attached =
        typeof n.attached_node === 'string' ? n.attached_node.split('.')[2] : src ? src.split('.').slice(2).join('.') : undefined;
      tests.push({
        ...entry,
        ...(attached ? { attachedTo: attached } : {}),
        ...(text(n.column_name) ? { columnName: n.column_name } : {}),
        singular: /\.sql$/i.test(n.original_file_path)
      });
    } else if (n.resource_type === 'model' && typeof n.patch_path === 'string') {
      // e.g. "demo://models\\schema.yml"
      const rel = n.patch_path.replace(/^[^:]+:\/\//, '');
      patches.set(n.name, path.join(root, ...rel.split(/[\\/]/)));
    }
  }
  return { models, sources, macros, seeds, snapshots, tests, patches };
}

/**
 * 0-based line of `- name: <table>` under source `<source>` inside the top-level `sources:` block
 * of a dbt YAML file; falls back to the source's line, then 0.
 */
export function sourceTableLine(text: string, source: string, table: string): number {
  const lines = text.split(/\r?\n/);
  const item = (name: string) =>
    new RegExp(`^(\\s*)-\\s*name:\\s*['"]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`);
  const srcRe = item(source);
  const tblRe = item(table);
  let inSources = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) {
      inSources = /^sources:\s*$/.test(l);
      continue;
    }
    const src = inSources ? srcRe.exec(l) : null;
    if (!src) {
      continue;
    }
    const srcIndent = src[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j];
      if (/^\S/.test(t)) {
        break; // left the sources block
      }
      const nextItem = /^(\s*)-\s/.exec(t);
      if (nextItem && nextItem[1].length <= srcIndent) {
        break; // next source
      }
      if (tblRe.test(t)) {
        return j;
      }
    }
    return i;
  }
  return 0;
}

/** The model a ref() points at: matching package/version, defaulting to the latest version. */
export function resolveRef(models: ModelEntry[], name: string, pkg?: string, version?: string): ModelEntry | undefined {
  const candidates = models.filter(m => m.name === name && (!pkg || m.package === pkg));
  if (version !== undefined) {
    return candidates.find(m => String(m.version) === String(version));
  }
  return candidates.find(m => m.latestVersion !== undefined && String(m.version) === String(m.latestVersion)) ?? candidates[0];
}
