import { columnRef } from './scaffold';

/** What a YAML column belongs to. */
export interface ColumnOwner {
  kind: 'model' | 'seed' | 'snapshot' | 'source';
  name: string;
  /** Sources: the source the table is in (`name` is the table). */
  source?: string;
  /** Versioned models: the version previewed. */
  version?: number | string;
}

const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** `{{ ref('x') }}` / `{{ ref('x', v=2) }}` / `{{ source('s', 't') }}` for the relation a column lives in. */
export function relationSql(owner: ColumnOwner): string {
  if (owner.kind === 'source') {
    return `{{ source(${lit(owner.source ?? '')}, ${lit(owner.name)}) }}`;
  }
  const v = owner.version === undefined ? '' : `, v=${typeof owner.version === 'number' ? owner.version : lit(String(owner.version))}`;
  return `{{ ref(${lit(owner.name)}${v}) }}`;
}

const SAFE = (s: string) => `{{ adapter.quote(${lit(s)}) }}`;

/**
 * A column named in YAML, as dbt treats it: bare unless `quote: true` or it isn't a plain identifier — so
 * `CustomerId` still matches Snowflake's upper-cased CUSTOMERID. (Names the warehouse returned use `columnRef`.)
 */
export function yamlColumnSql(name: string, quote = false): string {
  return !quote && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : SAFE(name);
}

/**
 * One query profiling a column: row count, nulls, distinct values, min, max (unless `minMax: false`, for types the
 * warehouse can't compare) and the 10 most common values, as `ord | stat | value | n` rows. `column` is SQL
 * (from `columnRef` / `yamlColumnSql`) or a plain name, which goes through `columnRef`.
 */
export function profileSql(relation: string, column: string, opts: { minMax?: boolean; columnIsSql?: boolean } = {}): string {
  const str = '{{ dbt.type_string() }}';
  const big = '{{ dbt.type_bigint() }}';
  const col = opts.columnIsSql ? column : columnRef(column);
  const stat = (ord: number, name: string, expr: string) => `select ${ord} as ord, '${name}' as stat, cast(${expr} as ${str}) as value, cast(null as ${big}) as n from base`;
  const minMax = opts.minMax === false ? [] : [`  union all ${stat(4, 'min', 'min(v)')}`, `  union all ${stat(5, 'max', 'max(v)')}`];
  return [
    `with base as (select ${col} as v from ${relation}),`,
    'top_values as (select v, count(*) as n from base group by v order by n desc limit 10),',
    'profile as (',
    `  ${stat(1, 'rows', 'count(*)')}`,
    `  union all ${stat(2, 'nulls', 'count(*) - count(v)')}`,
    `  union all ${stat(3, 'distinct', 'count(distinct v)')}`,
    ...minMax,
    `  union all select 6 as ord, 'top value' as stat, cast(v as ${str}) as value, n from top_values`,
    ')',
    'select ord, stat, value, n from profile order by ord, n desc'
  ].join('\n');
}

/** A dbt error that came from min() / max() on a type the warehouse can't compare. */
export function isMinMaxError(error: string | undefined): boolean {
  return !!error && /\b(min|max)\s*\(/i.test(error);
}

/**
 * Display rows (`statistic | value | count`) from the profile query's result, whatever case the keys came back in
 * and whatever order (`dbt show` may wrap the query in a subquery that drops its `order by`).
 */
export function profileRows(raw: Record<string, unknown>[]): { statistic: string; value: unknown; count: unknown }[] {
  const lower = raw
    .map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])))
    .sort((a, b) => Number(a.ord) - Number(b.ord) || Number(b.n ?? 0) - Number(a.n ?? 0));
  const rows = Number(lower.find(r => r.stat === 'rows')?.value);
  let top = 0;
  return lower.map(r => {
    if (r.stat === 'top value') {
      return { statistic: `top value ${++top}`, value: r.value ?? null, count: r.n ?? null };
    }
    let value = r.value ?? null;
    if (r.stat === 'nulls' && rows > 0) {
      const pct = (Number(r.value) / rows) * 100;
      value = `${r.value} (${Number.isInteger(pct) ? pct : pct.toFixed(1)}%)`;
    }
    return { statistic: String(r.stat), value, count: null };
  });
}
