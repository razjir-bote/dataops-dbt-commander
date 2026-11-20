import { JinjaCall, parseCall } from './jinja';

// SQL words that can follow a `{{ ref(...) }}` but are not an alias.
const NOT_ALIAS = new Set([
  'on', 'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'lateral', 'using',
  'union', 'group', 'order', 'limit', 'having', 'window', 'qualify', 'except', 'intersect', 'select', 'from', 'with', 'as'
]);

const ALIASED = /\{\{-?\s*(ref|source)\s*\(([^()]*)\)\s*-?\}\}\s+(?:as\s+)?([A-Za-z_]\w*)/gi;

/** Table aliases in a SQL file: `{{ ref('orders') }} o`, `{{ source('raw', 'x') }} as x` (across line breaks). */
export function aliasesIn(text: string): Map<string, JinjaCall> {
  const out = new Map<string, JinjaCall>();
  for (const m of text.matchAll(ALIASED)) {
    const alias = m[3];
    if (NOT_ALIAS.has(alias.toLowerCase())) {
      continue;
    }
    const call = parseCall(m[1].toLowerCase(), m[2]);
    if (call) {
      out.set(alias.toLowerCase(), call); // SQL aliases are case-insensitive: look up lower-cased
    }
  }
  return out;
}

/** The alias right before the cursor in `o.` / `o.na` (the text before the cursor on its line). */
export function aliasBefore(before: string): string | undefined {
  return /(?:^|[^\w.])([A-Za-z_]\w*)\.\w*$/.exec(before)?.[1];
}

/** 0-based lines that `ref()` the model `name` (any quoting, with or without a package). */
export function refLines(text: string, name: string): number[] {
  const lines: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/\bref\s*\(([^()]*)\)/g)) {
      const call = parseCall('ref', m[1]);
      if (call?.kind === 'ref' && call.name === name) {
        lines.push(i);
        break;
      }
    }
  });
  return lines;
}
