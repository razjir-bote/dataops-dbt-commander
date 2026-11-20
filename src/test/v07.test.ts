import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPaths, resourcePaths } from '../projectconfig';
import { parseManifest } from '../manifest';
import { mergeResults, rootKey, runSummary, slowest, statusBadge, NodeRun } from '../runstate';
import { aliasBefore, aliasesIn, refLines } from '../columns';
import { findProjectRoot, isUnderPackages } from '../dbt';

test('projectPaths: dbt 1.x defaults', () => {
  assert.deepEqual(projectPaths('name: demo\n'), {
    model: ['models'], seed: ['seeds'], snapshot: ['snapshots'], analysis: ['analyses'], macro: ['macros'], test: ['tests'],
    packagesInstall: 'dbt_packages', target: 'target'
  });
});

test('projectPaths: custom folders normalised (./ prefix, trailing slash, backslashes)', () => {
  const p = projectPaths(
    'name: demo\nmodel-paths: ["./transform/", "marts"]\nseed-paths: [data]\nsnapshot-paths: ["snaps\\\\"]\npackages-install-path: deps/pkgs\ntarget-path: "build"\n'
  );
  assert.deepEqual(p.model, ['transform', 'marts']);
  assert.deepEqual(p.seed, ['data']);
  assert.deepEqual(p.snapshot, ['snaps']);
  assert.equal(p.packagesInstall, 'deps/pkgs');
  assert.equal(p.target, 'build');
  assert.deepEqual(projectPaths(': bad [').model, ['models']);
});

const rr = (which: string, generated: string, results: { id: string; status: string; t?: number }[]) =>
  JSON.stringify({
    metadata: { invocation_id: generated, generated_at: generated },
    args: { which },
    elapsed_time: 12.5,
    results: results.map(r => ({ unique_id: r.id, status: r.status, execution_time: r.t ?? 0.5, message: r.status === 'error' ? 'boom' : null }))
  });

test('mergeResults keeps the newest result per node and ignores compile/docs runs', () => {
  let state: Record<string, NodeRun> = {};
  state = mergeResults(state, rr('build', '2026-11-21T10:00:00Z', [{ id: 'model.d.a', status: 'success', t: 1.2 }, { id: 'model.d.b', status: 'error' }]));
  state = mergeResults(state, rr('run', '2026-11-21T10:05:00Z', [{ id: 'model.d.b', status: 'success', t: 0.3 }]));
  state = mergeResults(state, rr('compile', '2026-11-21T10:06:00Z', [{ id: 'model.d.a', status: 'success' }]));
  state = mergeResults(state, rr('build', '2026-11-21T09:00:00Z', [{ id: 'model.d.a', status: 'error' }])); // older file
  assert.deepEqual(state['model.d.a'], { status: 'success', at: Date.parse('2026-11-21T10:00:00Z'), seconds: 1.2 });
  assert.deepEqual(state['model.d.b'], { status: 'success', at: Date.parse('2026-11-21T10:05:00Z'), seconds: 0.3 });
  assert.equal(Object.keys(mergeResults(state, 'garbage')).length, 2);
});

test('statusBadge: short, readable', () => {
  const now = Date.parse('2026-11-21T10:10:00Z');
  assert.equal(statusBadge({ status: 'success', at: now - 3 * 60_000, seconds: 1.234 }, now), '✓ 3m ago · 1.2s');
  assert.equal(statusBadge({ status: 'pass', at: now - 30_000, seconds: 0.02 }, now), '✓ just now · 0.0s');
  assert.equal(statusBadge({ status: 'error', at: now - 2 * 3_600_000, seconds: 0.4 }, now), '✗ error 2h ago');
  assert.equal(statusBadge({ status: 'fail', at: now - 3 * 86_400_000 }, now), '✗ fail 3d ago');
  assert.equal(statusBadge({ status: 'warn', at: now - 60_000, seconds: 1 }, now), '⚠ warn 1m ago · 1.0s');
  assert.equal(statusBadge({ status: 'skipped', at: now - 60_000 }, now), '– skipped 1m ago');
});

test('runSummary and slowest', () => {
  const json = rr('build', '2026-11-21T10:00:00Z', [
    { id: 'model.d.a', status: 'success', t: 2 },
    { id: 'model.d.b', status: 'error', t: 0.1 },
    { id: 'test.d.t1', status: 'pass', t: 5 },
    { id: 'test.d.t2', status: 'fail', t: 0.2 },
    { id: 'seed.d.s', status: 'skipped', t: 0 }
  ]);
  const s = runSummary(json)!;
  assert.deepEqual([s.which, s.ok, s.errors, s.warnings, s.skipped, s.total, s.seconds], ['build', 2, 2, 0, 1, 5, 12.5]);
  assert.equal(s.text, 'dbt build finished: 2 passed, 2 failed, 1 skipped (12.5s)');
  assert.deepEqual(slowest(json).map(r => r.uniqueId), ['test.d.t1', 'model.d.a', 'test.d.t2', 'model.d.b', 'seed.d.s']);
  assert.equal(runSummary('x'), undefined);
});

