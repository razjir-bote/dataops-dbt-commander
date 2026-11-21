import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HASH_COLUMNS_MACRO, SCD2_DEFAULTS, changeKeyNames, changeKeySql, scd2GeneratedModels } from '../scd2';

test('changeKeyNames from the staging model name', () => {
  assert.deepEqual(changeKeyNames('stg_ace__aus_accounttag', SCD2_DEFAULTS), {
    model: 'int_ace__aus_accounttag_changekey',
    history: 'dim_ace__aus_accounttag__history'
  });
  assert.deepEqual(changeKeyNames('stg_a', SCD2_DEFAULTS), { model: 'int_a_changekey', history: 'dim_a__history' });
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
