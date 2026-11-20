/** Quick-fix edits for model columns in dbt YAML files, made as plain text insertions. */

import { ColumnOwner } from './profile';

/**
 * A test to add: a name (`unique`, `dbt_utils.not_constant`), accepted_values, or a test with arguments given as
 * YAML scalars (`{ test: 'relationships', args: { to: "ref('customers')", field: 'id' } }`).
 */
export type TestSpec = string | { accepted_values: string[] } | { test: string; args: Record<string, string> };

export interface ColumnRef {
  model: string;
  column: string;
  /** The column's existing tests key, if any. */
  testsKey?: 'data_tests' | 'tests';
}

const indentOf = (l: string) => l.length - l.trimStart().length;
const ignorable = (l: string) => !l.trim() || l.trim().startsWith('#');
const NAME_ITEM = /^(\s*)-\s+name:\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/;
const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');

/** Line of the key a list item at `line` belongs to (handles indentless lists). */
function parentKeyLine(lines: string[], line: number): number {
  const dash = indentOf(lines[line]);
  for (let k = line - 1; k >= 0; k--) {
    if (ignorable(lines[k])) {
      continue;
    }
    const ind = indentOf(lines[k]);
    if (ind < dash || (ind === dash && !lines[k].trimStart().startsWith('-'))) {
      return k;
    }
  }
  return -1;
}

/** Last line belonging to the block that starts at `line` (lines more indented than `indent`), ignoring trailing blanks. */
function blockEnd(lines: string[], line: number, indent: number, indentlessDashes = false): number {
  let end = line;
  for (let k = line + 1; k < lines.length; k++) {
    if (ignorable(lines[k])) {
      continue;
    }
    const ind = indentOf(lines[k]);
    if (ind > indent || (indentlessDashes && ind === indent && lines[k].trimStart().startsWith('-'))) {
      end = k;
    } else {
      break;
    }
  }
  return end;
}

/** The \`- name:\` list item owning a \`columns:\` / \`tables:\` key line, if any. */
function ownerItem(lines: string[], keyLine: number): number {
  for (let k = keyLine - 1; k >= 0; k--) {
    if (!ignorable(lines[k]) && indentOf(lines[k]) < indentOf(lines[keyLine])) {
      return NAME_ITEM.test(lines[k]) ? k : -1;
    }
  }
  return -1;
}

const KINDS: Record<string, ColumnOwner['kind']> = { models: 'model', seeds: 'seed', snapshots: 'snapshot' };

