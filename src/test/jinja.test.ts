import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callAt, completionContext } from '../jinja';

const at = (line: string, marker: string) => line.indexOf(marker);

test('callAt finds ref name anywhere inside the call', () => {
  const line = "select * from {{ ref('stg_orders') }}";
  for (const col of [at(line, 'ref'), at(line, "'stg"), at(line, 'orders'), at(line, "') }}"), at(line, ') }}')]) {
    assert.deepEqual(callAt(line, col), { kind: 'ref', name: 'stg_orders' }, `col ${col}`);
  }
});

test('callAt handles package and version arguments', () => {
  assert.deepEqual(callAt("{{ ref('pkg', 'm') }}", 8), { kind: 'ref', name: 'm', package: 'pkg' });
  assert.deepEqual(callAt('{{ ref("m", v=2) }}', 8), { kind: 'ref', name: 'm', version: '2' });
  assert.deepEqual(callAt("{{ ref('m', version='3') }}", 8), { kind: 'ref', name: 'm', version: '3' });
});

test('callAt finds source calls', () => {
  const line = "from {{ source('raw', 'orders') }} o join {{ ref('b') }} x";
  assert.deepEqual(callAt(line, at(line, 'orders')), { kind: 'source', source: 'raw', table: 'orders' });
  assert.deepEqual(callAt(line, at(line, "'b'")), { kind: 'ref', name: 'b' });
});

test('callAt returns undefined outside calls or for incomplete calls', () => {
  assert.equal(callAt("select 1 -- ref('x')", 0), undefined);
  assert.equal(callAt("{{ ref('x') }} and more", 20), undefined);
  assert.equal(callAt("{{ ref(", 5), undefined);
});

test('completionContext detects ref, source name and source table positions', () => {
  assert.deepEqual(completionContext("select * from {{ ref('st"), { kind: 'ref' });
  assert.deepEqual(completionContext('{{ ref("'), { kind: 'ref' });
  assert.deepEqual(completionContext('{{ source("'), { kind: 'sourceName' });
  assert.deepEqual(completionContext("{{ source('raw', 'or"), { kind: 'sourceTable', source: 'raw' });
  assert.deepEqual(completionContext("{{ source('raw', \""), { kind: 'sourceTable', source: 'raw' });
  assert.deepEqual(completionContext("{{ ref ('st"), { kind: 'ref' });
  assert.deepEqual(completionContext("{{ source ( 'raw' , 'o"), { kind: 'sourceTable', source: 'raw' });
  assert.equal(completionContext("{{ my_ref('x"), undefined);
  assert.equal(completionContext('select ref'), undefined);
  assert.equal(completionContext("{{ ref('done') }} x"), undefined);
});
