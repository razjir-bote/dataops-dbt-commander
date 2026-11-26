import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HASH_COLUMNS_MACRO, SCD2_DEFAULTS, addScd2Dimension, changeKeyNames, changeKeySql, scd2Dimension, scd2ChainNames, scd2DimensionLines, scd2GeneratedModels } from '../scd2';

test('changeKeyNames from the staging model name', () => {
  assert.deepEqual(changeKeyNames('stg_ace__aus_accounttag', SCD2_DEFAULTS), {
    model: 'int_ace__aus_accounttag__changekey',
    dim: 'dim_ace__aus_accounttag',
    history: 'dim_ace__aus_accounttag__history'
  });
  assert.deepEqual(changeKeyNames('stg_a', SCD2_DEFAULTS), { model: 'int_a__changekey', dim: 'dim_a', history: 'dim_a__history' });
  assert.equal(changeKeyNames('orders', SCD2_DEFAULTS), undefined, 'not a staging model');
});

test('changeKeySql reproduces the team template (versionnumber as the hash)', () => {
  const { sql, usesMacro } = changeKeySql('stg_ace__aus_accounttag', ['entity_id', 'Id', 'versionnumber', '_full_row_hash', '_landing_extract_date'], SCD2_DEFAULTS);
  assert.equal(usesMacro, false);
  assert.equal(
    sql,
    [
      '{% set history_relation = adapter.get_relation(',
      '    database=target.database,',
      "    schema=generate_schema_name('int_history', node),",
      "    identifier='dim_ace__aus_accounttag__history'",
      ') %}',
      '',
      'WITH source AS (',
      '',
      '    SELECT *',
      "    FROM {{ ref('stg_ace__aus_accounttag') }}",
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
      '        ON l.valid_from = s.[_landing_extract_date]',
      '    WHERE l.valid_from IS NULL',
      '',
      '),',
      '',
      'hashed AS (',
      '',
      '    SELECT',
      '        *,',
      '        [versionnumber] AS [attribute_hash]',
      '    FROM new_extracts',
      '',
      ')',
      '',
      'SELECT *',
      'FROM hashed',
      ''
    ].join('\n')
  );
});

test('no versionnumber: _full_row_hash; neither: the hash_columns macro over the data columns', () => {
  assert.match(changeKeySql('stg_a__b', ['entity_id', 'name', '_full_row_hash'], SCD2_DEFAULTS).sql, /\[_full_row_hash\] AS \[attribute_hash\]/);
  const viaMacro = changeKeySql('stg_a__b', ['entity_id', 'Id', 'Name', 'rn', '_bronze_run_id', 'IsDelete'], SCD2_DEFAULTS);
  assert.equal(viaMacro.usesMacro, true);
  assert.match(viaMacro.sql, /\{\{ hash_columns\(\['Id', 'Name', 'IsDelete'\]\) \}\} AS \[attribute_hash\]/);
  // Matched case-insensitively, written as the column is spelled.
  assert.match(changeKeySql('stg_a__b', ['VersionNumber'], SCD2_DEFAULTS).sql, /\[VersionNumber\] AS \[attribute_hash\]/);
});

test('no columns known: a TODO in place of the hash', () => {
  const { sql, usesMacro } = changeKeySql('stg_a__b', [], SCD2_DEFAULTS);
  assert.equal(usesMacro, false);
  assert.match(sql, /NULL AS \[attribute_hash\] -- TODO: the staging model's columns couldn't be read/);
});

