import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailingCteQuery } from '../scratch';

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
