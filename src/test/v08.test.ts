import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { isValidModelName, renameRefEdits, renameYamlEdits, takenModelNames } from '../refactor';
import { debugArgs, debugSummary, docsFragment, docsRedirectHtml, newModelSql, stagingName, stagingSql } from '../scaffold';
import { parseManifest } from '../manifest';
import { appendModel, newModelYaml } from '../yamlgen';

const apply = (text: string, edits: { start: number; end: number; text: string }[]) =>
  [...edits].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);

test('renameRefEdits rewrites only real ref() calls to the model, keeping quotes and package', () => {
  const sql = [
    "select * from {{ ref('orders') }}",
    'join {{ ref("orders") }} using (id)',
    "join {{ ref('shop', 'orders') }} using (id)",
    "join {{ ref('orders_v2') }} using (id)",
    "join {{ ref('orders', v=2) }} using (id)",
    "-- orders is not a call; neither is source('raw', 'orders')"
  ].join('\n');
  const out = apply(sql, renameRefEdits(sql, 'orders', 'fct_orders'));
  assert.equal(
    out,
    [
      "select * from {{ ref('fct_orders') }}",
      'join {{ ref("fct_orders") }} using (id)',
      "join {{ ref('shop', 'fct_orders') }} using (id)",
      "join {{ ref('orders_v2') }} using (id)",
      "join {{ ref('fct_orders', v=2) }} using (id)",
      "-- orders is not a call; neither is source('raw', 'orders')"
    ].join('\n')
  );
  assert.deepEqual(renameRefEdits("select 1", 'orders', 'x'), []);
});

test('renameYamlEdits renames the model entry, not a same-named column or source table', () => {
  const yml = [
    'version: 2',
    'models:',
    '  - name: orders',
    '    columns:',
    '      - name: id',
    '  - name: customers',
    '    columns:',
    "      - name: 'orders'",
    'sources:',
    '  - name: raw',
    '    tables:',
    '      - name: orders'
  ].join('\n');
  const out = apply(yml, renameYamlEdits(yml, 'orders', 'fct_orders'));
  assert.equal(out, yml.replace('  - name: orders\n    columns:\n      - name: id', '  - name: fct_orders\n    columns:\n      - name: id'));
  const quoted = "models:\n  - name: \"orders\"\n";
  assert.equal(apply(quoted, renameYamlEdits(quoted, 'orders', 'o2')), 'models:\n  - name: "o2"\n');
});

test('YAML for a model with no columns yet has no empty columns key', () => {
  assert.equal(newModelYaml('fct_x', []), 'version: 2\n\nmodels:\n  - name: fct_x\n    description: ""\n');
  const text = appendModel('version: 2\nmodels:\n  - name: a\n', 'fct_x', []);
  assert.match(text, /\n  - name: fct_x\n    description: ""/);
  assert.doesNotMatch(text, /columns:/);
});

test('renameRefEdits leaves another package\'s model of the same name alone', () => {
  const sql = "select * from {{ ref('other_pkg', 'orders') }} join {{ ref('demo', 'orders') }} join {{ ref('orders') }}";
  const out = apply(sql, renameRefEdits(sql, 'orders', 'o2', 'demo'));
  assert.equal(out, "select * from {{ ref('other_pkg', 'orders') }} join {{ ref('demo', 'o2') }} join {{ ref('o2') }}");
});

test('renameYamlEdits handles indentless lists and unit_tests model keys', () => {
  const yml = [
    'models:',
    '- name: orders',
    '  columns:',
    '  - name: orders',
    'unit_tests:',
    '- name: test_orders',
    '  model: orders',
    '  given: []'
  ].join('\n');
  const out = apply(yml, renameYamlEdits(yml, 'orders', 'o2'));
  assert.equal(out, yml.replace('- name: orders\n  columns', '- name: o2\n  columns').replace('  model: orders', '  model: o2'));
});

test('debugArgs keeps only the flags dbt debug accepts', () => {
  assert.deepEqual(debugArgs('dev', `--full-refresh --profiles-dir ./p --threads 4 --vars '{"a": 1}' --select x --project-dir=.`), [
    '--target', 'dev', '--profiles-dir', './p', '--vars', '{"a": 1}', '--project-dir=.'
  ]);
  assert.deepEqual(debugArgs('', ''), []);
});

test('docsRedirectHtml escapes the target for the attribute and the script', () => {
  const html = docsRedirectHtml('static_index.html#!/source/source.demo.raw."x"</script><b>');
  assert.doesNotMatch(html, /<\/script><b>/);
  assert.doesNotMatch(html, /content="0; url=[^"]*"x"/);
  assert.match(html, /location\.replace\(/);
});

