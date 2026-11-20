/** Quick-fix edits for model columns in dbt YAML files, made as plain text insertions. */

export type TestSpec = string | { accepted_values: string[] };

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

function columnItem(lines: string[], line: number): { item: number; model: string; column: string } | undefined {
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
  let modelItem = -1;
  for (let k = cols - 1; k >= 0; k--) {
    if (!ignorable(lines[k]) && indentOf(lines[k]) < indentOf(lines[cols])) {
      modelItem = k;
      break;
    }
  }
  const mm = modelItem >= 0 ? NAME_ITEM.exec(lines[modelItem]) : null;
  const models = modelItem >= 0 ? parentKeyLine(lines, modelItem) : -1;
  if (!mm || models < 0 || !/^\s*models:\s*(#.*)?$/.test(lines[models])) {
    return undefined;
  }
  return { item, model: unquote(mm[2]), column: unquote(NAME_ITEM.exec(lines[item])![2]) };
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
  if (!c) {
    return undefined;
  }
  return { model: c.model, column: c.column, testsKey: testsKeyLine(lines, c.item)?.key };
}

const testName = (t: TestSpec) => (typeof t === 'string' ? t : 'accepted_values');

function testLines(t: TestSpec, dash: number, legacy: boolean): string[] {
  const sp = (n: number) => ' '.repeat(n);
  if (typeof t === 'string') {
    return [`${sp(dash)}- ${t}`];
  }
  const values = `values: [${t.accepted_values.map(v => JSON.stringify(v)).join(', ')}]`;
  // dbt 1.10+ wants test arguments under `arguments:` (and warns otherwise); older versions don't know the key.
  return legacy
    ? [`${sp(dash)}- accepted_values:`, `${sp(dash + 4)}${values}`]
    : [`${sp(dash)}- accepted_values:`, `${sp(dash + 4)}arguments:`, `${sp(dash + 6)}${values}`];
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
  if (!c) {
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
    const add = tests.filter(t => !present.has(testName(t)));
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
