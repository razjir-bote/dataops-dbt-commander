import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yamlContextAt } from '../yamlcontext';
import { YamlData, columnOwnerOf, materializationsFrom, suggestionsFor } from '../yamlcomplete';

const data: YamlData = {
  models: [
    { name: 'orders', documented: true },
    { name: 'customers', documented: false }
  ],
  seeds: ['countries'],
  snapshots: ['snap'],
  macros: ['cents_to_dollars'],
  genericTests: ['dbt_utils.expression_is_true', 'positive_value'],
  materializations: ['view', 'table', 'incremental', 'ephemeral', 'materialized_view', 'my_custom'],
  columns: [
    { name: 'id', dataType: 'INTEGER' },
    { name: 'status', dataType: 'VARCHAR' }
  ],
  legacyArguments: false
};

function sug(text: string, d: YamlData = data) {
  const lines = text.split('\n');
  const line = lines.findIndex(l => l.includes('|'));
  return suggestionsFor(yamlContextAt(text.replace('|', ''), line, lines[line].indexOf('|')), d);
}
const labels = (s: ReturnType<typeof sug>) => s.map(x => x.label);
const doc = (...l: string[]) => l.join('\n');

test('top-level keys, minus the ones already there', () => {
  const l = labels(sug(doc('version: 2', '|')));
  assert.ok(l.includes('models') && l.includes('sources') && l.includes('unit_tests'));
  assert.ok(!l.includes('version'));
});

test('model names: undocumented first', () => {
  const s = sug(doc('models:', '  - name: |'));
  assert.deepEqual(labels(s), ['customers', 'orders']);
  assert.match(s[0].detail ?? '', /no YAML entry yet/);
});

test('model keys, without existing ones; data_tests hides tests', () => {
  const l = labels(sug(doc('models:', '  - name: orders', '    |', '    data_tests: []')));
  assert.ok(l.includes('description') && l.includes('columns') && l.includes('config'));
  assert.ok(!l.includes('name') && !l.includes('data_tests') && !l.includes('tests'));
});

test('column names without the listed ones, with types', () => {
  const s = sug(doc('models:', '  - name: orders', '    columns:', '      - name: id', '      - name: |'));
  assert.deepEqual(labels(s), ['status']);
  assert.equal(s[0].detail, 'VARCHAR');
});

test('column keys inside a column', () => {
  const l = labels(sug(doc('models:', '  - name: orders', '    columns:', '      - name: id', '        |')));
  assert.ok(l.includes('data_type') && l.includes('data_tests') && l.includes('description'));
});

test('tests: built-ins first, then package / project generic tests; snippets with arguments', () => {
  const s = sug(doc('models:', '  - name: o', '    columns:', '      - name: id', '        data_tests:', '          - |'));
  assert.deepEqual(labels(s).slice(0, 4), ['not_null', 'unique', 'accepted_values', 'relationships']);
  assert.ok(labels(s).includes('dbt_utils.expression_is_true') && labels(s).includes('positive_value'));
  const av = s.find(x => x.label === 'accepted_values')!;
  assert.equal(av.snippet, 'accepted_values:\n    arguments:\n      values: [${1}]');
  const legacy = sug(doc('models:', '  - name: o', '    data_tests:', '      - |'), { ...data, legacyArguments: true }).find(x => x.label === 'relationships')!;
  assert.equal(legacy.snippet, "relationships:\n    to: ref('${1}')\n    field: ${2}");
});

test('config keys and values', () => {
  assert.ok(labels(sug(doc('models:', '  - name: o', '    config:', '      |'))).includes('materialized'));
  assert.deepEqual(labels(sug(doc('models:', '  - name: o', '    config:', '      materialized: |'))), [
    'view', 'table', 'incremental', 'ephemeral', 'materialized_view', 'my_custom'
  ]);
  assert.deepEqual(labels(sug(doc('models:', '  - name: o', '    config:', '      on_schema_change: |'))), [
    'ignore', 'append_new_columns', 'sync_all_columns', 'fail'
  ]);
});

