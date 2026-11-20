import * as path from 'path';
import { ColumnInfo, ModelEntry, SourceEntry } from './manifest';

export interface RunResult {
  uniqueId: string;
  /** dbt-core 1.x: pass | fail | warn | error | skipped (tests); success | error | skipped (models). */
  status: string;
  message?: string;
  seconds?: number;
}

/** Results from `target/run_results.json`. */
export function parseRunResults(json: string): RunResult[] {
  try {
    const results = JSON.parse(json)?.results;
    if (!Array.isArray(results)) {
      return [];
    }
    return results
      .filter((r: any) => typeof r?.unique_id === 'string')
      .map((r: any) => ({
        uniqueId: r.unique_id,
        status: String(r.status ?? ''),
        ...(typeof r.message === 'string' && r.message ? { message: r.message } : {}),
        ...(typeof r.execution_time === 'number' ? { seconds: r.execution_time } : {})
      }));
  } catch {
    return [];
  }
}

/** The invocation id in a run_results.json, if readable. */
export function invocationOf(json: string): string | undefined {
  try {
    const id = JSON.parse(json)?.metadata?.invocation_id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The results, only if this file was written by a new `dbt <which>` invocation that finished after `startedMs`
 * — never results left by an earlier run or by another dbt command (e.g. a terminal `dbt build`).
 */
export function acceptResults(json: string, previousInvocation: string | undefined, startedMs: number, which = 'test'): RunResult[] | undefined {
  let doc: any;
  try {
    doc = JSON.parse(json);
  } catch {
    return undefined;
  }
  const id = doc?.metadata?.invocation_id;
  const generated = Date.parse(doc?.metadata?.generated_at ?? '');
  if (typeof id !== 'string' || id === previousInvocation || doc?.args?.which !== which || !(generated >= startedMs - 1000)) {
    return undefined;
  }
  return parseRunResults(json);
}

/** Split selectors into groups whose space-joined length stays under `maxChars` (Windows command lines are ~32k). */
export function batchSelectors(selectors: string[], maxChars: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let len = 0;
  for (const s of selectors) {
    if (current.length && len + 1 + s.length > maxChars) {
      batches.push(current);
      current = [];
      len = 0;
    }
    len += (current.length ? 1 : 0) + s.length;
    current.push(s);
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const itemRe = (name: string) => new RegExp(`^(\\s*)-\\s*name:\\s*['"]?${escapeRe(name)}['"]?\\s*$`);

/**
 * 0-based line in a YAML file where a test belongs: the `- name: <column>` inside the model's entry, else the
 * model's `- name:` line, else 0.
 */
export function testLine(yamlText: string, model: string, column?: string): number {
  const lines = yamlText.split(/\r?\n/);
  const modelRe = itemRe(model);
  /** The key owning the list item on line i (e.g. "models", "tables", "columns"). */
  const parentKey = (i: number, indent: number) => {
    for (let k = i - 1; k >= 0; k--) {
      const key = /^(\s*)([\w-]+):\s*(#.*)?$/.exec(lines[k]);
      if (key && key[1].length < indent) {
        return key[2];
      }
    }
    return undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const m = modelRe.exec(lines[i]);
    // Only a model (models:) or source table (tables:) entry — not a same-named column or source.
    if (!m || !['models', 'tables'].includes(parentKey(i, m[1].length) ?? '')) {
      continue;
    }
    if (column) {
      const colRe = itemRe(column);
      const indent = m[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const next = /^(\s*)-\s/.exec(lines[j]);
        if (/^\S/.test(lines[j]) || (next && next[1].length <= indent)) {
          break; // next model or top-level key
        }
        if (colRe.test(lines[j])) {
          return j;
        }
      }
    }
    return i;
  }
  return 0;
}

/** Warehouse columns per node / source unique_id from `target/catalog.json`, in table order. */
export function parseCatalog(json: string): Map<string, ColumnInfo[]> {
  const out = new Map<string, ColumnInfo[]>();
  let c: any;
  try {
    c = JSON.parse(json);
  } catch {
    return out;
  }
  for (const group of [c?.nodes, c?.sources]) {
    for (const [id, node] of Object.entries<any>(group ?? {})) {
      const cols = Object.values<any>(node?.columns ?? {})
        .filter(x => x?.name)
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map(x => ({ name: String(x.name), ...(x.type ? { dataType: String(x.type) } : {}) }));
      out.set(id, cols);
    }
  }
  return out;
}

/** Project-supplied text: no images (a cloned repo could use them as tracking beacons). */
const safe = (s: string) => s.replace(/!\[/g, '!\\[');
const cell = (s: string | undefined) => safe((s ?? '').replace(/\s*\r?\n\s*/g, ' ').replace(/\|/g, '\\|').trim());
const code = (s: string) => '`' + s.replace(/`/g, "'") + '`';

/** Documented columns merged with the warehouse's (catalog order and types first, then documented-only columns). */
export function columnsFor(documented: ColumnInfo[], catalog: ColumnInfo[] | undefined): ColumnInfo[] {
  if (!catalog?.length) {
    return documented;
  }
  const doc = new Map(documented.map(c => [c.name.toLowerCase(), c]));
  const merged = catalog.map(c => ({ ...doc.get(c.name.toLowerCase()), name: c.name, dataType: c.dataType ?? doc.get(c.name.toLowerCase())?.dataType }));
  const seen = new Set(catalog.map(c => c.name.toLowerCase()));
  return [...merged, ...documented.filter(c => !seen.has(c.name.toLowerCase()))];
}

function columnTable(cols: ColumnInfo[]): string[] {
  if (!cols.length) {
    return [];
  }
  return ['', '| Column | Type | Description |', '|---|---|---|', ...cols.map(c => `| ${code(c.name)} | ${cell(c.dataType)} | ${cell(c.description)} |`)];
}

const relPath = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');

/** Markdown for hovering a ref() to `model`. */
export function modelHover(model: ModelEntry, catalog: ColumnInfo[] | undefined, root: string): string {
  const head = `**${model.name}** · model${model.materialized ? ` · \`${model.materialized}\`` : ''}${model.version !== undefined ? ` · v${model.version}` : ''}`;
  return [
    head,
    ...(model.description ? ['', safe(model.description)] : []),
    '',
    `\`${relPath(root, model.file)}\``,
    ...columnTable(columnsFor(model.columns, catalog))
  ].join('\n');
}

/** Markdown for hovering a source('src', 'table'). */
export function sourceHover(src: SourceEntry, catalog: ColumnInfo[] | undefined, root: string): string {
  const facts = [src.loader ? `Loader: ${safe(src.loader)}` : '', src.identifier ? `Identifier: ${code(src.identifier)}` : ''].filter(Boolean);
  return [
    `**${src.source}.${src.table}** · source`,
    ...(src.description ? ['', safe(src.description)] : []),
    ...(src.sourceDescription ? ['', `*${src.source}:* ${safe(src.sourceDescription)}`] : []),
    ...(facts.length ? ['', facts.join(' · ')] : []),
    '',
    `\`${relPath(root, src.file)}\``,
    ...columnTable(columnsFor(src.columns, catalog))
  ].join('\n');
}
