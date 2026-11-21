/**
 * SCD2 change-key model from a staging model, in the team's T-SQL template: only extracts the history table hasn't
 * loaded yet, with an `attribute_hash` to detect changes.
 */

export interface Scd2Rules {
  /** Schema (through `generate_schema_name`) of the history table. */
  historySchema: string;
  /** History table name: `<prefix><source>__<entity>__history`. */
  historyPrefix: string;
  /** Where change-key models go (relative to the project). */
  changeKeyFolder: string;
  /** Columns used as `attribute_hash` as they are, the first one the staging model has. */
  hashColumns: string[];
  /** The staging model's extract date, matched against the history's `valid_from`. */
  extractDateColumn: string;
}

export const SCD2_DEFAULTS: Scd2Rules = {
  historySchema: 'int_history',
  historyPrefix: 'dim_',
  changeKeyFolder: 'models/intermediate/changekey',
  hashColumns: ['versionnumber', '_full_row_hash'],
  extractDateColumn: '_landing_extract_date'
};

const bracket = (name: string) => `[${name.replace(/]/g, ']]')}]`;
const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** `stg_<source>__<entity>` → the change-key model and history table names; undefined for a non-staging name. */
export function changeKeyNames(stagingModel: string, rules: Scd2Rules): { model: string; history: string } | undefined {
  const m = /^stg_(.+)$/i.exec(stagingModel);
  return m ? { model: `int_${m[1]}_changekey`, history: `${rules.historyPrefix}${m[1]}__history` } : undefined;
}

/** Columns the staging template adds that aren't data: the key copy and its dedupe row number. */
const NOT_DATA = new Set(['entity_id', 'rn']);

/**
 * The change-key model's SQL for a staging model with these columns (empty = unknown). `usesMacro`: it calls
 * `hash_columns`, which the project then needs.
 */
export function changeKeySql(
  stagingModel: string,
  columns: string[],
  rules: Scd2Rules,
  /** More columns that aren't data (e.g. a custom staging key alias). */
  notData: string[] = []
): { sql: string; usesMacro: boolean } {
  const skip = new Set([...NOT_DATA, ...notData.map(n => n.toLowerCase())]);
  const names = changeKeyNames(stagingModel, rules) ?? { model: `int_${stagingModel}_changekey`, history: `${rules.historyPrefix}${stagingModel}__history` };
  const has = (name: string) => columns.find(c => c.toLowerCase() === name.toLowerCase());
  const direct = rules.hashColumns.map(has).find((c): c is string => !!c);
  const data = columns.filter(c => !c.startsWith('_') && !skip.has(c.toLowerCase()));
  let hash: string;
  let usesMacro = false;
  if (!columns.length) {
    hash = "NULL AS [attribute_hash] -- TODO: the staging model's columns couldn't be read: pick the hash";
  } else if (direct) {
    hash = `${bracket(direct)} AS [attribute_hash]`;
  } else {
    hash = `{{ hash_columns([${data.map(lit).join(', ')}]) }} AS [attribute_hash]`;
    usesMacro = true;
  }
  const sql = [
    '{% set history_relation = adapter.get_relation(',
    '    database=target.database,',
    `    schema=generate_schema_name(${lit(rules.historySchema)}, node),`,
    `    identifier=${lit(names.history)}`,
    ') %}',
    '',
    'WITH source AS (',
    '',
    '    SELECT *',
    `    FROM {{ ref(${lit(stagingModel)}) }}`,
    '',
    '),',
    '',
    'loaded_extracts AS (',
    '',
    '    {% if history_relation %}',
    '',
    '        SELECT DISTINCT valid_from',
    '        FROM {{ history_relation }}',
    '',
    '    {% else %}',
    '',
    '        SELECT CAST(NULL AS DATETIME2) AS valid_from',
    '        WHERE 1 = 0',
    '',
    '    {% endif %}',
    '',
    '),',
    '',
    'new_extracts AS (',
    '',
    '    SELECT s.*',
    '    FROM source s',
    '    LEFT JOIN loaded_extracts l',
    `        ON l.valid_from = s.${bracket(rules.extractDateColumn)}`,
    '    WHERE l.valid_from IS NULL',
    '',
    '),',
    '',
    'hashed AS (',
    '',
    '    SELECT',
    '        *,',
    `        ${hash}`,
    '    FROM new_extracts',
    '',
    ')',
    '',
    'SELECT *',
    'FROM hashed',
    ''
  ];
  return { sql: sql.join('\n'), usesMacro };
}

/** `macros/hash_columns.sql`: a SHA-256 of columns that never passes more than 8000 bytes to HASHBYTES. */
export const HASH_COLUMNS_MACRO = `{#
    hash_columns(columns): a 64-character hex SHA-256 of the given columns (T-SQL / Synapse), safe however many
    or wide the columns are — HASHBYTES never gets more than 8000 bytes:
      1. each column is hashed on its own (NVARCHAR(4000) = at most 8000 bytes); NULL becomes 32 zero bytes,
         so NULL and '' differ and no separator can be confused with data;
      2. the 32-byte column hashes are joined in groups of at most 250 (250 x 32 = 8000 bytes), each group hashed;
      3. with more than one group, the group hashes are joined and hashed once more.
    Column order is part of the hash. Values longer than 4000 characters are hashed on their first 4000.
    Usage: {{ hash_columns(['col_a', 'col_b']) }} AS [attribute_hash]
#}
{% macro hash_columns(columns) -%}
    {%- set column_hashes = [] -%}
    {%- for column in columns -%}
        {%- do column_hashes.append(
            "ISNULL(HASHBYTES('SHA2_256', CAST([" ~ (column | replace(']', ']]')) ~ "] AS NVARCHAR(4000))), CAST(0x00 AS BINARY(32)))"
        ) -%}
    {%- endfor -%}
    {%- set group_hashes = [] -%}
    {%- for start in range(0, column_hashes | length, 250) -%}
        {%- do group_hashes.append("HASHBYTES('SHA2_256', " ~ (column_hashes[start:start + 250] | join(' + ')) ~ ")") -%}
    {%- endfor -%}
    {%- if group_hashes | length == 0 -%}
        CAST(NULL AS VARCHAR(64))
    {%- elif group_hashes | length == 1 -%}
        CONVERT(VARCHAR(64), {{ group_hashes[0] }}, 2)
    {%- else -%}
        CONVERT(VARCHAR(64), HASHBYTES('SHA2_256', {{ group_hashes | join(' + ') }}), 2)
    {%- endif -%}
{%- endmacro %}
`;