function columnItem(lines: string[], line: number): { item: number; owner: ColumnOwner; column: string } | undefined {
  let item = -1;
  for (let k = line; k >= 0; k--) {
    if (ignorable(lines[k])) {
      continue;
    }
    if (NAME_ITEM.test(lines[k])) {
      item = k;
      break;
    }
  }
  if (item < 0 || (item !== line && blockEnd(lines, item, indentOf(lines[item])) < line)) {
    return undefined;
  }
  const cols = parentKeyLine(lines, item);
  if (cols < 0 || !/^\s*columns:\s*(#.*)?$/.test(lines[cols])) {
    return undefined;
  }
  const column = unquote(NAME_ITEM.exec(lines[item])![2]);
  const owner = ownerItem(lines, cols);
  const list = owner >= 0 ? parentKeyLine(lines, owner) : -1;
  const key = list >= 0 ? /^\s*(models|seeds|snapshots|tables):\s*(#.*)?$/.exec(lines[list])?.[1] : undefined;
  if (!key) {
    return undefined;
  }
  const name = unquote(NAME_ITEM.exec(lines[owner])![2]);
  if (key !== 'tables') {
    // Top-level lists only (\`models:\` inside something else is not a resource list).
    return indentOf(lines[list]) === 0 ? { item, owner: { kind: KINDS[key], name }, column } : undefined;
  }
  const source = ownerItem(lines, list);
  const sources = source >= 0 ? parentKeyLine(lines, source) : -1;
  if (sources < 0 || !/^sources:\s*(#.*)?$/.test(lines[sources])) {
    return undefined;
  }
  return { item, owner: { kind: 'source', source: unquote(NAME_ITEM.exec(lines[source])![2]), name }, column };
}

function testsKeyLine(lines: string[], item: number): { line: number; key: 'data_tests' | 'tests' } | undefined {
  const keyIndent = lines[item].indexOf('name:');
  const end = blockEnd(lines, item, indentOf(lines[item]));
  for (let k = item + 1; k <= end; k++) {
    const m = /^(\s*)(data_tests|tests):/.exec(lines[k]);
    if (m && m[1].length === keyIndent) {
      return { line: k, key: m[2] as 'data_tests' | 'tests' };
    }
  }
  return undefined;
}

/** The model column whose YAML entry contains `line` (0-based), if any. */
export function columnAt(text: string, line: number): ColumnRef | undefined {
  const lines = text.split(/\r?\n/);
  if (line < 0 || line >= lines.length) {
    return undefined;
  }
  const c = columnItem(lines, line);
  if (!c || c.owner.kind !== 'model') {
    return undefined;
  }
  return { model: c.owner.name, column: c.column, testsKey: testsKeyLine(lines, c.item)?.key };
}

/** The model / seed / snapshot / source column whose YAML entry contains \`line\` (0-based), if any. */
export function columnOwnerAt(text: string, line: number): (ColumnOwner & { column: string }) | undefined {
  const lines = text.split(/\r?\n/);
  const c = line >= 0 && line < lines.length ? columnItem(lines, line) : undefined;
  return c && { ...c.owner, column: c.column };
}

const testName = (t: TestSpec) => (typeof t === 'string' ? t : 'accepted_values' in t ? 'accepted_values' : t.test);

function testLines(t: TestSpec, dash: number, legacy: boolean): string[] {
  const sp = (n: number) => ' '.repeat(n);
  if (typeof t === 'string') {
    return [`${sp(dash)}- ${t}`];
  }
  const args: Record<string, string> =
    'accepted_values' in t ? { values: `[${t.accepted_values.map(v => JSON.stringify(v)).join(', ')}]` } : t.args;
  const argLines = (indent: number) => Object.entries(args).map(([k, v]) => `${sp(indent)}${k}: ${v}`);
  // dbt 1.10+ wants test arguments under `arguments:` (and warns otherwise); older versions don't know the key.
  return legacy
    ? [`${sp(dash)}- ${testName(t)}:`, ...argLines(dash + 4)]
    : [`${sp(dash)}- ${testName(t)}:`, `${sp(dash + 4)}arguments:`, ...argLines(dash + 6)];
}

/**
 * Text to insert (before 0-based `line`) adding tests to the column at `line`: into its `data_tests:` / `tests:`
 * list, or a new `data_tests:` list. Undefined when there's nothing to add or the YAML can't be edited safely.
 */
export function addTestsEdit(
  text: string,
  line: number,
  tests: TestSpec[],
  opts: { legacyArguments?: boolean } = {}
): { line: number; text: string } | undefined {
  const legacy = !!opts.legacyArguments;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (line < 0 || line >= lines.length) {
    return undefined;
  }
  const c = columnItem(lines, line);
  if (!c || c.owner.kind !== 'model') {
    return undefined;
  }
  const keyIndent = lines[c.item].indexOf('name:');
  const existing = testsKeyLine(lines, c.item);
  let insertAt: number;
  let out: string[];
  if (existing) {
    if (!/^\s*(data_tests|tests):\s*(#.*)?$/.test(lines[existing.line])) {
      return undefined; // flow style (`tests: [a]`) or other inline value
    }
    const end = blockEnd(lines, existing.line, keyIndent, true);
    const present = new Set<string>();
    let dash = keyIndent + 2;
    let firstItem = true;
    for (let k = existing.line + 1; k <= end; k++) {
      const m = /^(\s*)-\s*['"]?([A-Za-z_][\w.]*)/.exec(lines[k]);
      if (m && (firstItem || m[1].length === dash)) {
        if (firstItem) {
          dash = m[1].length;
          firstItem = false;
        }
        present.add(m[2]);
      }
      const named = /^\s*test_name:\s*['"]?([A-Za-z_][\w.]*)/.exec(lines[k]); // - name: x / test_name: unique
      if (named) {
        present.add(named[1]);
      }
    }
    // Plain tests once per column; tests with arguments (relationships, accepted_range…) may repeat.
    const add = tests.filter(t => typeof t !== 'string' || !present.has(t));
    if (!add.length) {
      return undefined;
    }
    insertAt = end + 1;
    out = add.flatMap(t => testLines(t, dash, legacy));
  } else {
    insertAt = blockEnd(lines, c.item, indentOf(lines[c.item])) + 1;
    out = [`${' '.repeat(keyIndent)}data_tests:`, ...tests.flatMap(t => testLines(t, keyIndent + 2, legacy))];
  }
  return { line: insertAt, text: out.join(eol) + eol };
}

/** True for dbt-core before 1.10 (no `arguments:` key for generic tests), or an unknown version: the top-level
 * form works on every 1.x (1.10+ only warns). */
export function legacyTestArguments(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  return !m || (Number(m[1]) === 1 && Number(m[2]) < 10);
}
