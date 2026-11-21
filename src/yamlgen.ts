import { isMap, isScalar, isSeq, parseAllDocuments, parseDocument, YAMLMap, YAMLSeq } from 'yaml';

export interface Column {
  name: string;
  dataType: string;
}

/** Columns from `dbt compile --inline` output lines `DBTCOL|<name>|<type>`. */
export function parseColumnsOutput(output: string): Column[] {
  const cols: Column[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^DBTCOL\|([^|]+)\|(.*)$/.exec(line.trim());
    if (m) {
      cols.push({ name: m[1].trim(), dataType: m[2].trim() });
    }
  }
  return cols;
}

// dbt reads YAML with PyYAML (YAML 1.1): these plain scalars would come back as booleans, nulls or numbers.
const YAML11_TRAP = /^(y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|null|Null|NULL|~)$/;
const NUMBERISH = /^[-+]?(\d[\d_]*(\.\d*)?|\.\d+|\.inf|\.nan)([eE][-+]?\d+)?$|^[-+]?\d+(:[0-5]?\d)+$|^0[xob][\da-f_]+$/i;

/** Quote a scalar only when plain YAML (1.1 or 1.2) would misread it. */
export function scalar(v: string): string {
  return v === '' || YAML11_TRAP.test(v) || NUMBERISH.test(v) || /^[\s'"&*!|>%@`#?:,[\]{}-]|[:#]\s|:$|\s$|[\n\r\t]/.test(v)
    ? JSON.stringify(v)
    : v;
}

const sp = (n: number) => ' '.repeat(n);

function columnLines(columns: Column[], dash: number): string[] {
  return columns.flatMap(c => [`${sp(dash)}- name: ${scalar(c.name)}`, `${sp(dash + 2)}data_type: ${scalar(c.dataType)}`, `${sp(dash + 2)}description: ""`]);
}

function modelLines(model: string, columns: Column[], dash: number, indentSeq: boolean): string[] {
  const key = dash + 2;
  const head = [`${sp(dash)}- name: ${scalar(model)}`, `${sp(key)}description: ""`];
  // No columns yet (a brand-new model): leave `columns:` out rather than writing an empty (null) key.
  return columns.length ? [...head, `${sp(key)}columns:`, ...columnLines(columns, indentSeq ? key + 2 : key)] : head;
}

/** A fresh `version: 2` YAML file describing one model. */
export function newModelYaml(model: string, columns: Column[]): string {
  return ['version: 2', '', 'models:', ...modelLines(model, columns, 2, true)].join('\n') + '\n';
}

/** True when the text is a single YAML document without errors (multi-doc / duplicate keys can't be edited safely). */
export function yamlUsable(text: string): boolean {
  if (!text.trim()) {
    return true;
  }
  try {
    const docs = parseAllDocuments(text);
    return Array.isArray(docs) && docs.length === 1 && docs[0].errors.length === 0;
  } catch {
    return false;
  }
}

const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');
const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1;
const colOf = (text: string, offset: number) => offset - lineStart(text, offset);

/** Column of the `-` for an item of a block sequence, and the column its keys start at. */
function itemIndent(text: string, itemStart: number): { dash: number; key: number } {
  const ls = lineStart(text, itemStart);
  const dash = text.slice(ls, itemStart).indexOf('-');
  return { dash: dash >= 0 ? dash : colOf(text, itemStart) - 2, key: colOf(text, itemStart) };
}

/** Insert `lines` on new lines right after the line where `endOffset` falls (keeps everything else byte-identical). */
function insertAfter(text: string, endOffset: number, lines: string[]): string {
  const eol = eolOf(text);
  let p = text.indexOf('\n', Math.max(0, endOffset - 1));
  if (p < 0) {
    return text + eol + lines.join(eol) + eol;
  }
  if (p > 0 && text[p - 1] === '\r') {
    p--;
  }
  return text.slice(0, p) + eol + lines.join(eol) + text.slice(p);
}

/** Whether the file indents sequence items under their parent key (`models:\n  - name`) or not (`models:\n- name`). */
function indentsSequences(text: string, models: YAMLSeq | undefined): boolean {
  const first = models?.items[0];
  if (!first || !(isMap(first) || isScalar(first)) || !first.range) {
    return true;
  }
  return itemIndent(text, first.range[0]).dash > 0;
}

function findModel(seq: unknown, model: string): YAMLMap | undefined {
  return isSeq(seq) ? seq.items.find((i): i is YAMLMap => isMap(i) && String(i.get('name')) === model) : undefined;
}

export function hasModel(text: string, model: string): boolean {
  return yamlUsable(text) && !!findModel(parseDocument(text).get('models', true), model);
}

const FALLBACK = (indentSeq: boolean) => ({ indent: 2, indentSeq, flowCollectionPadding: false });

/** Append a model entry (creating `models:` if needed), leaving every existing line untouched. */
export function appendModel(text: string, model: string, columns: Column[]): string {
  if (!text.trim()) {
    return newModelYaml(model, columns).replace(/\n/g, eolOf(text));
  }
  if (!yamlUsable(text)) {
    throw new Error('the YAML file has errors or several documents, so it cannot be edited safely');
  }
  const doc = parseDocument(text);
  const models = doc.get('models', true);
  const eol = eolOf(text);
  if (isSeq(models) && !models.flow && models.items.length && models.range) {
    const first = models.items[0] as YAMLMap;
    const { dash } = itemIndent(text, first.range![0]);
    const last = models.items[models.items.length - 1] as YAMLMap;
    return insertAfter(text, last.range![1], modelLines(model, columns, dash, dash > 0));
  }
  if (!doc.has('models')) {
    const body = ['models:', ...modelLines(model, columns, 2, true)].join(eol) + eol;
    return text + (text.endsWith('\n') ? '' : eol) + body;
  }
  // `models: []`, `models:` with no items, or a flow list: let the YAML library rewrite it.
  const seq = isSeq(models) ? models : (doc.createNode([]) as YAMLSeq);
  if (!isSeq(models)) {
    doc.set('models', seq);
  }
  seq.flow = false;
  seq.add(doc.createNode({ name: model, description: '', columns: columns.map(c => ({ name: c.name, data_type: c.dataType, description: '' })) }));
  return doc.toString(FALLBACK(true)).replace(/\r?\n/g, eol);
}

/**
 * Add the columns missing from an existing model entry (names compared case-insensitively), leaving every
 * existing line untouched. Undefined if the model isn't in the file.
 */
export function mergeColumns(text: string, model: string, columns: Column[]): { text: string; added: string[] } | undefined {
  if (!yamlUsable(text)) {
    return undefined;
  }
  const doc = parseDocument(text);
  const models = doc.get('models', true);
  const entry = findModel(models, model);
  if (!entry) {
    return undefined;
  }
  const current = entry.get('columns', true);
  const have = new Set((isSeq(current) ? current.items : []).filter(isMap).map(i => String(i.get('name')).toLowerCase()));
  const missing = columns.filter(c => !have.has(c.name.toLowerCase()));
  const added = missing.map(c => c.name);
  if (!missing.length) {
    return { text, added };
  }
  const indentSeq = indentsSequences(text, isSeq(models) ? models : undefined);

  if (isSeq(current) && !current.flow && current.items.length) {
    const first = current.items[0] as YAMLMap;
    const last = current.items[current.items.length - 1] as YAMLMap;
    if (first.range && last.range) {
      return { text: insertAfter(text, last.range[1], columnLines(missing, itemIndent(text, first.range[0]).dash)), added };
    }
  }
  if (current === undefined && entry.range && entry.items[0]?.key && isScalar(entry.items[0].key) && entry.items[0].key.range) {
    const key = colOf(text, entry.items[0].key.range[0]);
    const lines = [`${sp(key)}columns:`, ...columnLines(missing, indentSeq ? key + 2 : key)];
    return { text: insertAfter(text, entry.range[1], lines), added };
  }
  // Flow or empty `columns:`: let the YAML library rewrite it.
  const seq = isSeq(current) ? current : (doc.createNode([]) as YAMLSeq);
  if (!isSeq(current)) {
    entry.set('columns', seq);
  }
  seq.flow = false;
  for (const c of missing) {
    seq.add(doc.createNode({ name: c.name, data_type: c.dataType, description: '' }));
  }
  return { text: doc.toString(FALLBACK(indentSeq)).replace(/\r?\n/g, eolOf(text)), added };
}

// ---------- seed as source ----------

/** The column names in a CSV's first record (quotes, a BOM and CRLF handled). */
export function csvHeader(text: string): string[] {
  const s = text.replace(/^\ufeff/, '');
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      break;
    } else {
      cur += ch;
    }
  }
  if (cur || out.length) {
    out.push(cur);
  }
  return out.map(c => c.trim()).filter((c, i, all) => c || i < all.length - 1);
}