test('aliasesIn finds ref/source aliases (as optional, multi-line, quotes)', () => {
  const sql = [
    'with x as (select 1)',
    "select o.id, c.name from {{ ref('orders') }} o",
    'left join {{ ref("customers") }} as c on c.id = o.cid',
    "join {{ source('raw', 'payments') }}",
    '  p on p.order_id = o.id',
    "join {{ ref('pkg', 'helper') }} h on true"
  ].join('\n');
  const a = aliasesIn(sql);
  assert.deepEqual(a.get('o'), { kind: 'ref', name: 'orders' });
  assert.deepEqual(a.get('c'), { kind: 'ref', name: 'customers' });
  assert.deepEqual(a.get('p'), { kind: 'source', source: 'raw', table: 'payments' });
  assert.deepEqual(a.get('h'), { kind: 'ref', name: 'helper', package: 'pkg' });
  assert.equal(a.has('on'), false);
});

test('aliasBefore: the alias typed right before the cursor', () => {
  assert.equal(aliasBefore('select o.'), 'o');
  assert.equal(aliasBefore('select o.na'), 'o');
  assert.equal(aliasBefore('select orders_x.'), 'orders_x');
  assert.equal(aliasBefore('select 1.'), undefined);
  assert.equal(aliasBefore('select o'), undefined);
});

test('refLines: lines that ref a model, any quoting / package', () => {
  const sql = "select 1\nfrom {{ ref('orders') }}\njoin {{ ref(\"orders\") }}\njoin {{ ref('pkg', 'orders') }}\njoin {{ ref('orders_v2') }}";
  assert.deepEqual(refLines(sql, 'orders'), [1, 2, 3]);
  assert.deepEqual(refLines(sql, 'nope'), []);
});

test('parseManifest resolves installed packages under a custom packages-install-path', () => {
  const root = require('path').join('C:/p');
  const json = JSON.stringify({
    nodes: { 'model.utils.helper': { resource_type: 'model', name: 'helper', package_name: 'utils', original_file_path: 'models/helper.sql' } },
    macros: { 'macro.utils.star': { name: 'star', package_name: 'utils', original_file_path: 'macros/star.sql' } }
  });
  const exists = (p: string) => p === require('path').join(root, 'deps', 'pkgs', 'utils');
  const m = parseManifest(json, root, 'demo', undefined, exists, 'deps/pkgs')!;
  assert.equal(m.models[0].file, require('path').join(root, 'deps', 'pkgs', 'utils', 'models', 'helper.sql'));
  assert.equal(m.macros[0].file, require('path').join(root, 'deps', 'pkgs', 'utils', 'macros', 'star.sql'));
});

test('resourcePaths lists configured folders, their subfolders and matching files', () => {
  const P = require('path');
  const root = P.join('C:/p');
  const tree: Record<string, { name: string; dir: boolean }[]> = {
    [P.join(root, 'transform')]: [{ name: 'stg', dir: true }, { name: 'a.sql', dir: false }, { name: 'notes.md', dir: false }],
    [P.join(root, 'transform', 'stg')]: [{ name: 'b.sql', dir: false }],
    [P.join(root, 'marts')]: []
  };
  const list = (d: string) => tree[d];
  assert.deepEqual(resourcePaths(root, ['transform', 'marts', 'missing'], /\.sql$/i, list).sort(), [
    P.join(root, 'marts'),
    P.join(root, 'transform'),
    P.join(root, 'transform', 'a.sql'),
    P.join(root, 'transform', 'stg'),
    P.join(root, 'transform', 'stg', 'b.sql')
  ].sort());
});

test('findProjectRoot skips packages installed under a custom packages-install-path', () => {
  const P = require('path');
  const root = P.join('C:/p');
  const pkg = P.join(root, 'packages', 'utils');
  const exists = (f: string) => f === P.join(root, 'dbt_project.yml') || f === P.join(pkg, 'dbt_project.yml');
  const isPackageRoot = (d: string) => d === pkg;
  assert.equal(findProjectRoot(P.join(pkg, 'models', 'x.sql'), exists, undefined, isPackageRoot), root);
  assert.equal(findProjectRoot(P.join(pkg, 'models', 'x.sql'), exists), pkg); // without the check
});

test('isUnderPackages: a folder inside an ancestor project\'s packages-install-path', () => {
  const P = require('path');
  const root = P.join('C:/p');
  const has = (d: string) => d === root;
  const installOf = () => 'deps/pkgs';
  assert.equal(isUnderPackages(P.join(root, 'deps', 'pkgs', 'utils'), has, installOf), true);
  assert.equal(isUnderPackages(P.join(root, 'models'), has, installOf), false);
  assert.equal(isUnderPackages(root, has, installOf), false);
});

test('projectPaths: Jinja in a path falls back to the default', () => {
  assert.deepEqual(projectPaths('model-paths: ["{{ env_var(\'X\') }}"]\n').model, ['models']);
  assert.deepEqual(projectPaths('model-paths: ["{{ env_var(\'X\') }}", "marts"]\n').model, ['marts']);
});

test('aliasesIn / lookups are case-insensitive', () => {
  const a = aliasesIn("select O.id from {{ ref('orders') }} O");
  assert.deepEqual(a.get('o'), { kind: 'ref', name: 'orders' });
});

test('rootKey: the same project from VS Code (c:) and Node (C:) maps to one key', () => {
  const P = require('path');
  assert.equal(rootKey(P.join('C:/vscode_dbt/demo')), rootKey(P.join('c:/vscode_dbt/demo') + P.sep));
  assert.equal(rootKey('C:/vscode_dbt/demo'), rootKey(P.join('c:/vscode_dbt/demo')));
});
