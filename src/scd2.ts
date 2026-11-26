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
  /** Where the candidate / history / published models go (relative to the project). */
  generatedFolder: string;
  /** Where the gates test goes (a singular test, so under the project's test paths). */
  testsFolder: string;
  /** The vars file (relative to the project) whose `scd2_dimensions:` list gets each dimension. */
  varsFile: string;
}

export const SCD2_DEFAULTS: Scd2Rules = {
  historySchema: 'int_history',
  historyPrefix: 'dim_',
  changeKeyFolder: 'models/intermediate/changekey',
  hashColumns: ['versionnumber', '_full_row_hash'],
  extractDateColumn: '_landing_extract_date',
  generatedFolder: 'models/intermediate/scd2/generated',
  testsFolder: 'tests/scd2/generated',
  varsFile: 'vars.yaml'
};

const bracket = (name: string) => `[${name.replace(/]/g, ']]')}]`;
const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * `stg_<source>__<entity>` → the change-key model (`int_<source>__<entity>__changekey`), the dimension
 * (`dim_<source>__<entity>`) and its history table; undefined for a non-staging name.
 */
export function changeKeyNames(stagingModel: string, rules: Scd2Rules): { model: string; dim: string; history: string } | undefined {
  const m = /^stg_(.+)$/i.exec(stagingModel);
  return m ? { model: `int_${m[1]}__changekey`, dim: `${rules.historyPrefix}${m[1]}`, history: `${rules.historyPrefix}${m[1]}__history` } : undefined;
}

/** The SCD2 files after the change-key model, each a call to one of the project's macros. `test`: a singular test. */
const SCD2_STAGES: { suffix: string; macro: string; test?: boolean }[] = [
  { suffix: 'candidate', macro: 'scd2_candidate' },
  { suffix: 'history', macro: 'scd2_history' },
  { suffix: 'published', macro: 'scd2_published' },
  { suffix: 'gates', macro: 'scd2_gate_test', test: true }
];

/**
 * For a staging model: `dim_<source>__<entity>__candidate` / `__history` / `__published` (models) and `__gates` (a
 * singular test), each one line calling the project's `scd2_candidate` / `scd2_history` / `scd2_published` /
 * `scd2_gate_test` macro with `dim_<source>__<entity>`.
 */
export function scd2GeneratedModels(stagingModel: string, rules: Scd2Rules): { name: string; macro: string; sql: string; test?: boolean }[] {
  const m = /^stg_(.+)$/i.exec(stagingModel);
  if (!m) {
    return [];
  }
  const dim = `${rules.historyPrefix}${m[1]}`;
  return SCD2_STAGES.map(s => ({ name: `${dim}__${s.suffix}`, macro: s.macro, sql: `{{ ${s.macro}(${lit(dim)}) }}\n`, ...(s.test ? { test: true } : {}) }));
}

/**
 * The SCD2 chain fed by a staging model, in build order: the staging model, its change-key model, the
 * candidate / history / published models and the gates test. Each piece may be spelled with `__` or `_` before
 * its suffix (`int_ace__x__changekey` or `int_ace__x_changekey`): `known` gives a node's actual name if the project
 * has it; a piece it doesn't know gets both spellings (dbt skips the one that doesn't exist). Empty for a
 * non-staging name.
 */
export function scd2ChainNames(stagingModel: string, rules: Scd2Rules, known: (name: string) => string | undefined = () => undefined): string[] {
  const m = /^stg_(.+)$/i.exec(stagingModel);
  if (!m) {
    return [];
  }
  const pieces: [base: string, suffix: string][] = [
    [`int_${m[1]}`, 'changekey'],
    ...SCD2_STAGES.map((st): [string, string] => [`${rules.historyPrefix}${m[1]}`, st.suffix])
  ];
  const names = [stagingModel];
  for (const [base, suffix] of pieces) {
    const spellings = [`${base}__${suffix}`, `${base}_${suffix}`];
    const found = spellings.map(known).filter((n): n is string => !!n);
    names.push(...(found.length ? found : spellings));
  }
  return [...new Set(names)];
}

// ---------- the scd2_dimensions entry in vars.yaml ----------

export interface Scd2Dimension {
  name: string;
  source: string;
  naturalKey: string;
  changeDateColumn: string;
}

/** The dimension `name`, fed by the change-key model `source`, keyed on `naturalKey`. */
export function scd2Dimension(name: string, source: string, naturalKey: string, rules: Scd2Rules): Scd2Dimension {
  return { name, source, naturalKey, changeDateColumn: rules.extractDateColumn };
}

/** The team's `scd2_dimensions` entry, as lines starting at column 0 (`- name: …` then its keys). */
export function scd2DimensionLines(d: Scd2Dimension): string[] {
  const v = yamlScalar;
  return [
    `- name: ${v(d.name)}`,
    `  source: ${v(d.source)}`,
    `  natural_key: [${v(d.naturalKey)}]`,
    `  change_date_column: ${v(d.changeDateColumn)}`,
    '  hash_column: attribute_hash',
    '  load_mode: delta',
    '  dedupe_order_by: attribute_hash',
    `  baseline_source: ${v(d.source)}`,
    '  source_cadence_days: 1',
    '  source_lag_grace_days: 500',
    '  # max_rows_per_batch: 50000',
    '  # allow_full_refresh: false'
  ];
}

