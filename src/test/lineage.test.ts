import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { parseManifest, relatives } from '../manifest';
import { levelOf, sectionTargets } from '../tree';

const root = path.join('C:/p');
const manifest = JSON.stringify({
  nodes: {
    'model.demo.stg_a': { resource_type: 'model', name: 'stg_a', package_name: 'demo', original_file_path: 'models\\staging\\stg_a.sql' },
    'model.demo.b': { resource_type: 'model', name: 'b', package_name: 'demo', original_file_path: 'models\\b.sql' },
    'model.demo.c': { resource_type: 'model', name: 'c', package_name: 'demo', original_file_path: 'models\\c.sql' },
    'seed.demo.s': { resource_type: 'seed', name: 's', package_name: 'demo', original_file_path: 'seeds\\s.csv' },
    'snapshot.demo.snap': { resource_type: 'snapshot', name: 'snap', package_name: 'demo', original_file_path: 'snapshots\\snap.sql' },
    'test.demo.not_null_b_id.1': { resource_type: 'test', name: 'not_null_b_id', package_name: 'demo', original_file_path: 'models\\schema.yml' }
  },
  sources: { 'source.demo.raw.orders': { source_name: 'raw', name: 'orders', package_name: 'demo', original_file_path: 'models\\sources.yml' } },
  exposures: { 'exposure.demo.dash': { name: 'dash', package_name: 'demo', original_file_path: 'models\\exposures.yml' } },
  parent_map: {
    'model.demo.b': ['model.demo.stg_a', 'seed.demo.s', 'source.demo.raw.orders', 'model.demo.disabled'],
    'model.demo.c': ['model.demo.b'],
    'exposure.demo.dash': ['model.demo.c'],
    'snapshot.demo.snap': ['model.demo.b']
  },
  child_map: {
    'model.demo.b': ['model.demo.c', 'test.demo.not_null_b_id.1', 'snapshot.demo.snap'],
    'model.demo.c': ['exposure.demo.dash'],
    'model.demo.stg_a': ['model.demo.b']
  }
});

test('relatives: upstream includes models, seeds and sources; skips unknown (disabled) nodes', () => {
  const m = parseManifest(manifest, root, 'demo')!;
  const up = relatives(m, 'model.demo.b', 'up');
  assert.deepEqual(up.map(n => [n.type, n.name]), [['source', 'raw.orders'], ['model', 'stg_a'], ['seed', 's']].sort((a, b) => a[1].localeCompare(b[1])));
  const src = up.find(n => n.type === 'source')!;
  assert.deepEqual([src.source, src.table, src.file], ['raw', 'orders', path.join(root, 'models', 'sources.yml')]);
});

test('relatives: downstream includes models, snapshots, exposures but not tests', () => {
  const m = parseManifest(manifest, root, 'demo')!;
  assert.deepEqual(relatives(m, 'model.demo.b', 'down').map(n => n.name), ['c', 'snap']);
  assert.deepEqual(relatives(m, 'model.demo.c', 'down').map(n => [n.type, n.name, n.file]), [['exposure', 'dash', path.join(root, 'models', 'exposures.yml')]]);
  assert.deepEqual(relatives(m, 'model.demo.nope', 'down'), []);
  assert.equal(m.nodes.get('model.demo.c')?.file, path.join(root, 'models', 'c.sql'));
});

test('sectionTargets: one top folder, or each top folder/file — never the whole project', () => {
  const one = [path.join(root, 'models', 'a.sql'), path.join(root, 'models', 'x', 'b.sql')];
  assert.deepEqual(sectionTargets(root, one), [path.join(root, 'models')]);
  const two = [path.join(root, 'models', 'a.sql'), path.join(root, 'marts', 'b.sql'), path.join(root, 'top.sql')];
  assert.deepEqual(sectionTargets(root, two), [path.join(root, 'marts'), path.join(root, 'models'), path.join(root, 'top.sql')]);
  assert.deepEqual(sectionTargets(root, []), []);
});

test('levelOf: folders then files directly inside a directory', () => {
  const files = [
    path.join(root, 'seeds', 's.csv'),
    path.join(root, 'seeds', 'ref', 'countries.csv'),
    path.join(root, 'seeds', 'ref', 'deep', 'x.csv'),
    path.join(root, 'data', 'other.csv')
  ];
  assert.deepEqual(levelOf(root, files, ''), { folders: ['data', 'seeds'], files: [] });
  assert.deepEqual(levelOf(root, files, 'seeds'), { folders: ['ref'], files: [path.join(root, 'seeds', 's.csv')] });
  assert.deepEqual(levelOf(root, files, 'seeds/ref'), { folders: ['deep'], files: [path.join(root, 'seeds', 'ref', 'countries.csv')] });
});
