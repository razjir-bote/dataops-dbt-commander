import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DbtActivity, ParseScheduler, firstError, parseTrigger } from '../autoparseCore';
import type { ProjectPaths } from '../projectconfig';

const PATHS: ProjectPaths = {
  model: ['models'],
  seed: ['seeds'],
  snapshot: ['snapshots'],
  analysis: ['analyses'],
  macro: ['macros'],
  test: ['tests'],
  packagesInstall: 'dbt_packages',
  target: 'target'
};

test('parseTrigger: project files dbt reads count; target / packages / logs / tooling never', () => {
  for (const rel of [
    'models/a.sql',
    'models/staging/_stg.yml',
    'models/staging/x.yaml',
    'models/docs.md',
    'models/py_model.py',
    'models/staging', // a folder created or deleted
    'seeds/s.csv',
    'snapshots/snap.sql',
    'macros/m.sql',
    'tests/t.sql',
    'analyses/a.sql',
    'dbt_project.yml',
    'packages.yml',
    'dependencies.yml',
    'selectors.yml'
  ]) {
    assert.equal(parseTrigger(rel, PATHS), true, rel);
  }
  for (const rel of [
    'target/manifest.json',
    'target/compiled/demo/models/a.sql',
    'dbt_packages/x/models/a.sql',
    'logs/dbt.log',
    'models/.git/HEAD',
    'models/__pycache__/x.pyc',
    'models/a.sql.swp',
    'README.md',
    'profiles.yml', // read per command, not part of the manifest
    'other/x.sql',
    '../outside/models/a.sql'
  ]) {
    assert.equal(parseTrigger(rel, PATHS), false, rel);
  }
  // Custom paths and Windows separators.
  const custom = { ...PATHS, model: ['transform/models'], target: 'build' };
  assert.equal(parseTrigger('transform\\models\\a.sql', custom), true);
  assert.equal(parseTrigger('models/a.sql', custom), false);
  assert.equal(parseTrigger('build/manifest.json', custom), false);
  // A model folder that contains the target folder (odd but possible): target still excluded.
  assert.equal(parseTrigger('target/x.sql', { ...PATHS, model: [''] }), false);
});

test('DbtActivity: busy per project and kind, idle waits, end is idempotent', async () => {
  const a = new DbtActivity();
  assert.equal(a.busy('C:/p'), false);
  const end1 = a.begin('C:/p', 'user', ['run']);
  const end2 = a.begin('c:\\p\\', 'auto', ['parse']);
  assert.equal(a.busy('C:/p', 'user'), true);
  assert.equal(a.busy('C:/p', 'auto'), process.platform === 'win32', 'same project, other spelling (Windows only)');
  assert.equal(a.busy('C:/other'), false);
  let idle = false;
  const waiting = a.whenIdle('C:/p', 'user').then(() => (idle = true));
  await Promise.resolve();
  assert.equal(idle, false);
  end1(0);
  end1(0);
  await waiting;
  assert.equal(idle, true);
  end2(0);
  assert.equal(a.busy('C:/p'), false);
  await a.whenIdle('C:/p'); // already idle: resolves at once
});

/** A fake clock + runner to drive the scheduler. */
function harness(opts: { busy?: boolean } = {}) {
  let now = 1000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const activity = new DbtActivity(() => now);
  const runs: string[] = [];
  const finishers: ((ok: boolean, error?: string, skipped?: boolean) => void)[] = [];
  const states: { root: string; running: boolean; failed?: string }[] = [];
  const s = new ParseScheduler({
    debounceMs: 1500,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: id => {
      const i = timers.findIndex(t => t.id === id);
      if (i >= 0) {
        timers.splice(i, 1);
      }
    },
    activity,
    run: root =>
      new Promise(resolve => {
        runs.push(root);
        finishers.push((ok, error, skipped) => resolve({ ok, error, skipped }));
      }),
    onState: (root, st) => states.push({ root, ...st })
  });
  const advance = async (ms: number) => {
    now += ms;
    for (;;) {
      timers.sort((x, y) => x.at - y.at);
      const t = timers[0];
      if (!t || t.at > now) {
        break;
      }
      timers.shift();
      t.fn();
      await flush();
    }
    await flush();
  };
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  };
  if (opts.busy) {
    activity.begin('/p', 'user', ['run']);
  }
  return { s, activity, runs, finishers, states, advance, flush, setNow: (n: number) => (now = n), get now() { return now; } };
}

test('ParseScheduler: a burst of changes gives one parse, after the debounce', async () => {
  const h = harness();
  h.s.changed('/p');
  await h.advance(500);
  h.s.changed('/p');
  await h.advance(1000);
  assert.deepEqual(h.runs, [], 'still within 1.5 s of the last change');
  await h.advance(600);
  assert.deepEqual(h.runs, ['/p']);
  assert.equal(h.activity.busy('/p', 'auto'), true, 'the parse is registered as dbt activity');
  h.finishers[0](true);
  await h.flush();
  assert.equal(h.activity.busy('/p'), false);
  assert.deepEqual(h.states.at(-1), { root: '/p', running: false, failed: undefined });
});

test('ParseScheduler: a change during a parse queues exactly one more', async () => {
  const h = harness();
  h.s.changed('/p');
  await h.advance(1500);
  h.s.changed('/p');
  h.s.changed('/p');
  await h.advance(5000);
  assert.equal(h.runs.length, 1, 'never two at once');
  h.finishers[0](true);
  await h.flush();
  await h.advance(1500);
  assert.equal(h.runs.length, 2);
  h.finishers[1](true);
  await h.advance(5000);
  assert.equal(h.runs.length, 2, 'nothing else queued');
});

