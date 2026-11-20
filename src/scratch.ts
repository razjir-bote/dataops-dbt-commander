/** A common table expression in a model: `name as ( body )`. Offsets index the model text. */
export interface Cte {
  name: string;
  /** Start of the name. */
  start: number;
  /** Just past the closing bracket. */
  end: number;
  bodyStart: number;
  bodyEnd: number;
}

interface Token {
  kind: 'word' | 'quoted' | 'open' | 'close' | 'comma' | 'other';
  text: string;
  start: number;
  end: number;
}

/** How to read strings and comments: standard SQL, or with backslash escapes / `#` comments (BigQuery, MySQL…). */
interface Dialect {
  backslash: boolean;
  hashComments: boolean;
}

/** SQL tokens outside strings, comments and Jinja blocks (which are skipped whole). */
function tokens(sql: string, dialect: Dialect): Token[] {
  const out: Token[] = [];
  let i = 0;
  const skipTo = (close: string, from: number) => {
    const j = sql.indexOf(close, from);
    return j < 0 ? sql.length : j + close.length;
  };
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    const dollar = c === '$' ? /^\$(\w*)\$/.exec(sql.slice(i)) : null;
    if (/\s/.test(c)) {
      i++;
    } else if (two === '--' || (dialect.hashComments && c === '#')) {
      i = skipTo('\n', i);
    } else if (two === '/*') {
      i = skipTo('*/', i + 2);
    } else if (two === '{{') {
      i = skipTo('}}', i + 2);
    } else if (two === '{%') {
      i = skipTo('%}', i + 2);
    } else if (two === '{#') {
      i = skipTo('#}', i + 2);
    } else if (dollar) {
      i = skipTo(dollar[0], i + dollar[0].length); // Postgres / Snowflake dollar-quoted string
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) {
        j += sql[j] === "'" || (dialect.backslash && sql[j] === '\\') ? 2 : 1;
      }
      i = j + 1;
    } else if (c === '"' || c === '`') {
      // (`[ … ]` is an array / list literal in DuckDB, BigQuery, Snowflake: ordinary tokens, not a quoted name.)
      let j = i + 1;
      while (j < sql.length && sql[j] !== c) {
        j += dialect.backslash && sql[j] === '\\' ? 2 : 1;
      }
      j = Math.min(sql.length, j + 1);
      out.push({ kind: 'quoted', text: sql.slice(i, j), start: i, end: j });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w$]*/.exec(sql.slice(i))!;
      out.push({ kind: 'word', text: m[0], start: i, end: i + m[0].length });
      i += m[0].length;
    } else {
      const kind = c === '(' ? 'open' : c === ')' ? 'close' : c === ',' ? 'comma' : 'other';
      out.push({ kind, text: c, start: i, end: i + 1 });
      i++;
    }
  }
  return out;
}

const is = (t: Token | undefined, word: string) => t?.kind === 'word' && t.text.toLowerCase() === word;

const DIALECTS: Dialect[] = [
  { backslash: false, hashComments: false },
  { backslash: true, hashComments: false },
  { backslash: true, hashComments: true }
];

/**
 * The top-level CTEs of a query (the first `with` outside brackets, strings, comments and Jinja). Standard SQL
 * first; if reading backslash escapes / `#` comments finds more CTEs, the model is in such a dialect.
 */
export function ctesIn(sql: string): Cte[] {
  let best: Cte[] = [];
  for (const d of DIALECTS) {
    const found = ctesWith(sql, d);
    if (found.length > best.length) {
      best = found;
    }
  }
  return best;
}

function ctesWith(sql: string, dialect: Dialect): Cte[] {
  const toks = tokens(sql, dialect);
  let depth = 0;
  let i = toks.findIndex(t => {
    depth += t.kind === 'open' ? 1 : t.kind === 'close' ? -1 : 0;
    return depth === 0 && is(t, 'with');
  });
  if (i < 0) {
    return [];
  }
  i++;
  if (is(toks[i], 'recursive')) {
    i++;
  }
  const ctes: Cte[] = [];
  const closeOf = (open: number): number => {
    let d = 0;
    for (let k = open; k < toks.length; k++) {
      d += toks[k].kind === 'open' ? 1 : toks[k].kind === 'close' ? -1 : 0;
      if (d === 0) {
        return k;
      }
    }
    return -1;
  };
  for (;;) {
    const name = toks[i];
    if (!name || (name.kind !== 'word' && name.kind !== 'quoted')) {
      break;
    }
    i++;
    if (toks[i]?.kind === 'open') {
      const c = closeOf(i); // column list: name (a, b) as (…)
      if (c < 0) {
        break;
      }
      i = c + 1;
    }
    if (!is(toks[i], 'as')) {
      break;
    }
    i++;
    if (is(toks[i], 'not')) {
      i++;
    }
    if (is(toks[i], 'materialized')) {
      i++;
    }
    if (toks[i]?.kind !== 'open') {
      break;
    }
    const close = closeOf(i);
    if (close < 0) {
      break;
    }
    ctes.push({ name: name.text, start: name.start, end: toks[close].end, bodyStart: toks[i].end, bodyEnd: toks[close].start });
    i = close + 1;
    if (toks[i]?.kind !== 'comma') {
      break;
    }
    i++;
  }
  return ctes;
}

/**
 * A query selecting from the CTE that contains `offset`, if the offset is in one. Keeps every CTE (unused ones are
 * harmless) so Jinja blocks around them — `{% if %}` … `{% endif %}` — stay balanced.
 */
export function cteQueryAt(sql: string, offset: number): { name: string; sql: string } | undefined {
  const ctes = ctesIn(sql);
  const cte = ctes.find(c => offset >= c.start && offset <= c.end);
  if (!cte) {
    return undefined;
  }
  const last = ctes[ctes.length - 1];
  // Jinja tags right after the last CTE (e.g. its closing {% endif %}) belong to the CTE list.
  const jinja = /^(\s*(\{%[\s\S]*?%\}|\{#[\s\S]*?#\}))*/.exec(sql.slice(last.end))![0];
  return { name: cte.name, sql: `${sql.slice(0, last.end)}${jinja}\nselect * from ${cte.name}` };
}

/** SQL ready for `dbt show --inline`: without `config()` blocks or a trailing semicolon (and comments after it). */
export function inlineSql(sql: string): string {
  return sql
    .replace(/\{\{-?\s*config\s*\([\s\S]*?\)\s*-?\}\}/g, '')
    .trim()
    .replace(/;(\s*(--[^\n]*|\/\*[\s\S]*?\*\/))*\s*$/, '')
    .trim();
}