test('seed / snapshot / macro names; unit test model', () => {
  assert.deepEqual(labels(sug(doc('seeds:', '  - name: |'))), ['countries']);
  assert.deepEqual(labels(sug(doc('snapshots:', '  - name: |'))), ['snap']);
  assert.deepEqual(labels(sug(doc('macros:', '  - name: |'))), ['cents_to_dollars']);
  assert.deepEqual(labels(sug(doc('unit_tests:', '  - name: t', '    model: |'))), ['customers', 'orders']);
});

test('a list item under models suggests the item keys (name first)', () => {
  assert.equal(labels(sug(doc('models:', '  - |')))[0], 'name');
});

test('columnOwnerOf: model, seed, snapshot, source table — only for a column name', () => {
  const owner = (t: string) => {
    const lines = t.split('\n');
    const line = lines.findIndex(l => l.includes('|'));
    return columnOwnerOf(yamlContextAt(t.replace('|', ''), line, lines[line].indexOf('|')));
  };
  assert.deepEqual(owner(doc('models:', '  - name: orders', '    columns:', '      - name: |')), { kind: 'model', name: 'orders' });
  assert.deepEqual(owner(doc('seeds:', '  - name: countries', '    columns:', '      - name: |')), { kind: 'seed', name: 'countries' });
  assert.deepEqual(owner(doc('sources:', '  - name: raw', '    tables:', '      - name: o', '        columns:', '          - name: |')), {
    kind: 'source', source: 'raw', name: 'o'
  });
  assert.equal(owner(doc('models:', '  - name: |')), undefined);
});

test('materializationsFrom: built-ins plus custom materialization macros, not test / seed / snapshot', () => {
  assert.deepEqual(
    materializationsFrom(['materialization_table_default', 'materialization_my_custom_default', 'materialization_seed_default', 'materialization_incremental_duckdb', 'other']),
    ['view', 'table', 'incremental', 'ephemeral', 'materialized_view', 'my_custom']
  );
});

test('models already listed in the file are not suggested again', () => {
  assert.deepEqual(labels(sug(doc('models:', '  - name: customers', '  - name: |'))), ['orders']);
});

test('versioned model columns: owner is the model', () => {
  const lines = ['models:', '  - name: dim', '    versions:', '      - v: 2', '        columns:', '          - name: |'];
  const t = lines.join('\n');
  const line = lines.findIndex(l => l.includes('|'));
  assert.deepEqual(columnOwnerOf(yamlContextAt(t.replace('|', ''), line, lines[line].indexOf('|'))), { kind: 'model', name: 'dim' });
  assert.ok(labels(sug(doc('models:', '  - name: dim', '    versions:', '      - v: 2', '        |'))).includes('columns'));
});

test('materializationsFrom: only the _default or this adapter suffix', () => {
  assert.deepEqual(materializationsFrom(['materialization_table_sql_server', 'materialization_custom_sql_server', 'materialization_x_duckdb'], 'sql_server'), [
    'view', 'table', 'incremental', 'ephemeral', 'materialized_view', 'custom'
  ]);
});

test('a map key on a list-item line indents its body under the item', () => {
  const s = sug(doc('models:', '  - name: o', '    data_tests:', '      - x', '  - |'));
  assert.equal(s.find(x => x.label === 'config')?.snippet, 'config:\n    ${0}');
});

test('parseManifest marks generic tests by their {% test %} definition, not their name', () => {
  const idx = require('../manifest').parseManifest(
    JSON.stringify({
      macros: {
        'macro.demo.test_positive': { name: 'test_positive', package_name: 'demo', original_file_path: 'tests/generic/p.sql', macro_sql: '{% test positive(model, column_name) %}select 1{% endtest %}' },
        'macro.demo.test_connection': { name: 'test_connection', package_name: 'demo', original_file_path: 'macros/c.sql', macro_sql: '{% macro test_connection() %}{% endmacro %}' }
      }
    }),
    require('path').resolve('p'),
    'demo'
  );
  assert.deepEqual(idx.macros.filter((m: any) => m.test).map((m: any) => m.name), ['test_positive']);
});
