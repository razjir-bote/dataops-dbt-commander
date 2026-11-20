import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { acceptResults, batchSelectors, invocationOf, modelHover, parseCatalog, parseRunResults, sourceHover, testLine } from '../runresults';

const rr = (id: string, generated: string, which = 'test') =>
  JSON.stringify({ metadata: { invocation_id: id, generated_at: generated }, args: { which }, results: [{ unique_id: 'test.demo.t.1', status: 'pass' }] });

test('acceptResults only trusts run_results written by this dbt test run', () => {
  const started = Date.parse('2026-11-20T10:00:00Z');
  assert.equal(invocationOf(rr('old', '2026-11-20T09:00:00Z')), 'old');
  assert.equal(invocationOf('nope'), undefined);
  assert.equal(acceptResults(rr('new', '2026-11-20T10:00:05Z'), 'old', started)?.length, 1);
  assert.equal(acceptResults(rr('old', '2026-11-20T10:00:05Z'), 'old', started), undefined, 'same invocation as before the run');
  assert.equal(acceptResults(rr('new', '2026-11-20T09:59:00Z'), 'old', started), undefined, 'written before this run started');
  assert.equal(acceptResults(rr('new', '2026-11-20T10:00:05Z', 'build'), 'old', started), undefined, 'a terminal dbt build');
  assert.equal(acceptResults('garbage', 'old', started), undefined);
});

test('batchSelectors keeps each dbt command line under the limit', () => {
  const sels = Array.from({ length: 2000 }, (_, i) => `not_null_some_long_model_name_${i}_id`);
  const batches = batchSelectors(sels, 8000);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), sels);
  for (const b of batches) {
    assert.ok(b.join(' ').length <= 8000);
  }
  assert.deepEqual(batchSelectors([], 8000), []);
});

test('testLine ignores same-named columns and keys outside models:/tables: lists', () => {
  const yml = [
    'version: 2',             // 0
    'models:',                // 1
    '  - name: orders',       // 2
    '    columns:',           // 3
    '      - name: status',   // 4  <- a column named like the model below
    '  - name: status',       // 5
    '    columns:',           // 6
    '      - name: id',       // 7
    'sources:',               // 8
    '  - name: raw',          // 9
    '    tables:',            // 10
    '      - name: raw',      // 11 <- table named like its source
    '        columns:',       // 12
    '          - name: id'    // 13
  ].join('\n');
  assert.equal(testLine(yml, 'status', 'id'), 7);
  assert.equal(testLine(yml, 'status'), 5);
  assert.equal(testLine(yml, 'raw', 'id'), 13);
});