export interface SourceTableSpec {
  source: string;
  schema?: string;
  database?: string;
  table: string;
  description: string;
  columns: string[];
}

function tableLines(t: SourceTableSpec, dash: number, indentSeq: boolean): string[] {
  const key = dash + 2;
  const cols = t.columns.map(c => `${sp(indentSeq ? key + 2 : key)}- name: ${scalar(c)}`);
  return [`${sp(dash)}- name: ${scalar(t.table)}`, `${sp(key)}description: ${JSON.stringify(t.description)}`, ...(cols.length ? [`${sp(key)}columns:`, ...cols] : [])];
}

function sourceLines(t: SourceTableSpec, dash: number, indentSeq: boolean): string[] {
  const key = dash + 2;
  return [
    `${sp(dash)}- name: ${scalar(t.source)}`,
    ...(t.database ? [`${sp(key)}database: ${scalar(t.database)}`] : []),
    ...(t.schema ? [`${sp(key)}schema: ${scalar(t.schema)}`] : []),
    `${sp(key)}tables:`,
    ...tableLines(t, indentSeq ? key + 2 : key, indentSeq)
  ];
}

/**
 * Add a source table (and its source, and `sources:`, when missing) to a YAML file's text, leaving every existing
 * line untouched. `exists`: the source already has a table of that name — nothing changed.
 */
