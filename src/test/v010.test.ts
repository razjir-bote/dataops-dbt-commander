import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { ctesIn, cteQueryAt, inlineSql } from '../scratch';
import { addTestsEdit, columnAt, legacyTestArguments } from '../yamlfix';
import { liveNodeIds, pruneRunState } from '../runstate';
import { parseManifest } from '../manifest';
import { macroHover, macroSignature } from '../macrohover';

const model = [
  "{{ config(materialized='table') }}",
  'with orders as (',
  "  select * from {{ ref('raw_orders') }} where note <> ')' -- a ) in a comment",
  '),',
  'paid as (',
  '  select id, (amount / 100) as dollars from orders /* ( */',
  ')',
  'select * from paid'
].join('\n');

test('ctesIn finds top-level CTEs, skipping brackets in strings, comments and Jinja', () => {
  const ctes = ctesIn(model);
  assert.deepEqual(ctes.map(c => c.name), ['orders', 'paid']);
  assert.equal(model.slice(ctes[1].bodyStart, ctes[1].bodyEnd).trim(), 'select id, (amount / 100) as dollars from orders /* ( */');
});

test('ctesIn handles quoted names, `with recursive` and no CTEs', () => {
  assert.deepEqual(ctesIn('WITH RECURSIVE "a b" AS (select 1) select * from "a b"').map(c => c.name), ['"a b"']);
  assert.deepEqual(ctesIn('select 1 as (x)'), []);
  assert.deepEqual(ctesIn("select 'with a as (' as s"), []);
});

test('cteQueryAt previews the CTE under the cursor with the CTEs before it', () => {
  const inPaid = model.indexOf('dollars');
  const q = cteQueryAt(model, inPaid);
  assert.equal(q?.name, 'paid');
  assert.ok(q!.sql.startsWith("{{ config(materialized='table') }}\nwith orders as ("));
  assert.ok(q!.sql.trimEnd().endsWith('select * from paid'));
  assert.ok(!q!.sql.includes('select * from paid\n'), 'final select of the model is not included');
  const inOrders = cteQueryAt(model, model.indexOf('raw_orders'));
  assert.equal(inOrders?.name, 'orders');
  assert.ok(inOrders!.sql.trimEnd().endsWith(')\nselect * from orders'), 'keeps every CTE (Jinja around them stays balanced)');
  assert.equal(cteQueryAt(model, model.length - 2), undefined, 'final select: not in a CTE');
  assert.equal(cteQueryAt(model, 3), undefined, 'config block: not in a CTE');
});

test('inlineSql drops a trailing semicolon and config() blocks', () => {
  assert.equal(inlineSql('select 1;\n'), 'select 1');
  assert.equal(inlineSql('select 1; -- end\n/* done */\n'), 'select 1');
  assert.equal(inlineSql('select 1 -- note'), 'select 1 -- note', 'a trailing comment alone is kept (dbt adds the limit on a new line)');
  assert.equal(inlineSql("{{ config(materialized='table') }}\nselect 1"), 'select 1');
  assert.equal(inlineSql('  '), '');
});

const yml = [
  'version: 2',
  'models:',
  '  - name: orders',
  '    columns:',
  '      - name: id',
  '        description: pk',
  '      - name: status',
  '        tests:',
  '          - not_null',
  '      - name: amount',
  '  - name: other',
  '    columns:',
  '    - name: x',
  'sources:',
  '  - name: raw',
  '    tables:',
  '      - name: t',
  '        columns:',
  '          - name: c'
].join('\n');

test('columnAt finds the model column on a line', () => {
  assert.deepEqual(columnAt(yml, 4), { model: 'orders', column: 'id', testsKey: undefined });
  assert.deepEqual(columnAt(yml, 5), { model: 'orders', column: 'id', testsKey: undefined });
  assert.deepEqual(columnAt(yml, 7), { model: 'orders', column: 'status', testsKey: 'tests' });
  assert.deepEqual(columnAt(yml, 12), { model: 'other', column: 'x', testsKey: undefined });
  assert.equal(columnAt(yml, 2), undefined, 'model line is not a column');
  assert.equal(columnAt(yml, 18), undefined, 'source columns are not model columns');
});

function apply(text: string, e: { line: number; text: string } | undefined): string {
  assert.ok(e);
  const lines = text.split('\n');
  lines.splice(e.line, 0, ...e.text.replace(/\n$/, '').split('\n'));
  return lines.join('\n');
}

test('addTestsEdit adds a data_tests list after the column keys', () => {
  const out = apply(yml, addTestsEdit(yml, 4, ['unique', 'not_null']));
  assert.ok(out.includes('      - name: id\n        description: pk\n        data_tests:\n          - unique\n          - not_null\n      - name: status'));
});

test('addTestsEdit appends to an existing tests list and skips tests already there', () => {
  const out = apply(yml, addTestsEdit(yml, 6, ['unique', 'not_null']));
  assert.ok(out.includes('        tests:\n          - not_null\n          - unique\n      - name: amount'));
  assert.equal(addTestsEdit(yml, 6, ['not_null']), undefined);
});

test('addTestsEdit writes accepted_values and works on the last column of an indentless list', () => {
  const out = apply(yml, addTestsEdit(yml, 12, [{ accepted_values: ['a', 'yes'] }]));
  assert.ok(out.includes('    - name: x\n      data_tests:\n        - accepted_values:\n            arguments:\n              values: ["a", "yes"]\nsources:'), out);
});

test('addTestsEdit uses CRLF when the file does', () => {
  const crlf = yml.replace(/\n/g, '\r\n');
  const e = addTestsEdit(crlf, 9, ['not_null']);
  assert.equal(e?.text, '        data_tests:\r\n          - not_null\r\n');
});

