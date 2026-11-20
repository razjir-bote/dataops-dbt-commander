import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plannedMigrations } from '../migrate';

test('plannedMigrations copies old dbtRunner.* values that the new key does not have yet', () => {
  const old: Record<string, Record<string, unknown>> = {
    global: { venvPath: 'C:/venv', target: 'dev' },
    workspace: { venvPath: 'C:/proj/.venv', extraArgs: '--vars x' }
  };
  const now: Record<string, Record<string, unknown>> = {
    global: { target: 'prod' }, // already set under the new name: keep it
    workspace: {}
  };
  const plan = plannedMigrations(
    ['venvPath', 'target', 'extraArgs', 'previewLimit'],
    (scope, key) => old[scope][key],
    (scope, key) => now[scope][key]
  );
  assert.deepEqual(plan, [
    { scope: 'global', key: 'venvPath', value: 'C:/venv' },
    { scope: 'workspace', key: 'venvPath', value: 'C:/proj/.venv' },
    { scope: 'workspace', key: 'extraArgs', value: '--vars x' }
  ]);
});

test('plannedMigrations does nothing when there is nothing old', () => {
  assert.deepEqual(plannedMigrations(['venvPath'], () => undefined, () => undefined), []);
});
