import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { parseManifest, resolveRef, sourceTableLine } from '../manifest';

test('sourceTableLine finds the table under the right source, ignoring earlier same-named keys', () => {
  const yml = [
    'version: 2',            // 0
    'models:',               // 1
    '  - name: customers',   // 2  <- same name as a source table, must be ignored
    '    columns:',          // 3
    '      - name: raw',     // 4  <- same name as the source, must be ignored
    'sources:',              // 5
    '  - name: other',       // 6
    '    tables:',           // 7
    '      - name: customers', // 8
    '  - name: raw',         // 9
    '    tables:',           // 10
    '      - name: orders',  // 11
    "      - name: 'customers'" // 12
  ].join('\n');
  assert.equal(sourceTableLine(yml, 'raw', 'customers'), 12);
  assert.equal(sourceTableLine(yml, 'raw', 'orders'), 11);
  assert.equal(sourceTableLine(yml, 'other', 'customers'), 8);
  assert.equal(sourceTableLine(yml, 'raw', 'missing'), 9);
});

const root = path.join('C:/proj');
const manifest = JSON.stringify({
  nodes: {
    'model.demo.b': { resource_type: 'model', name: 'b', package_name: 'demo', original_file_path: 'models\\b.sql', version: null },
    'model.demo.orders.v1': { resource_type: 'model', name: 'orders', package_name: 'demo', original_file_path: 'models/orders_v1.sql', version: 1, latest_version: 2 },
    'model.demo.orders.v2': { resource_type: 'model', name: 'orders', package_name: 'demo', original_file_path: 'models/orders_v2.sql', version: 2, latest_version: 2 },
    'model.utils.helper': { resource_type: 'model', name: 'helper', package_name: 'utils', original_file_path: 'models/helper.sql', version: null },
    'test.demo.not_null_b_id.123': { resource_type: 'test', name: 'not_null_b_id', package_name: 'demo', original_file_path: 'models/schema.yml' }
  },
  sources: {
    'source.demo.raw.orders': { source_name: 'raw', name: 'orders', package_name: 'demo', original_file_path: 'models\\src\\sources.yml' }
  }
});

test('parseManifest returns models with absolute paths, packages under dbt_packages', () => {
  const m = parseManifest(manifest, root, 'demo')!;
  assert.deepEqual(m.models.map(x => [x.name, x.package, x.file]), [
    ['b', 'demo', path.join(root, 'models', 'b.sql')],
    ['orders', 'demo', path.join(root, 'models', 'orders_v1.sql')],
    ['orders', 'demo', path.join(root, 'models', 'orders_v2.sql')],
    ['helper', 'utils', path.join(root, 'dbt_packages', 'utils', 'models', 'helper.sql')]
  ]);
  assert.deepEqual(m.sources, [{ source: 'raw', table: 'orders', package: 'demo', file: path.join(root, 'models', 'src', 'sources.yml') }]);
});

test('parseManifest tolerates bad input', () => {
  assert.equal(parseManifest('nope', root, 'demo'), undefined);
});

test('resolveRef handles package, versions and latest_version', () => {
  const { models } = parseManifest(manifest, root, 'demo')!;
  assert.equal(resolveRef(models, 'b')?.file, path.join(root, 'models', 'b.sql'));
  assert.equal(resolveRef(models, 'orders')?.file, path.join(root, 'models', 'orders_v2.sql'));
  assert.equal(resolveRef(models, 'orders', undefined, '1')?.file, path.join(root, 'models', 'orders_v1.sql'));
  assert.equal(resolveRef(models, 'helper', 'utils')?.package, 'utils');
  assert.equal(resolveRef(models, 'helper', 'demo'), undefined);
  assert.equal(resolveRef(models, 'missing'), undefined);
});