/** A plain YAML scalar as is; anything else (spaces, `:`, `#`, quotes …) single-quoted. */
const yamlScalar = (s: string) => (/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const indentOf = (line: string) => /^ */.exec(line)![0].length;

export type Scd2DimensionResult =
  | { status: 'added'; text: string }
  | { status: 'exists'; text: string }
  /** Left alone: the section isn't a block list this can append to as text. */
  | { status: 'unsupported'; text: string; reason: string };

/**
 * Add the dimension to the `scd2_dimensions:` list of a vars file's text, as text: the entry goes after the
 * list's last line, at its items' indentation; nothing else changes. No section: one is appended. An entry with
 * that name already in the list: `exists`, text unchanged. A section that isn't an (empty or) block list — a flow
 * list, an anchor, a second `scd2_dimensions` key, tab indentation: `unsupported`, text unchanged.
 */
export function addScd2Dimension(text: string, d: Scd2Dimension): Scd2DimensionResult {
  const bom = text.charCodeAt(0) === 0xfeff ? text[0] : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.slice(bom.length).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const done = (out: string[]) => ({ text: bom + out.join(eol) + eol, status: 'added' as const });
  const unsupported = (reason: string) => ({ text, status: 'unsupported' as const, reason });
  const entry = scd2DimensionLines(d);
  const keyRe = /^ *(['"]?)scd2_dimensions\1 *:(?: +(.*?))? *$/;
  const keys = lines.map((l, i) => (keyRe.test(l) ? i : -1)).filter(i => i >= 0);
  if (!keys.length) {
    return done([...lines, ...(lines.some(l => l.trim()) ? [''] : []), 'scd2_dimensions:', ...entry.map(l => '  ' + l)]);
  }
  if (keys.length > 1) {
    return unsupported('scd2_dimensions appears more than once');
  }
  const at = keys[0];
  const value = (keyRe.exec(lines[at])![2] ?? '').replace(/(^| )#.*$/, '').trim();
  if (value && !/^(\[ *\]|null|~)$/i.test(value)) {
    return unsupported(`scd2_dimensions is written as \`${value}\`, not a block list`);
  }
  const keyIndent = indentOf(lines[at]);
  // The section: until a line that's back at (or left of) the key, other than a list item at the key's indent.
  let end = at + 1;
  let last = at; // the last line that belongs to the list
  let itemIndent: number | undefined;
  let blankBetweenItems = false;
  let itemKeyIndent = -1; // where the current item's own keys start (`- name:` → after the dash)
  let exists = false;
  const nameRe = new RegExp(`^(['"]?)name\\1 *: *(['"]?)${escapeRe(d.name)}\\2 *(#.*)?$`);
  for (; end < lines.length; end++) {
    const l = lines[end];
    if (!l.trim()) {
      continue;
    }
    if (/^ *\t/.test(l)) {
      return unsupported('the scd2_dimensions list is indented with tabs');
    }
    const n = indentOf(l);
    const dash = /^ *- +/.exec(l);
    const item = !!dash || /^ *-$/.test(l);
    if (n < keyIndent || (n === keyIndent && !item)) {
      if (l.trim().startsWith('#')) {
        continue; // a comment at the key's level: may be the next key's, never the list's
      }
      break;
    }
    if (itemIndent === undefined && !item && !l.trim().startsWith('#')) {
      return unsupported('scd2_dimensions holds something other than a block list');
    }
    // An entry of that name: `name:` as one of an item's own keys (not a nested mapping's).
    if (item && (itemIndent === undefined || n === itemIndent)) {
      itemKeyIndent = dash ? dash[0].length : -1;
      exists ||= nameRe.test(l.slice(dash ? dash[0].length : n));
    } else if (n === itemKeyIndent) {
      exists ||= nameRe.test(l.slice(n));
    }
    if (item && itemIndent === undefined) {
      itemIndent = n;
    } else if (item && n === itemIndent && !lines[end - 1].trim()) {
      blankBetweenItems = true;
    }
    last = end;
  }
  if (exists) {
    return { text, status: 'exists' };
  }
  const pad = ' '.repeat(itemIndent ?? keyIndent + 2);
  const head = lines[at].replace(/^( *(['"]?)scd2_dimensions\2 *:) *(\[ *\]|null|~)/i, '$1');
  return done([
    ...lines.slice(0, at),
    head,
    ...lines.slice(at + 1, last + 1),
    ...(blankBetweenItems ? [''] : []),
    ...entry.map(l => pad + l),
    ...lines.slice(last + 1)
  ]);
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
  const names = changeKeyNames(stagingModel, rules) ?? { model: `int_${stagingModel}__changekey`, dim: `${rules.historyPrefix}${stagingModel}`, history: `${rules.historyPrefix}${stagingModel}__history` };
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