test('stagingSql quotes column names that need it, via the adapter', () => {
  const sql = stagingSql('raw', 'orders', ['id', 'Order Id', 'select']);
  assert.match(sql, /        id,\n        \{\{ adapter\.quote\('Order Id'\) \}\},\n        \{\{ adapter\.quote\('select'\) \}\}\n/);
});

test('takenModelNames ignores manifest models whose file is gone (stale manifest right after a rename)', () => {
  const models = [
    { name: 'b', package: 'demo', file: 'C:/p/models/b.sql' }, // renamed away: file no longer exists
    { name: 'b_renamed', package: 'demo', file: 'C:/p/models/b_renamed.sql' },
    { name: 'helper', package: 'pkg', file: 'C:/p/dbt_packages/pkg/models/helper.sql' }
  ];
  const exists = (f: string) => f !== 'C:/p/models/b.sql';
  assert.deepEqual([...takenModelNames(models, 'demo', exists)].sort(), ['b_renamed']);
});

test('isValidModelName', () => {
  assert.ok(isValidModelName('fct_orders') && isValidModelName('_tmp1'));
  assert.ok(!isValidModelName('1abc') && !isValidModelName('has space') && !isValidModelName('a-b') && !isValidModelName(''));
});

test('stagingName follows stg_<source>__<table>, made safe', () => {
  assert.equal(stagingName('raw', 'orders'), 'stg_raw__orders');
  assert.equal(stagingName('Shop DB', 'Order-Items'), 'stg_shop_db__order_items');
});

test('stagingSql lists the columns, or falls back to select * with a TODO', () => {
  const sql = stagingSql('raw', 'orders', ['id', 'amount']);
  assert.match(sql, /select \* from \{\{ source\('raw', 'orders'\) \}\}/);
  assert.match(sql, /renamed as \(\n\n    select\n        id,\n        amount\n\n    from source\n\n\)/);
  assert.match(sql, /select \* from renamed\n$/);
  const empty = stagingSql('raw', 'orders', []);
  assert.match(empty, /-- TODO: list the columns/);
  assert.match(empty, /select \* from source/);
});

test('newModelSql: built-in skeleton, or the user template with {{name}} filled in', () => {
  assert.match(newModelSql('fct_x'), /ref\('replace_me'\)/);
  assert.equal(newModelSql('fct_x', '-- {{name}}\nselect 1 as {{name}}_id'), '-- fct_x\nselect 1 as fct_x_id');
  assert.equal(newModelSql('fct_x', 'select 1'), 'select 1');
});

test('docsFragment maps unique ids to dbt docs routes', () => {
  assert.equal(docsFragment('model.demo.b'), '!/model/model.demo.b');
  assert.equal(docsFragment('source.demo.raw.orders'), '!/source/source.demo.raw.orders');
  assert.equal(docsFragment('semantic_model.demo.sm'), '!/semantic_model/semantic_model.demo.sm');
  assert.equal(docsFragment('weird'), '!/overview');
});

test('debugSummary reads dbt 1.12 dbt debug output', () => {
  assert.deepEqual(debugSummary('02:20:21    Connection test: [OK connection ok]\n\n02:20:21  All checks passed!\n'), { ok: true, text: 'All checks passed!' });
  const failed = debugSummary(
    "02:24:26  Connection test skipped since no profile was found\n02:24:26  1 check failed:\n02:24:26  Profile loading failed for the following reason:\nRuntime Error\n  The profile 'demo' does not have a target named 'nope'.\n"
  );
  assert.equal(failed.ok, false);
  assert.match(failed.text, /^1 check failed: Profile loading failed for the following reason: Runtime Error The profile 'demo' does not have a target named 'nope'\./);
});

test('parseManifest lists exposures and semantic models, and puts semantic models in lineage', () => {
  const root = path.join('C:/p');
  const m = parseManifest(
    JSON.stringify({
      nodes: { 'model.demo.orders': { resource_type: 'model', name: 'orders', package_name: 'demo', original_file_path: 'models/orders.sql' } },
      exposures: { 'exposure.demo.dash': { name: 'dash', package_name: 'demo', original_file_path: 'models/exposures.yml' } },
      semantic_models: { 'semantic_model.demo.orders_sm': { name: 'orders_sm', package_name: 'demo', original_file_path: 'models/sm.yml' } },
      child_map: { 'model.demo.orders': ['semantic_model.demo.orders_sm', 'exposure.demo.dash'] }
    }),
    root,
    'demo'
  )!;
  assert.deepEqual(m.exposures.map(e => [e.name, e.file]), [['dash', path.join(root, 'models', 'exposures.yml')]]);
  assert.deepEqual(m.semanticModels.map(e => e.name), ['orders_sm']);
  assert.equal(m.nodes.get('semantic_model.demo.orders_sm')?.type, 'semantic_model');
});