test('pruneRunState drops nodes no longer in the project', () => {
  const state = { a: { status: 'success', at: 1 }, b: { status: 'error', at: 2 } };
  assert.deepEqual(pruneRunState(state, new Set(['a', 'c'])), { a: { status: 'success', at: 1 } });
  assert.equal(pruneRunState(state, new Set(['a', 'b'])), state, 'unchanged state is returned as is');
});

test('macroSignature reads the arguments from the macro file', () => {
  const text = "{% macro other() %}{% endmacro %}\n{%- macro cents_to_dollars(col, scale=2) -%}\n  ({{ col }} / 100)::numeric(16, {{ scale }})\n{%- endmacro %}";
  assert.equal(macroSignature(text, 'cents_to_dollars'), 'cents_to_dollars(col, scale=2)');
  assert.equal(macroSignature(text, 'missing'), undefined);
});

test('macroHover shows signature, description and arguments', () => {
  const md = macroHover(
    { name: 'm', package: 'demo', description: 'Converts.', arguments: [{ name: 'col', type: 'string', description: 'The column' }] },
    'm(col)',
    'macros/m.sql'
  );
  assert.ok(md.includes('```sql\nm(col)\n```'));
  assert.ok(md.includes('Converts.'));
  assert.ok(md.includes('`col` (string): The column'));
  assert.ok(md.includes('demo · macros/m.sql'));
});

test('liveNodeIds lists nodes, sources and unit tests, and refuses an empty manifest', () => {
  const ids = liveNodeIds(JSON.stringify({ nodes: { 'model.d.a': {} }, sources: { 'source.d.s.t': {} }, unit_tests: { 'unit_test.d.a.u': {} } }));
  assert.deepEqual([...ids!].sort(), ['model.d.a', 'source.d.s.t', 'unit_test.d.a.u']);
  assert.equal(liveNodeIds(JSON.stringify({ nodes: {} })), undefined);
  assert.equal(liveNodeIds('{"nodes": {'), undefined);
});

test('addTestsEdit writes accepted_values without arguments: for dbt before 1.10', () => {
  const e = addTestsEdit(yml, 9, [{ accepted_values: ['a'] }], { legacyArguments: true });
  assert.equal(e?.text, '        data_tests:\n          - accepted_values:\n              values: ["a"]\n');
});

test('parseManifest keeps macro descriptions and arguments', () => {
  const root = path.resolve('p');
  const idx = parseManifest(
    JSON.stringify({
      metadata: { adapter_type: 'duckdb' },
      macros: {
        'macro.demo.m': { name: 'm', package_name: 'demo', original_file_path: 'macros/m.sql', description: 'Does m.', arguments: [{ name: 'col', type: 'string', description: '' }, { type: 'x' }] }
      }
    }),
    root,
    'demo'
  );
  assert.deepEqual(idx!.macros[0], { name: 'm', package: 'demo', file: path.join(root, 'macros', 'm.sql'), description: 'Does m.', arguments: [{ name: 'col', type: 'string' }] });
});

test('legacyTestArguments is true before dbt 1.10 only', () => {
  assert.equal(legacyTestArguments('1.9.4'), true);
  assert.equal(legacyTestArguments('1.10.0'), false);
  assert.equal(legacyTestArguments('1.12.7'), false);
  assert.equal(legacyTestArguments(undefined), true, 'unknown version: the form every 1.x accepts');
});

test('ctesIn: Jinja around CTEs, dollar quotes and array brackets', () => {
  const sql = "with a as (select 1 as x),\n{% if var('x', true) %}\nb as (select * from a),\n{% endif %}\nc as (select $$ ) $$ as s, ['a]', 'b'] as l from b)\nselect * from c";
  assert.deepEqual(ctesIn(sql).map(c => c.name), ['a', 'b', 'c']);
  const q = cteQueryAt(sql, sql.indexOf('select * from a'));
  assert.equal(q?.name, 'b');
  assert.ok(q!.sql.includes('{% endif %}'), 'Jinja block cut off');
  assert.ok(q!.sql.endsWith('\nselect * from b'));
});

test('addTestsEdit sees tests written as name/test_name and quoted', () => {
  const t = ['version: 2', 'models:', '  - name: m', '    columns:', '      - name: id', '        data_tests:', '          - name: id_unique', '            test_name: unique', '          - "not_null"'].join('\n');
  assert.equal(addTestsEdit(t, 4, ['unique']), undefined);
  assert.equal(addTestsEdit(t, 4, ['not_null']), undefined);
});

test('ctesIn: backslash-escaped quotes (Snowflake, BigQuery, Databricks)', () => {
  const sql = "with a as (select 'O\\'Brien' as n),\nb as (select ')' as p from a)\nselect * from b";
  assert.deepEqual(ctesIn(sql).map(c => c.name), ['a', 'b']);
  assert.equal(cteQueryAt(sql, sql.indexOf("')'"))?.name, 'b');
});

test('ctesIn: a backslash at the end of a standard SQL string stays literal', () => {
  const sql = "with a as (select 'C:\\' as dir),\nb as (select 1 as x)\nselect * from b";
  assert.deepEqual(ctesIn(sql).map(c => c.name), ['a', 'b']);
});

test('ctesIn: BigQuery # comments', () => {
  const sql = "with a as (\n  select 1 as x # don't count ( this\n),\nb as (select x from a)\nselect * from b";
  assert.deepEqual(ctesIn(sql).map(c => c.name), ['a', 'b']);
});
