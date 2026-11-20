import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yamlContextAt } from '../yamlcontext';

/** Context at the `|` marker (`¦` where the text itself has a `|`, e.g. block scalars). */
function at(text: string) {
  const mark = text.includes('¦') ? '¦' : '|';
  const lines = text.split('\n');
  const line = lines.findIndex(l => l.includes(mark));
  const col = lines[line].indexOf(mark);
  return yamlContextAt(text.replace(mark, ''), line, col);
}

const doc = (...l: string[]) => l.join('\n');

test('top-level key', () => {
  const c = at(doc('version: 2', '', 'mod|'));
  assert.deepEqual([c.path, c.kind, c.word], [[], 'key', 'mod']);
  assert.deepEqual(c.siblings, ['version']);
});

test('model list item: name value, owner-less', () => {
  const c = at(doc('version: 2', 'models:', '  - name: or|'));
  assert.deepEqual([c.path, c.kind, c.key, c.word], [['models', '-'], 'value', 'name', 'or']);
});

test('model keys below the name, siblings above and below', () => {
  const c = at(doc('models:', '  - name: orders', '    des|', '    columns:', '      - name: id'));
  assert.deepEqual([c.path, c.kind, c.word], [['models', '-'], 'key', 'des']);
  assert.deepEqual(c.siblings.sort(), ['columns', 'name']);
  assert.deepEqual(c.items, [{ name: 'orders' }]);
});

test('column name under a model, with the other columns listed', () => {
  const c = at(doc('models:', '  - name: orders', '    columns:', '      - name: id', '      - name: |', '      - name: status'));
  assert.deepEqual([c.path, c.kind, c.key], [['models', '-', 'columns', '-'], 'value', 'name']);
  assert.deepEqual(c.items, [{ name: 'orders' }, { name: undefined }]);
  assert.deepEqual(c.listNames.sort(), ['id', 'status']);
});

test('indentless lists', () => {
  const c = at(doc('models:', '- name: orders', '  columns:', '  - name: id', '    data_tests:', '    - uni|'));
  assert.deepEqual([c.path, c.kind, c.word], [['models', '-', 'columns', '-', 'data_tests', '-'], 'item', 'uni']);
  assert.deepEqual(c.items.map(i => i.name), ['orders', 'id', undefined]);
});

test('test list item and config value', () => {
  const t = at(doc('models:', '  - name: o', '    data_tests:', '      - |'));
  assert.deepEqual([t.path, t.kind, t.word], [['models', '-', 'data_tests', '-'], 'item', '']);
  const v = at(doc('models:', '  - name: o', '    config:', '      materialized: inc|'));
  assert.deepEqual([v.path, v.kind, v.key, v.word], [['models', '-', 'config'], 'value', 'materialized', 'inc']);
});

test('source table column: names of the source and table items', () => {
  const c = at(doc('sources:', '  - name: raw', '    tables:', '      - name: orders', '        columns:', '          - name: |'));
  assert.deepEqual(c.path, ['sources', '-', 'tables', '-', 'columns', '-']);
  assert.deepEqual(c.items.map(i => i.name), ['raw', 'orders', undefined]);
});

test('blank line inside a mapping uses the cursor column', () => {
  const c = at(doc('models:', '  - name: orders', '    |', '    columns: []'));
  assert.deepEqual([c.path, c.kind, c.word], [['models', '-'], 'key', '']);
});

test('comments and CRLF are ignored', () => {
  const c = yamlContextAt('models:\r\n  # comment\r\n  - name: x\r\n    co', 3, 6);
  assert.deepEqual([c.path, c.kind, c.word], [['models', '-'], 'key', 'co']);
});

test('quoted names in items', () => {
  const c = at(doc('models:', "  - name: 'orders'", '    columns:', '      - name: "id"', '      - name: |'));
  assert.deepEqual(c.items.map(i => i.name), ['orders', undefined]);
  assert.deepEqual(c.listNames, ['id']);
});

test('block scalars: text inside description: | / > is not YAML structure', () => {
  const c = at(doc('models:', '  - name: o', '    description: |', '      Con¦'));
  assert.equal(c.kind, 'other');
  const m = at(doc('models:', '  - name: o', '    description: >-', '      materialized: |'));
  assert.equal(m.kind, 'other');
  const after = at(doc('models:', '  - name: o', '    description: |', '      some: text', '    co¦'));
  assert.deepEqual([after.path, after.kind], [['models', '-'], 'key']);
  assert.ok(after.siblings.includes('description') && !after.siblings.includes('some'));
});

test('anchors / tags on a parent key still make it a parent', () => {
  const c = at(doc('models:', '  - name: o', '    config: &base', '      mat|'));
  assert.deepEqual(c.path, ['models', '-', 'config']);
});

test('a quoted value: the word starts after the quote', () => {
  const c = at(doc('models:', '  - name: o', '    columns:', '      - name: "I|'));
  assert.deepEqual([c.kind, c.word, c.quote], ['value', 'I', '"']);
});

test('bare dash on its own line: the item name is on the next line', () => {
  const c = at(doc('models:', '  -', '    name: b', '    columns:', '      - name: |'));
  assert.deepEqual(c.items.map(i => i.name), ['b', undefined]);
});

test('indentless list: siblings of a key in the item', () => {
  const c = at(doc('models:', '- name: a', '  columns:', '  - name: id', '  |'));
  assert.deepEqual(c.path, ['models', '-']);
  assert.deepEqual(c.siblings.sort(), ['columns', 'name']);
});

test('multi-document files: the previous document does not count', () => {
  const c = at(doc('version: 2', 'models: []', '---', '|'));
  assert.deepEqual(c.siblings, []);
});