test('hover markdown cannot load remote images and escapes backticks in names', () => {
  const m = parseManifest(manifest, root, 'demo')!;
  const b = {
    ...m.models.find(x => x.name === 'b')!,
    description: 'Tracked ![](https://evil.example/x.png) here',
    columns: [{ name: 'we`ird', description: 'see ![img](http://x/y)' }]
  };
  const md = modelHover(b, undefined, root);
  assert.doesNotMatch(md, /!\[/);
  assert.doesNotMatch(md, /`we`ird`/);
});
import { parseManifest } from '../manifest';

const root = path.join('C:/proj');

test('parseRunResults maps dbt-core 1.12 results', () => {
  const json = JSON.stringify({
    results: [
      { unique_id: 'test.demo.not_null_b_id.37be81e63b', status: 'pass', message: null, failures: 0, execution_time: 0.028 },
      { unique_id: 'test.demo.unique_dup_id.1', status: 'fail', message: 'Got 1 result, configured to fail if != 0', failures: 1, execution_time: 0.03 }
    ]
  });
  assert.deepEqual(parseRunResults(json), [
    { uniqueId: 'test.demo.not_null_b_id.37be81e63b', status: 'pass', seconds: 0.028 },
    { uniqueId: 'test.demo.unique_dup_id.1', status: 'fail', message: 'Got 1 result, configured to fail if != 0', seconds: 0.03 }
  ]);
  assert.deepEqual(parseRunResults('nope'), []);
});

test('testLine finds the column inside the right model entry', () => {
  const yml = [
    'version: 2',          // 0
    'models:',             // 1
    '  - name: a',         // 2
    '    columns:',        // 3
    '      - name: id',    // 4
    '  - name: b',         // 5
    '    columns:',        // 6
    '      - name: email', // 7
    "      - name: 'id'",  // 8
    '        data_tests: [not_null]'
  ].join('\n');
  assert.equal(testLine(yml, 'b', 'id'), 8);
  assert.equal(testLine(yml, 'a', 'id'), 4);
  assert.equal(testLine(yml, 'b'), 5);
  assert.equal(testLine(yml, 'b', 'missing'), 5);
  assert.equal(testLine(yml, 'zzz'), 0);
});

test('parseCatalog returns columns in warehouse order with types', () => {
  const json = JSON.stringify({
    nodes: { 'model.demo.b': { columns: { name: { type: 'VARCHAR', index: 2, name: 'name' }, id: { type: 'INTEGER', index: 1, name: 'id' } } } },
    sources: { 'source.demo.raw.orders': { columns: { amount: { type: 'DOUBLE', index: 1, name: 'amount' } } } }
  });
  const c = parseCatalog(json);
  assert.deepEqual(c.get('model.demo.b'), [{ name: 'id', dataType: 'INTEGER' }, { name: 'name', dataType: 'VARCHAR' }]);
  assert.deepEqual(c.get('source.demo.raw.orders'), [{ name: 'amount', dataType: 'DOUBLE' }]);
  assert.equal(parseCatalog('x').size, 0);
});

const manifest = JSON.stringify({
  metadata: { adapter_type: 'duckdb' },
  nodes: {
    'model.demo.b': {
      resource_type: 'model', name: 'b', package_name: 'demo', original_file_path: 'models\\b.sql',
      description: 'Customers, one row each', config: { materialized: 'table' },
      columns: { id: { name: 'id', description: 'Primary key', data_type: 'integer' }, email: { name: 'email', description: '' } }
    },
    'model.demo.bare': { resource_type: 'model', name: 'bare', package_name: 'demo', original_file_path: 'models/bare.sql', description: '', config: { materialized: 'view' }, columns: {} },
    'test.demo.not_null_b_id.1': { resource_type: 'test', name: 'not_null_b_id', package_name: 'demo', original_file_path: 'models/schema.yml', attached_node: 'model.demo.b', column_name: 'id' },
    'test.demo.assert_x.2': { resource_type: 'test', name: 'assert_x', package_name: 'demo', original_file_path: 'tests/assert_x.sql', attached_node: null }
  },
  sources: {
    'source.demo.raw.orders': {
      source_name: 'raw', name: 'orders', package_name: 'demo', original_file_path: 'models/sources.yml',
      description: 'Raw orders', source_description: 'Shop database', loader: 'fivetran', identifier: 'orders_v2',
      columns: { amount: { name: 'amount', description: 'In cents' } }
    }
  }
});

test('parseManifest keeps descriptions, columns and test details', () => {
  const m = parseManifest(manifest, root, 'demo')!;
  const b = m.models.find(x => x.name === 'b')!;
  assert.equal(b.description, 'Customers, one row each');
  assert.deepEqual(b.columns, [{ name: 'id', dataType: 'integer', description: 'Primary key' }, { name: 'email' }]);
  assert.equal(b.uniqueId, 'model.demo.b');
  const t = m.tests.find(x => x.name === 'not_null_b_id')!;
  assert.deepEqual([t.uniqueId, t.columnName, t.singular], ['test.demo.not_null_b_id.1', 'id', false]);
  assert.equal(m.tests.find(x => x.name === 'assert_x')!.singular, true);
  const s = m.sources[0];
  assert.deepEqual([s.description, s.sourceDescription, s.loader, s.identifier, s.uniqueId], ['Raw orders', 'Shop database', 'fivetran', 'orders_v2', 'source.demo.raw.orders']);
  assert.deepEqual(s.columns, [{ name: 'amount', description: 'In cents' }]);
});

test('modelHover shows description, materialization, path and columns (catalog types win)', () => {
  const m = parseManifest(manifest, root, 'demo')!;
  const b = m.models.find(x => x.name === 'b')!;
  const md = modelHover(b, [{ name: 'id', dataType: 'INTEGER' }, { name: 'email', dataType: 'VARCHAR' }, { name: 'extra', dataType: 'DATE' }], root);
  assert.match(md, /^\*\*b\*\* · model · `table`/);
  assert.match(md, /Customers, one row each/);
  assert.match(md, /models\/b\.sql/);
  assert.match(md, /\| `id` \| INTEGER \| Primary key \|/);
  assert.match(md, /\| `extra` \| DATE \| {2}\|/);
  const bare = modelHover(m.models.find(x => x.name === 'bare')!, undefined, root);
  assert.match(bare, /\*\*bare\*\* · model · `view`/);
  assert.doesNotMatch(bare, /\| Column \|/);
});

test('sourceHover shows source and table descriptions, loader, identifier and columns', () => {
  const s = parseManifest(manifest, root, 'demo')!.sources[0];
  const md = sourceHover(s, undefined, root);
  assert.match(md, /^\*\*raw\.orders\*\* · source/);
  assert.match(md, /Raw orders/);
  assert.match(md, /Shop database/);
  assert.match(md, /fivetran/);
  assert.match(md, /orders_v2/);
  assert.match(md, /\| `amount` \| {2}\| In cents \|/);
});

test('hover text escapes table-breaking characters in descriptions', () => {
  const m = parseManifest(manifest, root, 'demo')!;
  const b = { ...m.models.find(x => x.name === 'b')!, columns: [{ name: 'id', description: 'a | b\nc' }] };
  assert.match(modelHover(b, undefined, root), /\| `id` \| {2}\| a \\\| b c \|/);
});