export function addSourceTable(text: string, t: SourceTableSpec): { text: string; status: 'added' | 'exists' } {
  const eol = eolOf(text);
  if (!text.trim()) {
    return { text: ['version: 2', '', 'sources:', ...sourceLines(t, 2, true)].join(eol) + eol, status: 'added' };
  }
  if (!yamlUsable(text)) {
    throw new Error('the YAML file has errors or several documents, so it cannot be edited safely');
  }
  const doc = parseDocument(text);
  const sources = doc.get('sources', true);
  if (isSeq(sources) && !sources.flow && sources.items.length && (sources.items[0] as YAMLMap).range) {
    const indentSeq = indentsSequences(text, sources as YAMLSeq);
    const entry = (sources as YAMLSeq).items.find((i): i is YAMLMap => isMap(i) && String(i.get('name')) === t.source);
    if (!entry) {
      const { dash } = itemIndent(text, (sources.items[0] as YAMLMap).range![0]);
      const last = sources.items[sources.items.length - 1] as YAMLMap;
      return { text: insertAfter(text, last.range![1], sourceLines(t, dash, indentSeq)), status: 'added' };
    }
    const tables = entry.get('tables', true);
    if (isSeq(tables) && tables.items.some(i => isMap(i) && String(i.get('name')) === t.table)) {
      return { text, status: 'exists' };
    }
    if (isSeq(tables) && !tables.flow && tables.items.length && (tables.items[0] as YAMLMap).range) {
      const { dash } = itemIndent(text, (tables.items[0] as YAMLMap).range![0]);
      const last = tables.items[tables.items.length - 1] as YAMLMap;
      return { text: insertAfter(text, last.range![1], tableLines(t, dash, indentSeq)), status: 'added' };
    }
    if (tables === undefined && entry.range && entry.items[0]?.key && isScalar(entry.items[0].key) && entry.items[0].key.range) {
      const key = colOf(text, entry.items[0].key.range[0]);
      return { text: insertAfter(text, entry.range[1], [`${sp(key)}tables:`, ...tableLines(t, indentSeq ? key + 2 : key, indentSeq)]), status: 'added' };
    }
  }
  if (!doc.has('sources')) {
    const body = ['sources:', ...sourceLines(t, 2, true)].join(eol) + eol;
    return { text: text + (text.endsWith('\n') ? '' : eol) + body, status: 'added' };
  }
  // Flow / empty lists: let the YAML library rewrite the file.
  const tableNode = { name: t.table, description: t.description, ...(t.columns.length ? { columns: t.columns.map(c => ({ name: c })) } : {}) };
  const list = isSeq(sources) ? sources : (doc.createNode([]) as YAMLSeq);
  if (!isSeq(sources)) {
    doc.set('sources', list);
  }
  list.flow = false;
  const existing = list.items.find((i): i is YAMLMap => isMap(i) && String(i.get('name')) === t.source);
  if (existing) {
    const tl = existing.get('tables', true);
    const seq = isSeq(tl) ? tl : (doc.createNode([]) as YAMLSeq);
    if (!isSeq(tl)) {
      existing.set('tables', seq);
    }
    seq.flow = false;
    seq.add(doc.createNode(tableNode));
  } else {
    list.add(doc.createNode({ name: t.source, ...(t.database ? { database: t.database } : {}), ...(t.schema ? { schema: t.schema } : {}), tables: [tableNode] }));
  }
  return { text: doc.toString(FALLBACK(true)).replace(/\r?\n/g, eol), status: 'added' };
}
