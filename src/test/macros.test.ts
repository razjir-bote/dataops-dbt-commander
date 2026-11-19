import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { macroDefinitionLine, macroFile, parseManifest, resolveMacro } from '../manifest';
import { macroCallAt } from '../jinja';

const root = path.join('C:/proj');
const include = path.join('C:/venv/Lib/site-packages/dbt/include');

test('macroFile maps each kind of package to its folder', () => {
  const exists = (p: string) => p === path.join(root, 'dbt_packages', 'dbt_utils');
  assert.equal(macroFile(root, 'demo', 'demo', 'macros\\money.sql', include, exists), path.join(root, 'macros', 'money.sql'));
  assert.equal(macroFile(root, 'demo', 'dbt_utils', 'macros/sql/star.sql', include, exists), path.join(root, 'dbt_packages', 'dbt_utils', 'macros', 'sql', 'star.sql'));
  assert.equal(macroFile(root, 'demo', 'dbt', 'macros\\etc\\statement.sql', include, exists), path.join(include, 'global_project', 'macros', 'etc', 'statement.sql'));
  assert.equal(macroFile(root, 'demo', 'dbt_duckdb', 'macros\\adapters.sql', include, exists), path.join(include, 'duckdb', 'macros', 'adapters.sql'));
  assert.equal(macroFile(root, 'demo', 'dbt', 'macros/x.sql', undefined, exists), undefined);
});

const manifest = JSON.stringify({
  nodes: {
    'model.demo.b': { resource_type: 'model', name: 'b', package_name: 'demo', original_file_path: 'models\\b.sql', patch_path: 'demo://models\\schema.yml' },
    'model.demo.c': { resource_type: 'model', name: 'c', package_name: 'demo', original_file_path: 'models\\c.sql', patch_path: null },
    'seed.demo.s': { resource_type: 'seed', name: 's', package_name: 'demo', original_file_path: 'seeds\\s.csv' },
    'snapshot.demo.snap': { resource_type: 'snapshot', name: 'snap', package_name: 'demo', original_file_path: 'snapshots\\snap.sql' },
    'test.demo.not_null_b_id.1': { resource_type: 'test', name: 'not_null_b_id', package_name: 'demo', original_file_path: 'models\\schema.yml', attached_node: 'model.demo.b' },
    'test.demo.assert_x.2': { resource_type: 'test', name: 'assert_x', package_name: 'demo', original_file_path: 'tests\\assert_x.sql', attached_node: null },
    'seed.pkg.other': { resource_type: 'seed', name: 'other', package_name: 'pkg', original_file_path: 'seeds/other.csv' }
  },
  sources: {},
  macros: {
    'macro.demo.cents_to_dollars': { name: 'cents_to_dollars', package_name: 'demo', original_file_path: 'macros\\money.sql' },
    'macro.dbt.current_timestamp': { name: 'current_timestamp', package_name: 'dbt', original_file_path: 'macros\\adapters\\timestamps.sql' },
    'macro.dbt_utils.current_timestamp': { name: 'current_timestamp', package_name: 'dbt_utils', original_file_path: 'macros/ts.sql' },
    'macro.dbt_utils.star': { name: 'star', package_name: 'dbt_utils', original_file_path: 'macros/sql/star.sql' }
  }
});

test('parseManifest collects macros, seeds, snapshots, tests and YAML patches', () => {
  const m = parseManifest(manifest, root, 'demo', include)!;
  assert.deepEqual(m.macros.map(x => `${x.package}.${x.name}`).sort(), ['dbt.current_timestamp', 'dbt_utils.current_timestamp', 'dbt_utils.star', 'demo.cents_to_dollars']);
  assert.deepEqual(m.seeds.map(s => s.name), ['s']); // root package only
  assert.deepEqual(m.snapshots.map(s => [s.name, s.file]), [['snap', path.join(root, 'snapshots', 'snap.sql')]]);
  assert.deepEqual(m.tests.map(t => [t.name, t.attachedTo]), [['not_null_b_id', 'b'], ['assert_x', undefined]]);
  assert.equal(m.patches.get('b'), path.join(root, 'models', 'schema.yml'));
  assert.equal(m.patches.has('c'), false);
});

