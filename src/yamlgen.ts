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
  return [`${sp(dash)}- name: ${scalar(model)}`, `${sp(key)}description: ""`, `${sp(key)}columns:`, ...columnLines(columns, indentSeq ? key + 2 : key)];
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
