import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnsOf, toCsv, toTsv, viewRows } from '../exportrows';
import { profileRows, profileSql, relationSql, yamlColumnSql } from '../profile';
import { addTestsEdit, columnOwnerAt } from '../yamlfix';

const rows = [
  { id: 2, name: 'b', amount: '12345678901234567891' },
  { id: 10, name: null, amount: '9' },
  { id: 1, name: 'A, "quoted"\nline', amount: null }
];

test('columnsOf keeps first-seen order across rows', () => {
  assert.deepEqual(columnsOf([{ a: 1 }, { b: 2, a: 3 }]), ['a', 'b']);
});

test('viewRows sorts numbers numerically, big integers exactly, NULLs last both ways', () => {
  assert.deepEqual(viewRows(rows, { sort: { column: 'id', dir: 'asc' } }).map(r => r.id), [1, 2, 10]);
  assert.deepEqual(viewRows(rows, { sort: { column: 'id', dir: 'desc' } }).map(r => r.id), [10, 2, 1]);
  assert.deepEqual(viewRows(rows, { sort: { column: 'amount', dir: 'asc' } }).map(r => r.id), [10, 2, 1]);
  assert.deepEqual(viewRows(rows, { sort: { column: 'amount', dir: 'desc' } }).map(r => r.id), [2, 10, 1]);
  assert.deepEqual(viewRows(rows, { sort: { column: 'name', dir: 'desc' } }).map(r => r.id), [2, 1, 10]);
  assert.deepEqual(viewRows(rows, {}).map(r => r.id), [2, 10, 1], 'no sort: original order');
});

test('viewRows filters on any cell, case-insensitive; NULL matches "null"', () => {
  assert.deepEqual(viewRows(rows, { filter: 'QUOTED' }).map(r => r.id), [1]);
  assert.deepEqual(viewRows(rows, { filter: '1' }).map(r => r.id), [2, 10, 1]);
  assert.deepEqual(viewRows(rows, { filter: 'null' }).map(r => r.id), [10, 1]);
  assert.deepEqual(viewRows(rows, { filter: '  ' }).map(r => r.id), [2, 10, 1]);
});

test('viewRows is self-contained, so the webview can run the same code', () => {
  const copy = new Function(`return (${viewRows.toString()})`)();
  assert.deepEqual(copy(rows, { sort: { column: 'id', dir: 'asc' }, filter: 'n' }).map((r: any) => r.id), [1, 10]);
});

test('toCsv quotes per RFC 4180 with CRLF; NULL is empty', () => {
  assert.equal(
    toCsv(['id', 'name', 'amount'], rows),
    'id,name,amount\r\n2,b,12345678901234567891\r\n10,,9\r\n1,"A, ""quoted""\nline",\r\n'
  );
  assert.equal(toCsv(['x'], [{ x: ' padded' }, { x: { a: 1 } }]), 'x\r\n" padded"\r\n"{""a"":1}"\r\n');
});

test('toTsv flattens tabs and newlines for pasting into a spreadsheet', () => {
  assert.equal(toTsv(['id', 'name'], [{ id: 1, name: 'a\tb\r\nc' }, { id: 2, name: null }]), 'id\tname\n1\ta b c\n2\t\n');
});

test('relationSql: ref or source with quotes escaped', () => {
  assert.equal(relationSql({ kind: 'model', name: 'orders' }), "{{ ref('orders') }}");
  assert.equal(relationSql({ kind: 'source', source: 'raw', name: "o'rders" }), "{{ source('raw', 'o\\'rders') }}");
});

test('profileSql: one query with stats, top values and a sort key; unusual names quoted', () => {
  const sql = profileSql("{{ ref('orders') }}", 'status');
  assert.match(sql, /select status as v from \{\{ ref\('orders'\) \}\}/);
  assert.match(sql, /dbt\.type_string\(\)/);
  assert.match(sql, /limit 10/);
  assert.match(sql, /order by ord/);
  assert.match(profileSql('x', 'Order Date'), /adapter\.quote\('Order Date'\)/);
});

test('profileRows formats stats and top values (any key case, e.g. Snowflake)', () => {
  const raw = [
    { ORD: 1, STAT: 'rows', VALUE: '200', N: null },
    { ORD: 2, STAT: 'nulls', VALUE: '50', N: null },
    { ORD: 3, STAT: 'distinct', VALUE: '3', N: null },
    { ORD: 4, STAT: 'min', VALUE: 'a', N: null },
    { ORD: 5, STAT: 'max', VALUE: 'c', N: null },
    { ORD: 6, STAT: 'top value', VALUE: 'a', N: 120 },
    { ORD: 6, STAT: 'top value', VALUE: null, N: 50 }
  ];
  assert.deepEqual(profileRows(raw), [
    { statistic: 'rows', value: '200', count: null },
    { statistic: 'nulls', value: '50 (25%)', count: null },
    { statistic: 'distinct', value: '3', count: null },
    { statistic: 'min', value: 'a', count: null },
    { statistic: 'max', value: 'c', count: null },
    { statistic: 'top value 1', value: 'a', count: 120 },
    { statistic: 'top value 2', value: null, count: 50 }
  ]);
});

