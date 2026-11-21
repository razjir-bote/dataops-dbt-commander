import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { addSourceTable, csvHeader } from '../yamlgen';

const spec = { source: 'bronze', schema: 'main', table: 'ace_x', description: 'Loaded from the seed ace_x (dbt seed).', columns: ['Id', 'Name'] };

test('csvHeader: first record, quotes, BOM, CRLF', () => {
  assert.deepEqual(csvHeader('\ufeffId,"Order, Date",x\r\n1,2,3\r\n'), ['Id', 'Order, Date', 'x']);
  assert.deepEqual(csvHeader('a,"b ""q"""\n'), ['a', 'b "q"']);
  assert.deepEqual(csvHeader(''), []);
});

test('new file: version, source with schema, the table and its columns', () => {
  const { text, status } = addSourceTable('', spec);
  assert.equal(status, 'added');
  assert.equal(
    text,
    [
      'version: 2',
      '',
      'sources:',
      '  - name: bronze',
      '    schema: main',
      '    tables:',
      '      - name: ace_x',
      '        description: "Loaded from the seed ace_x (dbt seed)."',
      '        columns:',
      '          - name: Id',
      '          - name: Name',
      ''
    ].join('\n')
  );
});

test('existing source: the table is appended to its tables, other lines untouched', () => {
  const before = ['version: 2', 'sources:', '  - name: bronze  # landed data', '    schema: main', '    tables:', '      - name: old', '  - name: other', '    tables:', '      - name: z', ''].join('\n');
  const { text, status } = addSourceTable(before, spec);
  assert.equal(status, 'added');
  assert.ok(text.startsWith(['version: 2', 'sources:', '  - name: bronze  # landed data', '    schema: main', '    tables:', '      - name: old', '      - name: ace_x'].join('\n')), text);
  const doc = parse(text);
  assert.deepEqual(doc.sources[0].tables.map((t: any) => t.name), ['old', 'ace_x']);
  assert.deepEqual(doc.sources[1].tables.map((t: any) => t.name), ['z']);
});

test('table already there: nothing changes', () => {
  const before = addSourceTable('', spec).text;
  assert.deepEqual(addSourceTable(before, spec), { text: before, status: 'exists' });
});

test('another source in the file: a new source item; no sources key: a sources block; CRLF kept', () => {
  const other = addSourceTable('version: 2\nsources:\n- name: raw\n  tables:\n  - name: a\n', spec).text;
  assert.deepEqual(parse(other).sources.map((s: any) => s.name), ['raw', 'bronze']);
  assert.match(other, /\n- name: bronze\n  schema: main\n  tables:\n  - name: ace_x\n/, 'indentless file style kept');
  const models = addSourceTable('version: 2\r\nmodels:\r\n  - name: m\r\n', { ...spec, database: 'db2' }).text;
  assert.ok(!/[^\r]\n/.test(models), 'CRLF everywhere');
  assert.equal(parse(models).sources[0].database, 'db2');
});

test('source without tables yet, and odd names quoted', () => {
  const t = addSourceTable('sources:\n  - name: bronze\n    schema: main\n', { ...spec, columns: ['yes', 'a: b'] }).text;
  const doc = parse(t);
  assert.deepEqual(doc.sources[0].tables[0].columns.map((c: any) => c.name), ['yes', 'a: b']);
});
