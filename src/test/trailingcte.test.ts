import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectedCteQuery, trailingCteQuery } from '../scratch';

test('trailingCteQuery: a selection ending in a comma selects from its last CTE', () => {
  const sel = "with orders as (\n  select * from {{ ref('orders') }}\n),\npaid as (\n  select * from orders where paid\n),";
  assert.deepEqual(trailingCteQuery(sel), {
    name: 'paid',
    sql: "with orders as (\n  select * from {{ ref('orders') }}\n),\npaid as (\n  select * from orders where paid\n)\nselect * from paid"
  });
  // Whitespace, line comments and block comments after the comma are fine.
  assert.equal(trailingCteQuery('with a as (select 1 as x) ,  -- next one\n  /* b */\n')?.sql, 'with a as (select 1 as x)\nselect * from a');
  // config() / Jinja before the CTEs and Jinja tags right after the last one stay.
  const jinja = "{{ config(materialized='table') }}\nwith a as (select 1 as x),\n{% if true %}\nb as (select * from a),\n{% endif %}";
  assert.deepEqual(trailingCteQuery(jinja), {
    name: 'b',
    sql: "{{ config(materialized='table') }}\nwith a as (select 1 as x),\n{% if true %}\nb as (select * from a)\n{% endif %}\nselect * from b"
  });
});

test('trailingCteQuery: CTEs selected from the middle (no `with`) still work', () => {
  assert.deepEqual(trailingCteQuery('a as (select 1 as x),\nb as (select * from a),'), {
    name: 'b',
    sql: 'with a as (select 1 as x),\nb as (select * from a)\nselect * from b'
  });
  // Quoted names and column lists.
  assert.equal(trailingCteQuery('with "My Cte" (x) as (select 1),')?.sql, 'with "My Cte" (x) as (select 1)\nselect * from "My Cte"');
});

test('trailingCteQuery: anything else is left to the normal selection preview', () => {
  for (const sel of [
    'with a as (select 1 as x)', // no comma
    'select a, b,', // a column list, not CTEs
    'with a as (select 1 as x), b', // the comma isn't last
    'with a as (select 1, ', // unbalanced
    "with a as (select ',')", // the comma is in a string
    'with a as (select 1 as x) -- trailing comment,', // the comma is in a comment
    ','
  ]) {
    assert.equal(trailingCteQuery(sel), undefined, sel);
  }
});

// ---------- whole CTEs selected in a model: preview the last, with the model's CTEs before it ----------

const MODEL = [
  "with source as (select * from {{ ref('b') }}),", // 0
  'renamed as (', //                                   1
  '  select id as entity_id from source', //          2
  '),', //                                             3
  'deduplicated AS (', //                              4
  '  select * from renamed', //                       5
  ')', //                                              6
  'select * from deduplicated', //                    7
  ''
].join('\n');
const at = (line: number, col: number) => MODEL.split('\n').slice(0, line).join('\n').length + (line ? 1 : 0) + col;
const WITH_ALL = MODEL.slice(0, at(6, 1));

test('selectedCteQuery: one CTE selected (no comma, the last before the select) → it, with the CTEs before it', () => {
  const q = selectedCteQuery(MODEL, at(4, 0), at(6, 1));
  assert.deepEqual(q, { name: 'deduplicated', sql: `${WITH_ALL}\nselect * from deduplicated` });
  // Surrounding whitespace / the trailing comma / the `with` are fine; so is a selection of several CTEs.
  assert.equal(selectedCteQuery(MODEL, at(1, 0), at(3, 2))?.name, 'renamed');
  assert.equal(selectedCteQuery(MODEL, at(3, 2), at(7, 0))?.name, 'deduplicated', 'from after the comma to the next line');
  assert.equal(selectedCteQuery(MODEL, 0, at(3, 2))?.name, 'renamed', 'from the with');
  assert.equal(selectedCteQuery(MODEL, at(1, 0), at(6, 1))?.name, 'deduplicated', 'two CTEs: the last one');
});

test('selectedCteQuery: anything that isn\'t whole CTEs is left to the plain selection preview', () => {
  for (const [s, e, why] of [
    [at(2, 2), at(2, 36), 'part of a CTE body'],
    [at(4, 1), at(6, 1), 'starts mid-name'],
    [at(4, 0), at(5, 10), 'ends inside the CTE'],
    [at(4, 0), at(7, 26), 'runs into the final select'],
    [at(7, 0), at(7, 26), 'the final select']
  ] as [number, number, string][]) {
    assert.equal(selectedCteQuery(MODEL, s, e), undefined, why);
  }
  assert.equal(selectedCteQuery('select 1', 0, 8), undefined, 'no CTEs');
});