const yml = [
  'version: 2',
  'models:',
  '  - name: orders',
  '    columns:',
  '      - name: customer_id',
  'seeds:',
  '  - name: countries',
  '    columns:',
  '      - name: code',
  'sources:',
  '  - name: raw',
  '    tables:',
  '      - name: customers',
  '        columns:',
  '          - name: id',
  '            description: pk',
  '  - name: other',
  '    tables:',
  '    - name: t',
  '      columns:',
  '      - name: c'
].join('\n');

test('columnOwnerAt finds model, seed and source columns', () => {
  assert.deepEqual(columnOwnerAt(yml, 4), { kind: 'model', name: 'orders', column: 'customer_id' });
  assert.deepEqual(columnOwnerAt(yml, 8), { kind: 'seed', name: 'countries', column: 'code' });
  assert.deepEqual(columnOwnerAt(yml, 15), { kind: 'source', source: 'raw', name: 'customers', column: 'id' });
  assert.deepEqual(columnOwnerAt(yml, 20), { kind: 'source', source: 'other', name: 't', column: 'c' });
  assert.equal(columnOwnerAt(yml, 12), undefined, 'a table is not a column');
});

test('addTestsEdit writes generic tests with arguments (relationships, dbt_utils)', () => {
  const e = addTestsEdit(yml, 4, [
    { test: 'relationships', args: { to: "ref('customers')", field: 'id' } },
    'dbt_utils.not_empty_string',
    { test: 'dbt_utils.accepted_range', args: { min_value: '0' } }
  ]);
  assert.equal(
    e?.text,
    [
      '        data_tests:',
      '          - relationships:',
      '              arguments:',
      "                to: ref('customers')",
      '                field: id',
      '          - dbt_utils.not_empty_string',
      '          - dbt_utils.accepted_range:',
      '              arguments:',
      '                min_value: 0',
      ''
    ].join('\n')
  );
  const legacy = addTestsEdit(yml, 4, [{ test: 'relationships', args: { to: "ref('customers')", field: 'id' } }], { legacyArguments: true });
  assert.equal(legacy?.text, "        data_tests:\n          - relationships:\n              to: ref('customers')\n              field: id\n");
});

test('profileRows re-sorts rows by the sort key and count (dbt show may not keep the order)', () => {
  const out = profileRows([
    { ord: 6, stat: 'top value', value: 'b', n: 5 },
    { ord: 1, stat: 'rows', value: '20', n: null },
    { ord: 6, stat: 'top value', value: 'a', n: 9 }
  ]);
  assert.deepEqual(out.map(r => r.statistic + ':' + r.value), ['rows:20', 'top value 1:a', 'top value 2:b']);
});

test('profileSql without min / max (for types the warehouse cannot compare)', () => {
  const sql = profileSql('x', 'id', { minMax: false });
  assert.doesNotMatch(sql, /min\(|max\(/);
  assert.match(sql, /count\(distinct v\)/);
});

test('yamlColumnSql: identifiers of any case stay bare; others are quoted', () => {
  assert.equal(yamlColumnSql('CustomerId'), 'CustomerId');
  assert.equal(yamlColumnSql('order_id'), 'order_id');
  assert.match(yamlColumnSql('Order Date'), /adapter\.quote\('Order Date'\)/);
  assert.match(yamlColumnSql('x', true), /adapter\.quote\('x'\)/);
});

test('viewRows sorts a column numerically only when every value is numeric', () => {
  const r = [{ v: '200' }, { v: '1e5' }, { v: '20x' }];
  const once = viewRows(r, { sort: { column: 'v', dir: 'asc' } }).map(x => x.v);
  assert.deepEqual(once, ['1e5', '20x', '200'], 'mixed column: text order');
  assert.deepEqual(viewRows([{ v: '1e5' }, { v: '200' }], { sort: { column: 'v', dir: 'asc' } }).map(x => x.v), ['200', '1e5']);
});

test('toTsv quotes cells with double quotes so spreadsheets paste them intact', () => {
  assert.equal(toTsv(['a'], [{ a: 'say "hi"' }]), 'a\n"say ""hi"""\n');
});

test('addTestsEdit allows several relationships / accepted_range tests, but not duplicate plain tests', () => {
  const t = ['version: 2', 'models:', '  - name: m', '    columns:', '      - name: id', '        data_tests:', '          - relationships:', "              arguments: {to: ref('a'), field: id}"].join('\n');
  assert.ok(addTestsEdit(t, 4, [{ test: 'relationships', args: { to: "ref('b')", field: 'id' } }]));
});
