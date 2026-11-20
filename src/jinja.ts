export type JinjaCall =
  | { kind: 'ref'; name: string; package?: string; version?: string }
  | { kind: 'source'; source: string; table: string };

const CALL = /\b(ref|source)\s*\(([^()]*)\)/g;

function unquote(s: string): string | undefined {
  const m = /^\s*(['"])(.*)\1\s*$/.exec(s);
  return m ? m[2] : undefined;
}

/** Split call arguments on commas outside quotes. */
function splitCallArgs(args: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  for (const ch of args) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      }
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) {
    out.push(cur);
  }
  return out;
}

export function parseCall(fn: string, rawArgs: string): JinjaCall | undefined {
  const positional: string[] = [];
  let version: string | undefined;
  for (const arg of splitCallArgs(rawArgs)) {
    const kw = /^\s*(v|version)\s*=\s*(.+?)\s*$/.exec(arg);
    if (kw) {
      version = unquote(kw[2]) ?? kw[2];
      continue;
    }
    const v = unquote(arg);
    if (v === undefined) {
      return undefined;
    }
    positional.push(v);
  }
  if (fn === 'source') {
    return positional.length === 2 ? { kind: 'source', source: positional[0], table: positional[1] } : undefined;
  }
  if (positional.length === 1) {
    return { kind: 'ref', name: positional[0], ...(version ? { version } : {}) };
  }
  if (positional.length === 2) {
    return { kind: 'ref', name: positional[1], package: positional[0], ...(version ? { version } : {}) };
  }
  return undefined;
}

// Jinja / dbt built-ins that look like calls but are not macros you can open.
const NOT_MACROS = new Set([
  'ref', 'source', 'config', 'var', 'env_var', 'is_incremental', 'return', 'log', 'print', 'range', 'len',
  'this', 'adapter', 'caller', 'loop', 'modules', 'api', 'exceptions', 'super', 'dict', 'list', 'zip',
  'set', 'if', 'for', 'macro', 'call', 'filter', 'tojson', 'fromjson', 'toyaml', 'fromyaml', 'local_md5', 'run_started_at'
]);
const MACRO_CALL = /\b([A-Za-z_]\w*)(?:\s*\.\s*([A-Za-z_]\w*))?\s*\(/g;

/** The macro call (`name(` or `package.name(`) whose name spans column `col`, if any. */
export function macroCallAt(line: string, col: number): { package?: string; name: string } | undefined {
  // Only inside Jinja ({{ }} or {% %}, possibly continuing past the end of the line):
  // `concat(` or `current_timestamp()` in plain SQL are database functions, not dbt macros.
  const inJinja = [...line.matchAll(/\{\{[\s\S]*?(?:\}\}|$)|\{%[\s\S]*?(?:%\}|$)/g)].some(
    s => col >= (s.index ?? 0) && col < (s.index ?? 0) + s[0].length
  );
  if (!inJinja) {
    return undefined;
  }
  for (const m of line.matchAll(MACRO_CALL)) {
    const start = m.index ?? 0;
    const nameEnd = start + m[0].lastIndexOf('(');
    if (col < start || col >= nameEnd) {
      continue;
    }
    const [first, second] = [m[1], m[2]];
    const name = second ?? first;
    const pkg = second ? first : undefined;
    if (NOT_MACROS.has(first) || NOT_MACROS.has(name)) {
      return undefined;
    }
    return pkg ? { package: pkg, name } : { name };
  }
  return undefined;
}

/** The ref()/source() call whose text spans column `col` of `line`, if any. */
export function callAt(line: string, col: number): JinjaCall | undefined {
  for (const m of line.matchAll(CALL)) {
    const start = m.index ?? 0;
    if (col >= start && col < start + m[0].length) {
      return parseCall(m[1], m[2]);
    }
  }
  return undefined;
}

const Q = `['"]`;
const NAME = `[\\w.-]*`;
const SOURCE_TABLE = new RegExp(`\\bsource\\s*\\(\\s*(${Q})(${NAME})\\1\\s*,\\s*${Q}${NAME}$`);
const SOURCE_NAME = new RegExp(`\\bsource\\s*\\(\\s*${Q}${NAME}$`);
const REF = new RegExp(`\\bref\\s*\\(\\s*(?:${Q}${NAME}${Q}\\s*,\\s*)?${Q}${NAME}$`);

/** What to complete given the text before the cursor on the current line. */
export function completionContext(
  before: string
): { kind: 'ref' } | { kind: 'sourceName' } | { kind: 'sourceTable'; source: string } | undefined {
  const st = SOURCE_TABLE.exec(before);
  if (st) {
    return { kind: 'sourceTable', source: st[2] };
  }
  if (SOURCE_NAME.test(before)) {
    return { kind: 'sourceName' };
  }
  if (REF.test(before)) {
    return { kind: 'ref' };
  }
  return undefined;
}
