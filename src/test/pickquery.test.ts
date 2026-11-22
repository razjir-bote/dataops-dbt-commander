import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickQuery } from '../scratch';

const MODEL = ['with a as (select 1 as x),', 'b as (select x + 1 as x from a)', 'select * from b', ''].join('\n');
const off = (line: number, col: number) => MODEL.split('\n').slice(0, line).join('\n').length + (line ? 1 : 0) + col;
const at = (cursor: number) => ({ start: cursor, end: cursor, cursor });

test('pickQuery: what Preview / Copy compiled run, in order', () => {
  // Whole CTE selected → it, with the model's CTEs.
  assert.deepEqual(pickQuery(MODEL, { start: off(1, 0), end: off(1, 31), cursor: off(1, 31) }, { isModel: true, isDirty: false }), {
    kind: 'sql',
    sql: 'with a as (select 1 as x),\nb as (select x + 1 as x from a)\nselect * from b',
    suffix: ' › b'
  });
  // Any other selection → as is.
  assert.deepEqual(pickQuery(MODEL, { start: off(2, 0), end: off(2, 15), cursor: off(2, 15) }, { isModel: true, isDirty: false }), {
    kind: 'sql',
    sql: 'select * from b',
    suffix: ' (selection)'
  });
  // Cursor in a CTE → that CTE.
  assert.deepEqual(pickQuery(MODEL, at(off(0, 15)), { isModel: true, isDirty: false }), {
    kind: 'sql',
    sql: 'with a as (select 1 as x),\nb as (select x + 1 as x from a)\nselect * from a',
    suffix: ' › a'
  });
  // Cursor elsewhere: the saved model itself (dbt compiles / previews the node), or the unsaved text.
  assert.deepEqual(pickQuery(MODEL, at(off(2, 3)), { isModel: true, isDirty: false }), { kind: 'model' });
  assert.deepEqual(pickQuery(MODEL, at(off(2, 3)), { isModel: true, isDirty: true }), { kind: 'sql', sql: MODEL, suffix: ' (unsaved)' });
  // A scratchpad / non-model file: the whole text.
  assert.deepEqual(pickQuery('select 42', at(3), { isModel: false, isDirty: true }), { kind: 'sql', sql: 'select 42', suffix: '' });
  // A blank selection counts as none.
  assert.deepEqual(pickQuery(MODEL, { start: off(3, 0), end: off(3, 0), cursor: off(3, 0) }, { isModel: true, isDirty: false }), { kind: 'model' });
});
