import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descendants, parseProcessList } from '../proctree';

test('descendants follows children created after their parent', () => {
  const procs = [
    { pid: 100, ppid: 1, created: 1000 }, // dbt.exe
    { pid: 101, ppid: 100, created: 1001 }, // conhost
    { pid: 102, ppid: 100, created: 1002 }, // python (venv launcher)
    { pid: 103, ppid: 102, created: 1003 }, // python (real)
    { pid: 200, ppid: 1, created: 900 } // unrelated
  ];
  assert.deepEqual(descendants(procs, 100).sort(), [101, 102, 103]);
});

test('descendants ignores processes whose parent id was reused (created before the "parent")', () => {
  // csrss / winlogon started at boot; their real parent (smss) exited and its id now belongs to dbt.exe.
  const procs = [
    { pid: 6616, ppid: 4000, created: 5_000_000 }, // dbt.exe, started just now
    { pid: 5492, ppid: 6616, created: 5_000_010 }, // its python child
    { pid: 604, ppid: 6616, created: 10 }, // csrss.exe: "parent" 6616 is a reused id
    { pid: 700, ppid: 604, created: 12 }, // winlogon under csrss
    { pid: 5493, ppid: 5492, created: 5_000_020 }
  ];
  assert.deepEqual(descendants(procs, 6616).sort(), [5492, 5493]);
  assert.deepEqual(descendants(procs, 999), []);
});

test('parseProcessList reads PowerShell ConvertTo-Json output (array or single object)', () => {
  const arr = JSON.stringify([
    { ProcessId: 1, ParentProcessId: 0, Created: 10 },
    { ProcessId: 2, ParentProcessId: 1, Created: 11 }
  ]);
  assert.deepEqual(parseProcessList(arr), [
    { pid: 1, ppid: 0, created: 10 },
    { pid: 2, ppid: 1, created: 11 }
  ]);
  assert.deepEqual(parseProcessList(JSON.stringify({ ProcessId: 3, ParentProcessId: 1, Created: 5 })), [{ pid: 3, ppid: 1, created: 5 }]);
  assert.deepEqual(parseProcessList('not json'), []);
});
