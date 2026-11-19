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

function parseCall(fn: string, rawArgs: string): JinjaCall | undefined {
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
