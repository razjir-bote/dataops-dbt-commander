import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { listTargets, parseProjectFile, profilesDirCandidates } from '../profiles';

test('parseProjectFile reads name, profile and target-path', () => {
  assert.deepEqual(parseProjectFile("name: demo\nversion: '1.0'\nprofile: demo_prof\ntarget-path: build\n"), {
    name: 'demo',
    profile: 'demo_prof',
    targetPath: 'build'
  });
  assert.deepEqual(parseProjectFile('name: x\n'), { name: 'x', profile: undefined, targetPath: undefined });
  assert.deepEqual(parseProjectFile(': : not yaml ['), {});
});

test('profilesDirCandidates follows dbt 1.x lookup order', () => {
  const root = path.join('C:/proj');
  assert.deepEqual(
    profilesDirCandidates(root, '--vars "{a: 1}" --profiles-dir ./conf', { DBT_PROFILES_DIR: 'D:/profiles' }, 'C:/Users/u'),
    [path.resolve(root, './conf'), path.resolve('D:/profiles'), root, path.join('C:/Users/u', '.dbt')]
  );
  assert.deepEqual(profilesDirCandidates(root, '', {}, 'C:/Users/u'), [root, path.join('C:/Users/u', '.dbt')]);
  assert.deepEqual(profilesDirCandidates(root, '--profiles-dir=conf', {}, 'C:/Users/u')[0], path.resolve(root, 'conf'));
});

test('listTargets lists outputs and the default, even with Jinja values', () => {
  const profiles = [
    'demo:',
    '  target: dev',
    '  outputs:',
    '    dev:',
    '      type: duckdb',
    "      path: \"{{ env_var('DUCK_PATH') }}\"",
    '    prod:',
    '      type: snowflake',
    "      password: \"{{ env_var('SNOW_PW') }}\"",
    'other:',
    '  outputs:',
    '    x: {type: duckdb}'
  ].join('\n');
  assert.deepEqual(listTargets(profiles, 'demo'), { targets: ['dev', 'prod'], defaultTarget: 'dev' });
  assert.deepEqual(listTargets(profiles, 'other'), { targets: ['x'], defaultTarget: undefined });
  assert.equal(listTargets(profiles, 'missing'), undefined);
});
