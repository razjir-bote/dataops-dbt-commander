import * as path from 'path';

export interface ModelEntry {
  name: string;
  package: string;
  version?: number | string;
  latestVersion?: number | string;
  file: string;
}

export interface SourceEntry {
  source: string;
  table: string;
  file: string;
}

export interface ManifestIndex {
  models: ModelEntry[];
  sources: SourceEntry[];
}

function fileFor(root: string, rootPackage: string, pkg: string, original: string): string {
  const rel = original.split(/[\\/]/);
  return pkg === rootPackage ? path.join(root, ...rel) : path.join(root, 'dbt_packages', pkg, ...rel);
}

/** Models and sources from a dbt-core 1.x target/manifest.json, with absolute file paths. */
export function parseManifest(json: string, root: string, rootPackage: string): ManifestIndex | undefined {
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
  for (const n of Object.values<any>(m.nodes ?? {})) {
    if (n?.resource_type !== 'model' || !n.name || !n.original_file_path) {
      continue;
    }
    models.push({
      name: n.name,
      package: n.package_name,
      ...(n.version !== null && n.version !== undefined ? { version: n.version } : {}),
      ...(n.latest_version !== null && n.latest_version !== undefined ? { latestVersion: n.latest_version } : {}),
      file: fileFor(root, rootPackage, n.package_name, n.original_file_path)
    });
  }
  const sources: SourceEntry[] = [];
  for (const s of Object.values<any>(m.sources ?? {})) {
    if (s?.source_name && s.name && s.original_file_path) {
      sources.push({ source: s.source_name, table: s.name, file: fileFor(root, rootPackage, s.package_name, s.original_file_path) });
    }
  }
  return { models, sources };
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
