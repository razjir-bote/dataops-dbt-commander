import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRONZE_DEFAULTS, bronzeStaging } from '../bronze';

const cols = (...names: string[]) => names.map(name => ({ name }));
const example = cols(
  'Id', 'SinkCreatedOn', 'SinkModifiedOn', 'accountid', 'aus_accounttag_accountid', 'aus_accounttagid', 'versionnumber',
  'IsDelete', 'CreatedOn', '_source_file', '_landing_extract_date', '_full_row_hash', '_bronze_run_id',
  '_bronze_loaded_at_utc_ts', '_bronze_load_date', '_bronze_feed_name', '_bronze_source_system', '_bronze_source_file',
  '_bronze_schema_hash', '_bronze_profile_hash', '_bronze_row_hash'
);
const text = (c: string, as = c) => `NULLIF(LTRIM(RTRIM(CAST([${c}] AS NVARCHAR(4000)))), '') AS [${as}]`;
const typed = (c: string, t: string) => `TRY_CAST(NULLIF(LTRIM(RTRIM(TRY_CAST([${c}] AS VARCHAR(4000)))), '') AS ${t}) AS [${c}]`;

test('bronzeStaging reproduces the team template (Id kept, entity_id added first)', () => {
  const { sql } = bronzeStaging('bronze', 'ace_aus_accounttag_account', example, BRONZE_DEFAULTS);
  const selects = [
    text('Id', 'entity_id'),
    text('Id'),
    typed('SinkCreatedOn', 'DATETIME2'),
    typed('SinkModifiedOn', 'DATETIME2'),
    text('accountid'),
    text('aus_accounttag_accountid'),
    text('aus_accounttagid'),
    text('versionnumber'),
    text('IsDelete'),
    typed('CreatedOn', 'DATETIME2'),
    text('_source_file'),
    typed('_landing_extract_date', 'DATE'),
    text('_full_row_hash'),
    text('_bronze_run_id'),
    typed('_bronze_loaded_at_utc_ts', 'DATETIME2'),
    typed('_bronze_load_date', 'DATE'),
    text('_bronze_feed_name'),
    text('_bronze_source_system'),
    text('_bronze_source_file'),
    text('_bronze_schema_hash'),
    text('_bronze_profile_hash'),
    text('_bronze_row_hash')
  ];
  const expected = [
    'WITH source AS (',
    '',
    '    SELECT *',
    "    FROM {{ source('bronze', 'ace_aus_accounttag_account') }}",
    '',
    '),',
    '',
    'renamed AS (',
    '',
    '    SELECT',
    selects.map(s => `        ${s}`).join(',\n\n'),
    '',
    '    FROM source',
    '',
    '),',
    '',
    'deduplicated AS (',
    '',
    '    SELECT',
    '        *,',
    '        ROW_NUMBER() OVER (',
    '            PARTITION BY',
    '                [_landing_extract_date],',
    '                [entity_id]',
    '            ORDER BY',
    '                [_bronze_loaded_at_utc_ts] DESC,',
    '                [_bronze_run_id] DESC',
    '        ) AS rn',
    '    FROM renamed',
    '',
    ')',
    '',
    'SELECT *',
    'FROM deduplicated',
    'WHERE rn = 1',
    "    AND LOWER([IsDelete]) IN ('false', '0')",
    ''
  ].join('\n');
  assert.equal(sql, expected);
});

test('YAML columns: entity_id first, then every column with its staged type', () => {
  const { columns } = bronzeStaging('bronze', 't', cols('Id', 'CreatedOn', '_landing_extract_date', 'name'), BRONZE_DEFAULTS);
  assert.deepEqual(columns, [
    { name: 'entity_id', dataType: 'nvarchar(4000)' },
    { name: 'Id', dataType: 'nvarchar(4000)' },
    { name: 'CreatedOn', dataType: 'datetime2' },
    { name: '_landing_extract_date', dataType: 'date' },
    { name: 'name', dataType: 'nvarchar(4000)' }
  ]);
});

test('no key column: dedupe on every column not starting with _ per extract date, newest load first', () => {
  const { sql } = bronzeStaging('bronze', 't', cols('code', 'Label', '_landing_extract_date', '_bronze_run_id', '_bronze_loaded_at_utc_ts'), BRONZE_DEFAULTS);
  assert.ok(!sql.includes('entity_id'));
  assert.match(sql, /PARTITION BY\n {16}\[_landing_extract_date\],\n {16}\[code\],\n {16}\[Label\]\n {12}ORDER BY\n {16}\[_bronze_loaded_at_utc_ts\] DESC,\n {16}\[_bronze_run_id\] DESC\n/);
  assert.match(sql, /WHERE rn = 1\n$/, 'no IsDelete: no delete filter');
});

