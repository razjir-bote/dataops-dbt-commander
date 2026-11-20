import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { buildArgs, dbtExecutable, findProjectRoot, folderSelectors, groupByProject, modelName, modelSelector, parseDbtVersion, splitArgs, withGraph } from '../dbt';

test('withGraph adds dbt graph operators', () => {
  assert.equal(withGraph('path:models/a.sql', 'none'), 'path:models/a.sql');
  assert.equal(withGraph('path:models/a.sql', 'upstream'), '+path:models/a.sql');
  assert.equal(withGraph('path:models/a.sql', 'downstream'), 'path:models/a.sql+');
  assert.equal(withGraph('path:models/a.sql', 'both'), '+path:models/a.sql+');
});

test('findProjectRoot finds dbt_project.yml above a nested model', () => {
  const root = path.join('C:/p');
  const marker = path.join(root, 'dbt_project.yml');
  assert.equal(findProjectRoot('C:/p/models/staging/a.sql', p => p === marker), root);
});

test('findProjectRoot returns undefined when no project file exists', () => {
  assert.equal(findProjectRoot('C:/p/models/a.sql', () => false), undefined);
});

test('modelName strips folder and .sql', () => {
  assert.equal(modelName('C:/p/models/stg_orders.sql'), 'stg_orders');
});

test('buildArgs includes select, target and split extra args', () => {
  assert.deepEqual(
    buildArgs('build', ['a', 'b'], 'dev', '--full-refresh  --fail-fast'),
    ['build', '--select', 'a', 'b', '--target', 'dev', '--full-refresh', '--fail-fast']
  );
});

test('buildArgs omits blank target and extra args', () => {
  assert.deepEqual(buildArgs('run', ['a'], '  ', '  '), ['run', '--select', 'a']);
});

test('buildArgs with no selectors runs the whole project (no dangling --select)', () => {
  assert.deepEqual(buildArgs('build', [], 'dev', ''), ['build', '--target', 'dev']);
  assert.deepEqual(buildArgs('seed', [], '', '--full-refresh'), ['seed', '--full-refresh']);
});

test('folderSelectors: the project root itself means "everything" (dbt rejects path:.)', () => {
  const root = path.join('C:/p');
  assert.deepEqual(folderSelectors(root, [path.join(root, 'seeds', 'ref')]), ['path:seeds/ref']);
  assert.deepEqual(folderSelectors(root, [path.join(root, 'models'), root]), []);
  assert.deepEqual(folderSelectors(root, [path.join('C:/P') + path.sep]), []);
});

test('dbtExecutable handles venv paths with spaces', () => {
  const venv = 'C:\\My Envs\\dbt';
  assert.equal(
    dbtExecutable(venv, p => p.endsWith(path.join('Scripts', 'dbt.exe'))),
    path.join(venv, 'Scripts', 'dbt.exe')
  );
});

test('dbtExecutable returns undefined when dbt is missing', () => {
  assert.equal(dbtExecutable('C:\\venv', () => false), undefined);
  assert.equal(dbtExecutable('   ', () => true), undefined);
});

test('parseDbtVersion reads dbt-core 1.x output', () => {
  assert.deepEqual(
    parseDbtVersion('Core:\n  - installed: 1.12.0\n  - latest:    1.12.1 - Update available!'),
    { version: '1.12.0', major: 1 }
  );
});

test('parseDbtVersion detects dbt fusion as major 2', () => {
  assert.equal(parseDbtVersion('dbt-fusion 2.0.0-preview.45')?.major, 2);
});

test('parseDbtVersion returns undefined for unrecognised output', () => {
  assert.equal(parseDbtVersion('garbage'), undefined);
});

test('groupByProject separates models from different projects and flags orphans', () => {
  const a = path.join('C:/a'), b = path.join('C:/b');
  const exists = (p: string) => p === path.join(a, 'dbt_project.yml') || p === path.join(b, 'dbt_project.yml');
  const groups = groupByProject(['C:/a/models/x.sql', 'C:/a/models/s/y.sql', 'C:/b/models/z.sql', 'C:/c/models/q.sql'], exists);
  assert.deepEqual(groups.projects.get(a), ['C:/a/models/x.sql', 'C:/a/models/s/y.sql']);
  assert.deepEqual(groups.projects.get(b), ['C:/b/models/z.sql']);
  assert.deepEqual(groups.orphans, ['C:/c/models/q.sql']);
});

test('modelSelector uses a path: selector relative to the project root', () => {
  assert.equal(modelSelector(path.join('C:/p'), path.join('C:/p/models/orders/orders.sql')), 'path:models/orders/orders.sql');
});

test('splitArgs keeps quoted values together', () => {
  assert.deepEqual(splitArgs(`--vars '{"key": "value"}'  --full-refresh`), ['--vars', '{"key": "value"}', '--full-refresh']);
  assert.deepEqual(splitArgs('--vars "{a: 1}"'), ['--vars', '{a: 1}']);
  assert.deepEqual(splitArgs('   '), []);
});

test('buildArgs passes selectors and quoted extra args through', () => {
  assert.deepEqual(buildArgs('run', ['path:models/a.sql'], '', `--vars '{"k": 1}'`), ['run', '--select', 'path:models/a.sql', '--vars', '{"k": 1}']);
});

test('findProjectRoot skips projects inside dbt_packages', () => {
  const root = path.join('C:/p');
  const ok = (p: string) => p === path.join(root, 'dbt_project.yml') || p === path.join('C:/p/dbt_packages/pkg/dbt_project.yml');
  assert.equal(findProjectRoot('C:/p/dbt_packages/pkg/models/x.sql', ok), root);
});

test('findProjectRoot does not walk above stopAt', () => {
  const ok = (p: string) => p === path.join('C:/home', 'dbt_project.yml');
  assert.equal(findProjectRoot('C:/home/work/models/x.sql', ok, path.join('C:/home/work')), undefined);
});