test('ParseScheduler: waits while another dbt command runs, then parses once', async () => {
  const h = harness();
  const end = h.activity.begin('/p', 'user', ['debug']); // debug doesn't parse
  h.s.changed('/p');
  await h.advance(5000);
  assert.deepEqual(h.runs, []);
  end(0);
  await h.flush();
  assert.deepEqual(h.runs, ['/p']);
});

test('ParseScheduler: a command that parses (started after the last change) makes the pending parse unnecessary', async () => {
  const h = harness();
  h.s.changed('/p');
  await h.advance(200);
  const end = h.activity.begin('/p', 'user', ['run', '--select', 'a']);
  await h.advance(5000);
  end(0);
  await h.advance(5000);
  assert.deepEqual(h.runs, [], 'dbt run parsed the project already');
  // A change after the command started still needs a parse.
  const end2 = h.activity.begin('/p', 'user', ['build']);
  await h.advance(100);
  h.s.changed('/p');
  await h.advance(5000);
  end2(1);
  await h.flush();
  assert.deepEqual(h.runs, ['/p']);
});

test('ParseScheduler: failure is reported, the next good parse clears it; disabled = nothing', async () => {
  const h = harness();
  h.s.changed('/p');
  await h.advance(1500);
  h.finishers[0](false, 'Compilation Error in model a');
  await h.flush();
  assert.deepEqual(h.states.at(-1), { root: '/p', running: false, failed: 'Compilation Error in model a' });
  assert.equal(h.s.failure('/p'), 'Compilation Error in model a');
  h.s.changed('/p');
  await h.advance(1500);
  assert.deepEqual(h.states.at(-1), { root: '/p', running: true, failed: 'Compilation Error in model a' });
  h.finishers[1](true);
  await h.flush();
  assert.equal(h.s.failure('/p'), undefined);
  // A successful manual dbt parse also clears a failure.
  h.s.changed('/p');
  await h.advance(1500);
  h.finishers[2](false, 'bad');
  await h.flush();
  h.activity.begin('/p', 'user', ['parse'])(0);
  await h.flush();
  assert.equal(h.s.failure('/p'), undefined);

  h.s.setEnabled(false);
  h.s.changed('/p');
  await h.advance(5000);
  assert.equal(h.runs.length, 3);
});

test('ParseScheduler: projects are independent', async () => {
  const h = harness();
  h.s.changed('/a');
  await h.advance(1000);
  h.s.changed('/b');
  await h.advance(500);
  assert.deepEqual(h.runs, ['/a']);
  await h.advance(1000);
  assert.deepEqual(h.runs, ['/a', '/b']);
});

test('firstError: the line naming the error, without the timestamp', () => {
  const out = [
    '10:01:02  Running with dbt=1.12.0',
    '10:01:03  Encountered an error:',
    "Compilation Error in model a (models/a.sql)",
    "  unexpected '}'"
  ].join('\n');
  assert.equal(firstError(out), 'Compilation Error in model a (models/a.sql)');
  assert.equal(firstError('something odd'), 'something odd');
  assert.equal(firstError(''), 'dbt parse failed');
});

test('ParseScheduler: a failed or cancelled command keeps the parse pending; a good one clears a failure', async () => {
  const h = harness();
  h.s.changed('/p');
  await h.advance(200);
  h.activity.begin('/p', 'user', ['run'])(1); // e.g. a compilation error: the manifest may be stale
  await h.advance(1500);
  assert.deepEqual(h.runs, ['/p']);
  h.finishers[0](false, 'Compilation Error');
  await h.flush();
  assert.equal(h.s.failure('/p'), 'Compilation Error');
  h.activity.begin('/p', 'user', ['compile'])(undefined); // cancelled: nothing known
  assert.equal(h.s.failure('/p'), 'Compilation Error');
  h.activity.begin('/p', 'user', ['run'])(0); // parsed fine after the last change
  assert.equal(h.s.failure('/p'), undefined);
});

test('ParseScheduler: dbt missing keeps the change pending; disabling clears a failure and a late result', async () => {
  const h = harness();
  h.s.changed('/p');
  await h.advance(1500);
  h.finishers[0](false, 'skipped');
  await h.flush();
  h.s.setEnabled(false);
  assert.equal(h.s.failure('/p'), undefined, 'off: no stale failure');
  h.s.setEnabled(true);
  h.s.changed('/p');
  await h.advance(1500);
  h.s.setEnabled(false);
  h.finishers[1](false, 'late');
  await h.flush();
  assert.equal(h.s.failure('/p'), undefined, 'a parse that ends after turning it off reports nothing');
});

test('parseTrigger: a dot folder as a resource path is kept as is', () => {
  assert.equal(parseTrigger('.models/a.sql', { ...PATHS, model: ['.models'] }), true);
  assert.equal(parseTrigger('models/a.sql', { ...PATHS, model: ['./models'] }), true);
});

test('ParseScheduler: skipped (dbt not available) stays pending without retrying in a loop', async () => {
  const h = harness();
  h.s.changed('/p');
  await h.advance(1500);
  h.finishers[0](true, undefined, true);
  await h.advance(10000);
  assert.equal(h.runs.length, 1, 'no retry loop');
  h.s.changed('/p');
  await h.advance(1500);
  assert.equal(h.runs.length, 2);
});