test('key matched case-insensitively; missing rule columns left out; no order columns → ORDER BY (SELECT NULL)', () => {
  const { sql } = bronzeStaging('bronze', 't', cols('ID', 'value'), BRONZE_DEFAULTS);
  assert.match(sql, /CAST\(\[ID\] AS NVARCHAR\(4000\)\)\)\), ''\) AS \[entity_id\]/);
  assert.match(sql, /PARTITION BY\n {16}\[entity_id\]\n {12}ORDER BY\n {16}\(SELECT NULL\)\n/);
});

test('nothing to dedupe on (only metadata columns, no key): no deduplicated CTE; delete filter on renamed', () => {
  const { sql } = bronzeStaging('bronze', 't', cols('_x', '_is_deleted'), { ...BRONZE_DEFAULTS, partitionColumns: [], deleteColumn: '_is_deleted' });
  assert.ok(!sql.includes('deduplicated'));
  assert.ok(sql.endsWith("SELECT *\nFROM renamed\nWHERE LOWER([_is_deleted]) IN ('false', '0')\n"));
});

test('warehouse date / datetime types are kept when the name says nothing; brackets and quotes escaped', () => {
  const { sql, columns } = bronzeStaging("o'src", 'a]b', [{ name: 'when', dataType: 'datetime2(7)' }, { name: 'day', dataType: 'DATE' }, { name: 'x]y' }], BRONZE_DEFAULTS);
  assert.match(sql, /AS DATETIME2\) AS \[when\]/);
  assert.match(sql, /AS DATE\) AS \[day\]/);
  assert.match(sql, /CAST\(\[x\]\]y\] AS NVARCHAR\(4000\)\)/);
  assert.match(sql, /source\('o\\'src', 'a\]b'\)/);
  assert.deepEqual(columns.map(c => c.dataType), ['datetime2', 'date', 'nvarchar(4000)']);
});

test('no columns known: SELECT * with a TODO', () => {
  const { sql, columns } = bronzeStaging('bronze', 't', [], BRONZE_DEFAULTS);
  assert.match(sql, /-- TODO: list the columns[\s\S]*SELECT \*\nFROM source\n$/);
  assert.deepEqual(columns, []);
});

test('custom rules from settings: patterns, key alias, delete values', () => {
  const { sql } = bronzeStaging('s', 't', cols('pk', 'updated_stamp', 'deleted'), {
    ...BRONZE_DEFAULTS,
    datetimePattern: '_stamp$',
    keyColumn: 'pk',
    keyAlias: 'row_key',
    deleteColumn: 'deleted',
    deleteKeepValues: ['n']
  });
  assert.match(sql, /AS DATETIME2\) AS \[updated_stamp\]/);
  assert.match(sql, /AS \[row_key\]/);
  assert.match(sql, /LOWER\(\[deleted\]\) IN \('n'\)/);
});

test('columns already typed date / datetime in the warehouse skip the text round trip (no lost seconds)', () => {
  const { sql } = bronzeStaging('b', 't', [{ name: 'CreatedOn', dataType: 'datetime' }, { name: 'd_date', dataType: 'date' }, { name: 'LoadedOn', dataType: 'nvarchar(50)' }], BRONZE_DEFAULTS);
  assert.match(sql, /TRY_CAST\(\[CreatedOn\] AS DATETIME2\) AS \[CreatedOn\]/);
  assert.match(sql, /TRY_CAST\(\[d_date\] AS DATE\) AS \[d_date\]/);
  assert.match(sql, /TRY_CAST\(NULLIF\(LTRIM\(RTRIM\(TRY_CAST\(\[LoadedOn\] AS VARCHAR\(4000\)\)\)\), ''\) AS DATETIME2\) AS \[LoadedOn\]/, 'text stays trimmed');
});

test('a table that already has an entity_id column does not get it twice', () => {
  const { sql, columns } = bronzeStaging('b', 't', [{ name: 'Id' }, { name: 'entity_id' }, { name: 'x' }], BRONZE_DEFAULTS);
  assert.equal((sql.match(/AS \[entity_id\]/g) ?? []).length, 1);
  assert.deepEqual(columns.map(c => c.name), ['entity_id', 'Id', 'x']);
});
