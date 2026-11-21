/**
 * Staging model from a bronze source in the team's Synapse (T-SQL) pattern: every column trimmed, blank → NULL and
 * typed (DATETIME2 / DATE by name, else NVARCHAR(4000)), the key copied to `entity_id`, the newest load kept per
 * entity and extract date, deleted rows dropped.
 */

export interface BronzeRules {
  /** Column names typed DATETIME2 (regex, case-sensitive). */
  datetimePattern: string;
  /** Column names typed DATE (regex, case-sensitive). */
  datePattern: string;
  /** The key column (matched case-insensitively); it is kept and also copied to `keyAlias`. */
  keyColumn: string;
  keyAlias: string;
  /** Dedupe partition columns before the key (or before the data columns when there is no key). */
  partitionColumns: string[];
  /** Newest load first. */
  orderColumns: string[];
  /** Rows are kept when LOWER(this column) is one of `deleteKeepValues`. */
  deleteColumn: string;
  deleteKeepValues: string[];
}

export const BRONZE_DEFAULTS: BronzeRules = {
  datetimePattern: '(On|_ts|_at|_datetime)$',
  datePattern: '_date$',
  keyColumn: 'Id',
  keyAlias: 'entity_id',
  partitionColumns: ['_landing_extract_date'],
  orderColumns: ['_bronze_loaded_at_utc_ts', '_bronze_run_id'],
  deleteColumn: 'IsDelete',
  deleteKeepValues: ['false', '0']
};

const bracket = (name: string) => `[${name.replace(/]/g, ']]')}]`;
const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

function safeRegex(pattern: string): RegExp | undefined {
  try {
    return pattern ? new RegExp(pattern) : undefined;
  } catch {
    return undefined; // a broken pattern in settings: that rule just doesn't apply
  }
}

type Staged = 'DATETIME2' | 'DATE' | 'TEXT';

/**
 * The type a column is staged as — by name first, else by the warehouse type when it's already a date / datetime —
 * and whether the warehouse already stores it as a date / time (then it's cast directly: a text round trip of a
 * DATETIME would drop its seconds).
 */
function stagedType(name: string, dataType: string | undefined, rules: BronzeRules): { type: Staged; native: boolean } {
  const t = (dataType ?? '').toLowerCase();
  const nativeDate = /^date$/.test(t);
  const nativeTime = /datetime|timestamp/.test(t);
  const native = nativeDate || nativeTime;
  if (safeRegex(rules.datetimePattern)?.test(name)) {
    return { type: 'DATETIME2', native };
  }
  if (safeRegex(rules.datePattern)?.test(name)) {
    return { type: 'DATE', native };
  }
  return nativeDate ? { type: 'DATE', native } : nativeTime ? { type: 'DATETIME2', native } : { type: 'TEXT', native: false };
}

function expression(column: string, as: string, type: Staged, native = false): string {
  if (type === 'TEXT') {
    return `NULLIF(LTRIM(RTRIM(CAST(${bracket(column)} AS NVARCHAR(4000)))), '') AS ${bracket(as)}`;
  }
  return native
    ? `TRY_CAST(${bracket(column)} AS ${type}) AS ${bracket(as)}`
    : `TRY_CAST(NULLIF(LTRIM(RTRIM(TRY_CAST(${bracket(column)} AS VARCHAR(4000)))), '') AS ${type}) AS ${bracket(as)}`;
}

const YAML_TYPE: Record<Staged, string> = { DATETIME2: 'datetime2', DATE: 'date', TEXT: 'nvarchar(4000)' };

/** The staging model's SQL, and its output columns with staged types (for the YAML entry). */
export function bronzeStaging(
  source: string,
  table: string,
  columns: { name: string; dataType?: string }[],
  rules: BronzeRules
): { sql: string; columns: { name: string; dataType: string }[] } {
  const sourceCte = ['WITH source AS (', '', '    SELECT *', `    FROM {{ source(${lit(source)}, ${lit(table)}) }}`, '', ')'];
  if (!columns.length) {
    const todo = ['', '-- TODO: list the columns (they could not be read from the warehouse)', 'SELECT *', 'FROM source', ''];
    return { sql: [...sourceCte, ...todo].join('\n'), columns: [] };
  }
  const header = [...sourceCte.slice(0, -1), '),', ''];
  const has = (name: string) => columns.find(c => c.name.toLowerCase() === name.toLowerCase())?.name;
  const key = rules.keyColumn ? has(rules.keyColumn) : undefined;

  const out: { name: string; dataType: string }[] = [];
  const selects: string[] = [];
  if (key) {
    selects.push(expression(key, rules.keyAlias, 'TEXT'));
    out.push({ name: rules.keyAlias, dataType: YAML_TYPE.TEXT });
  }
  for (const c of columns) {
    if (key && c.name.toLowerCase() === rules.keyAlias.toLowerCase()) {
      continue; // the table already has a column named like the key copy: the copy replaces it
    }
    const { type, native } = stagedType(c.name, c.dataType, rules);
    selects.push(expression(c.name, c.name, type, native));
    out.push({ name: c.name, dataType: YAML_TYPE[type] });
  }

  // Dedupe: per partition columns + the key; without a key, per partition columns + every non-metadata column
  // (metadata columns start with `_` and differ between loads of the same rows).
  const partitionLead = rules.partitionColumns.map(has).filter((c): c is string => !!c);
  const partitionRest = key ? [rules.keyAlias] : columns.map(c => c.name).filter(n => !n.startsWith('_') && !partitionLead.includes(n));
  const partition = partitionRest.length ? [...partitionLead, ...partitionRest] : [];
  const order = rules.orderColumns.map(has).filter((c): c is string => !!c);
  const del = rules.deleteColumn ? has(rules.deleteColumn) : undefined;
  const deleteFilter = del && rules.deleteKeepValues.length ? `LOWER(${bracket(del)}) IN (${rules.deleteKeepValues.map(sqlString).join(', ')})` : undefined;

  const renamed = ['renamed AS (', '', '    SELECT', selects.map(s => `        ${s}`).join(',\n\n'), '', '    FROM source', '', ')'];
  const list = (items: string[]) => items.map((x, i) => `                ${x}${i < items.length - 1 ? ',' : ''}`);
  const sql = partition.length
    ? [
        ...header,
        ...renamed.slice(0, -1),
        '),',
        '',
        'deduplicated AS (',
        '',
        '    SELECT',
        '        *,',
        '        ROW_NUMBER() OVER (',
        '            PARTITION BY',
        ...list(partition.map(bracket)),
        '            ORDER BY',
        ...list(order.length ? order.map(c => `${bracket(c)} DESC`) : ['(SELECT NULL)']),
        '        ) AS rn',
        '    FROM renamed',
        '',
        ')',
        '',
        'SELECT *',
        'FROM deduplicated',
        'WHERE rn = 1',
        ...(deleteFilter ? [`    AND ${deleteFilter}`] : []),
        ''
      ]
    : [...header, ...renamed, '', 'SELECT *', 'FROM renamed', ...(deleteFilter ? [`WHERE ${deleteFilter}`] : []), ''];
  return { sql: sql.join('\n'), columns: out };
}