test('resolveMacro follows dbt: named package, else the project, then dbt internals (not other packages)', () => {
  const { macros } = parseManifest(manifest, root, 'demo', include)!;
  assert.equal(resolveMacro(macros, 'current_timestamp', undefined, 'demo')?.package, 'dbt');
  assert.equal(resolveMacro(macros, 'current_timestamp', 'dbt_utils')?.package, 'dbt_utils');
  assert.equal(resolveMacro(macros, 'star', undefined, 'demo'), undefined); // dbt_utils macros need `dbt_utils.`
  assert.equal(resolveMacro(macros, 'current_timestamp', 'dbt')?.package, 'dbt');
  assert.equal(resolveMacro(macros, 'cents_to_dollars', undefined, 'demo')?.package, 'demo');
  assert.equal(resolveMacro(macros, 'star', 'dbt_utils')?.name, 'star');
  assert.equal(resolveMacro(macros, 'nope'), undefined);
  const withOverride = [...macros, { name: 'star', package: 'demo', file: path.join(root, 'macros', 'star.sql') }];
  assert.equal(resolveMacro(withOverride, 'star', undefined, 'demo')?.package, 'demo');
});

test('macroDefinitionLine finds the macro tag, with or without whitespace control', () => {
  const text = "{# helpers #}\n\n{%- macro cents_to_dollars(col) -%}\n  ({{ col }} / 100)\n{% endmacro %}\n{% macro other() %}{% endmacro %}";
  assert.equal(macroDefinitionLine(text, 'cents_to_dollars'), 2);
  assert.equal(macroDefinitionLine(text, 'other'), 5);
  assert.equal(macroDefinitionLine(text, 'missing'), 0);
});

test('macroCallAt finds macro calls under the cursor', () => {
  const line = "select {{ cents_to_dollars ( 'amount' ) }}, {{ dbt_utils.star(from=ref('b')) }}";
  assert.deepEqual(macroCallAt(line, line.indexOf('cents')), { name: 'cents_to_dollars' });
  assert.deepEqual(macroCallAt(line, line.indexOf('star')), { package: 'dbt_utils', name: 'star' });
  assert.deepEqual(macroCallAt(line, line.indexOf('dbt_utils')), { package: 'dbt_utils', name: 'star' });
  assert.deepEqual(macroCallAt('{%- call my_block() -%}', 10), { name: 'my_block' });
  assert.equal(macroCallAt("{{ ref('b') }}", 4), undefined);
  assert.equal(macroCallAt("{{ config(materialized='table') }}", 4), undefined);
  assert.equal(macroCallAt("{{ var('x') }}", 4), undefined);
  assert.equal(macroCallAt('select 1', 3), undefined);
});

test('macroCallAt ignores plain SQL function calls outside Jinja', () => {
  const line = "select concat(a, b), current_timestamp() from {{ ref('b') }} where {{ dbt.date_trunc('day', 'x') }}";
  assert.equal(macroCallAt(line, line.indexOf('concat')), undefined);
  assert.equal(macroCallAt(line, line.indexOf('current_timestamp')), undefined);
  assert.deepEqual(macroCallAt(line, line.indexOf('date_trunc')), { package: 'dbt', name: 'date_trunc' });
});

test('source tests are grouped under their source; singular tests keep their .sql file', () => {
  const m = parseManifest(
    JSON.stringify({
      nodes: {
        'test.demo.src_nn.1': { resource_type: 'test', name: 'src_nn', package_name: 'demo', original_file_path: 'models/sources.yml', attached_node: null, depends_on: { nodes: ['source.demo.raw.orders'] } },
        'test.demo.assert_x.2': { resource_type: 'test', name: 'assert_x', package_name: 'demo', original_file_path: 'tests/assert_x.sql', attached_node: null, depends_on: { nodes: ['model.demo.b'] } }
      },
      sources: { 'source.pkg.raw.t': { source_name: 'raw', name: 't', package_name: 'pkg', original_file_path: 'models/s.yml' } }
    }),
    root,
    'demo'
  )!;
  assert.deepEqual(m.tests.map(t => [t.name, t.attachedTo]), [['src_nn', 'raw.orders'], ['assert_x', undefined]]);
  assert.equal(m.sources[0].package, 'pkg');
});