test('hash_columns macro: per-column hashes, groups of 250, a final hash; never more than 8000 bytes per HASHBYTES', () => {
  assert.match(HASH_COLUMNS_MACRO, /\{% macro hash_columns\(columns\) -%\}/);
  assert.match(HASH_COLUMNS_MACRO, /HASHBYTES\('SHA2_256', CAST\(/);
  assert.match(HASH_COLUMNS_MACRO, /CAST\(0x00 AS BINARY\(32\)\)/);
  assert.match(HASH_COLUMNS_MACRO, /range\(0, column_hashes \| length, 250\)/);
  assert.match(HASH_COLUMNS_MACRO, /\{%- endmacro %\}/);
});

test('changeKeySql: extra non-data columns (the staging key alias setting) are left out of the hash', () => {
  const { sql } = changeKeySql('stg_a__b', ['row_key', 'Name'], SCD2_DEFAULTS, ['row_key']);
  assert.match(sql, /hash_columns\(\['Name'\]\)/);
});

test('scd2GeneratedModels: candidate / history / published / gates models calling the SCD2 macros', () => {
  assert.deepEqual(scd2GeneratedModels('stg_ace__aus_accounttag', SCD2_DEFAULTS), [
    { name: 'dim_ace__aus_accounttag__candidate', macro: 'scd2_candidate', sql: "{{ scd2_candidate('dim_ace__aus_accounttag') }}\n" },
    { name: 'dim_ace__aus_accounttag__history', macro: 'scd2_history', sql: "{{ scd2_history('dim_ace__aus_accounttag') }}\n" },
    { name: 'dim_ace__aus_accounttag__published', macro: 'scd2_published', sql: "{{ scd2_published('dim_ace__aus_accounttag') }}\n" },
    { name: 'dim_ace__aus_accounttag__gates', macro: 'scd2_gate_test', sql: "{{ scd2_gate_test('dim_ace__aus_accounttag') }}\n", test: true }
  ]);
  assert.equal(SCD2_DEFAULTS.generatedFolder, 'models/intermediate/scd2/generated');
  assert.equal(SCD2_DEFAULTS.testsFolder, 'tests/scd2/generated', 'the gates test is a singular test, under tests/');
  assert.deepEqual(scd2GeneratedModels('orders', SCD2_DEFAULTS), [], 'not a staging model');
  // The history model is the table the change-key model checks.
  assert.equal(scd2GeneratedModels('stg_a__b', SCD2_DEFAULTS)[1].name, changeKeyNames('stg_a__b', SCD2_DEFAULTS)!.history);
});

// ---------- scd2_dimensions entry in vars.yaml ----------

const ENTRY = [
  '- name: dim_ace__msdynmkt_segment',
  '  source: int_ace__msdynmkt_segment__changekey',
  '  natural_key: [entity_id]',
  '  change_date_column: _landing_extract_date',
  '  hash_column: attribute_hash',
  '  load_mode: delta',
  '  dedupe_order_by: attribute_hash',
  '  baseline_source: int_ace__msdynmkt_segment__changekey',
  '  source_cadence_days: 1',
  '  source_lag_grace_days: 500',
  '  # max_rows_per_batch: 50000',
  '  # allow_full_refresh: false'
];
const indent = (lines: string[], n: number) => lines.map(l => ' '.repeat(n) + l);
const dim = (dimName = 'dim_ace__msdynmkt_segment', source = 'int_ace__msdynmkt_segment__changekey') =>
  scd2Dimension(dimName, source, 'entity_id', SCD2_DEFAULTS);

test('changeKeyNames: the change-key model is int_<source>__<entity>__changekey', () => {
  assert.equal(changeKeyNames('stg_ace__msdynmkt_segment', SCD2_DEFAULTS)!.model, 'int_ace__msdynmkt_segment__changekey');
  assert.equal(changeKeyNames('stg_ace__msdynmkt_segment', SCD2_DEFAULTS)!.dim, 'dim_ace__msdynmkt_segment');
});

test('scd2Dimension: the team entry, as lines', () => {
  assert.deepEqual(scd2DimensionLines(dim()), ENTRY);
  const other = scd2DimensionLines(scd2Dimension('dim_x', 'int_x__changekey', 'row_key', { ...SCD2_DEFAULTS, extractDateColumn: '_extract_dt' }));
  assert.equal(other[2], '  natural_key: [row_key]');
  assert.equal(other[3], '  change_date_column: _extract_dt');
});

test('addScd2Dimension: empty / missing file → a scd2_dimensions section', () => {
  assert.deepEqual(addScd2Dimension('', dim()), { text: ['scd2_dimensions:', ...indent(ENTRY, 2), ''].join('\n'), status: 'added' });
  // A file without the section: appended at the end, the rest untouched.
  const text = 'other_var: 1  # keep\n';
  assert.equal(addScd2Dimension(text, dim()).text, ['other_var: 1  # keep', '', 'scd2_dimensions:', ...indent(ENTRY, 2), ''].join('\n'));
  // No final newline.
  assert.equal(addScd2Dimension('a: 1', dim()).text, ['a: 1', '', 'scd2_dimensions:', ...indent(ENTRY, 2), ''].join('\n'));
});

test('addScd2Dimension: appended to the existing list, at its indentation, before the next key', () => {
  const text = [
    '# vars',
    'scd2_dimensions:',
    '    - name: dim_a',
    '      source: int_a__changekey',
    '      # max_rows_per_batch: 1',
    'next_var: 2',
    ''
  ].join('\n');
  assert.equal(
    addScd2Dimension(text, dim()).text,
    ['# vars', 'scd2_dimensions:', '    - name: dim_a', '      source: int_a__changekey', '      # max_rows_per_batch: 1', ...indent(ENTRY, 4), 'next_var: 2', ''].join('\n')
  );
  // A list at the key's own indentation, a nested section, blank lines between entries kept as the style.
  const nested = ['vars:', '  scd2_dimensions:', '  - name: dim_a', '    source: s', '', '  - name: dim_b', '    source: s', '', '# trailing comment', ''].join('\n');
  assert.equal(
    addScd2Dimension(nested, dim()).text,
    ['vars:', '  scd2_dimensions:', '  - name: dim_a', '    source: s', '', '  - name: dim_b', '    source: s', '', ...indent(ENTRY, 2), '', '# trailing comment', ''].join('\n')
  );
});

test('addScd2Dimension: an empty section, `[]`, CRLF', () => {
  assert.equal(addScd2Dimension('scd2_dimensions:\nb: 1\n', dim()).text, ['scd2_dimensions:', ...indent(ENTRY, 2), 'b: 1', ''].join('\n'));
  assert.equal(addScd2Dimension('scd2_dimensions: []  # none yet\n', dim()).text, ['scd2_dimensions:  # none yet', ...indent(ENTRY, 2), ''].join('\n'));
  const crlf = addScd2Dimension('a: 1\r\nscd2_dimensions:\r\n  - name: dim_a\r\n', dim()).text;
  assert.equal(crlf, ['a: 1', 'scd2_dimensions:', '  - name: dim_a', ...indent(ENTRY, 2), ''].join('\r\n'));
});

test('addScd2Dimension: an entry with that name already there is kept', () => {
  for (const line of ['  - name: dim_ace__msdynmkt_segment', "  - name: 'dim_ace__msdynmkt_segment'  # x", '  - source: s\n    name: "dim_ace__msdynmkt_segment"']) {
    const text = `scd2_dimensions:\n${line}\n`;
    assert.deepEqual(addScd2Dimension(text, dim()), { text, status: 'exists' });
  }
  // Another section's `name:` doesn't count.
  assert.equal(addScd2Dimension('models:\n  - name: dim_ace__msdynmkt_segment\n', dim()).status, 'added');
});

test('addScd2Dimension: sections it can only break are left alone (unsupported)', () => {
  for (const text of [
    'scd2_dimensions: [a, b]\n',
    'scd2_dimensions: [{name: x}]  # flow\n',
    'scd2_dimensions:\n  [a,\n   b]\n', // multi-line flow list
    'scd2_dimensions:\n  # the list:\n  name: x\n', // a mapping, not a list
    'scd2_dimensions: &dims\n  - name: x\n',
    'scd2_dimensions:\n  - name: a\nscd2_dimensions:\n  - name: b\n',
    'scd2_dimensions:\n\t- name: x\n'
  ]) {
    const r = addScd2Dimension(text, dim());
    assert.equal(r.status, 'unsupported', text);
    assert.equal(r.text, text);
  }
  // null / ~ / quoted keys are an empty list or the same key.
  assert.equal(addScd2Dimension('scd2_dimensions: null\n', dim()).text, ['scd2_dimensions:', ...indent(ENTRY, 2), ''].join('\n'));
  assert.equal(addScd2Dimension('scd2_dimensions: ~\n', dim()).text, ['scd2_dimensions:', ...indent(ENTRY, 2), ''].join('\n'));
  assert.equal(addScd2Dimension("'scd2_dimensions':\n  - name: a\n", dim()).text, ["'scd2_dimensions':", '  - name: a', ...indent(ENTRY, 2), ''].join('\n'));
});

test('addScd2Dimension: a BOM is kept; a nested name: is not the entry name; odd names quoted', () => {
  const bom = String.fromCharCode(0xfeff);
  assert.equal(addScd2Dimension(bom + 'scd2_dimensions:\n  - name: a\n', dim()).text, bom + ['scd2_dimensions:', '  - name: a', ...indent(ENTRY, 2), ''].join('\n'));
  const nested = 'scd2_dimensions:\n  - name: x\n    other:\n      name: dim_ace__msdynmkt_segment\n';
  assert.equal(addScd2Dimension(nested, dim()).status, 'added');
  assert.deepEqual(scd2DimensionLines(dim('dim_a', 'int a: b')).slice(0, 2), ['- name: dim_a', "  source: 'int a: b'"]);
});

test('scd2ChainNames: staging, change key, candidate, history, published, gates; prefix from settings', () => {
  assert.deepEqual(scd2ChainNames('stg_crm__customer', SCD2_DEFAULTS), [
    'stg_crm__customer',
    'int_crm__customer__changekey',
    'dim_crm__customer__candidate',
    'dim_crm__customer__history',
    'dim_crm__customer__published',
    'dim_crm__customer__gates'
  ]);
  assert.deepEqual(scd2ChainNames('stg_a', { ...SCD2_DEFAULTS, historyPrefix: 'scd_' }), [
    'stg_a',
    'int_a__changekey',
    'scd_a__candidate',
    'scd_a__history',
    'scd_a__published',
    'scd_a__gates'
  ]);
  assert.deepEqual(scd2ChainNames('orders', SCD2_DEFAULTS), [], 'not a staging model');
});
