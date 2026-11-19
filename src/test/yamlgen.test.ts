import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { appendModel, hasModel, mergeColumns, newModelYaml, parseColumnsOutput, yamlUsable } from '../yamlgen';

const cols = [
  { name: 'id', dataType: 'INTEGER' },
  { name: 'email', dataType: 'character varying(256)' }
];

test('parseColumnsOutput reads DBTCOL lines and ignores everything else', () => {
  const out = '09:00:00  Running with dbt=1.12.7\nDBTCOL|id|INTEGER\nDBTCOL|email|character varying(256)\n\nDone.';
  assert.deepEqual(parseColumnsOutput(out), cols);
  assert.deepEqual(parseColumnsOutput(''), []);
});

test('newModelYaml writes a complete version 2 file', () => {
  assert.equal(
    newModelYaml('stg_a', cols),
    [
      'version: 2',
      '',
      'models:',
      '  - name: stg_a',
      '    description: ""',
      '    columns:',
      '      - name: id',
      '        data_type: INTEGER',
      '        description: ""',
      '      - name: email',
      '        data_type: character varying(256)',
      '        description: ""',
      ''
    ].join('\n')
  );
});

test('scalars that YAML 1.1 (PyYAML) would misread are quoted', () => {
  const text = newModelYaml('m', [
    { name: 'on', dataType: 'BOOLEAN' },
    { name: 'yes', dataType: 'x' },
    { name: '2024', dataType: 'INTEGER' },
    { name: 'null', dataType: '1.5' },
    { name: 'ok_name', dataType: 'STRUCT(a INTEGER): x' }
  ]);
  const c = parse(text, { version: '1.1' }).models[0].columns;
  assert.deepEqual(c.map((x: any) => x.name), ['on', 'yes', '2024', 'null', 'ok_name']);
  assert.deepEqual(c.map((x: any) => x.data_type), ['BOOLEAN', 'x', 'INTEGER', '1.5', 'STRUCT(a INTEGER): x']);
});

// An existing file with styles a full re-serialisation would change: folded description,
// flow sequence, comments, odd spacing. Edits must leave every existing line byte-identical.
const existing = [
  'version: 2',
  '',
  '# keep me',
  'models:',
  '  - name: b',
  '    description: >',
  '      The b model, described over',
  '      two folded lines.',
  '    columns:',
  '      - name: ID',
  '        description: "primary key" # inline comment',
  '        data_tests: [not_null,   unique]',
  ''
].join('\n');

const keepsExisting = (before: string, after: string) => {
  const b = before.replace(/\n$/, '').split('\n');
  const a = after.split('\n');
  for (const line of b) {
    assert.ok(a.includes(line), `line changed or lost: ${JSON.stringify(line)}`);
  }
};

test('appendModel inserts a new entry without touching existing lines', () => {
  const text = appendModel(existing, 'c', cols);
  keepsExisting(existing, text);
  const doc = parse(text);
  assert.deepEqual(doc.models.map((m: any) => m.name), ['b', 'c']);
  assert.equal(doc.models[0].description, 'The b model, described over two folded lines.\n');
  assert.deepEqual(doc.models[1].columns.map((c: any) => c.name), ['id', 'email']);
  assert.match(text, /\n  - name: c\n    description: ""\n    columns:\n      - name: id\n/);
  assert.ok(hasModel(text, 'c') && hasModel(text, 'b') && !hasModel(text, 'zzz'));
});

test('appendModel follows a file that does not indent sequences', () => {
  const flush = 'version: 2\nmodels:\n- name: b\n  columns:\n  - name: id\n';
  const text = appendModel(flush, 'c', cols);
  keepsExisting(flush, text);
  assert.match(text, /\n- name: c\n  description: ""\n  columns:\n  - name: id\n    data_type: INTEGER\n/);
  assert.deepEqual(parse(text).models.map((m: any) => m.name), ['b', 'c']);
});

test('appendModel keeps CRLF line endings', () => {
  const crlf = existing.replace(/\n/g, '\r\n');
  const text = appendModel(crlf, 'c', cols);
  assert.ok(!/[^\r]\n/.test(text), 'mixed line endings');
  assert.deepEqual(parse(text).models.map((m: any) => m.name), ['b', 'c']);
});

test('mergeColumns adds only missing columns (case-insensitive) without touching existing lines', () => {
  const r = mergeColumns(existing, 'b', cols)!;
  assert.deepEqual(r.added, ['email']);
  keepsExisting(existing, r.text);
  const b = parse(r.text).models[0];
  assert.deepEqual(b.columns.map((c: any) => c.name), ['ID', 'email']);
  assert.deepEqual(b.columns[0].data_tests, ['not_null', 'unique']);
});

test('mergeColumns creates the columns list when missing and returns undefined for unknown models', () => {
  const noCols = 'version: 2\nmodels:\n  - name: stg_a\n    description: "x" # keep\n  - name: other\n';
  const r = mergeColumns(noCols, 'stg_a', cols)!;
  assert.deepEqual(r.added, ['id', 'email']);
  keepsExisting(noCols, r.text);
  const doc = parse(r.text);
  assert.deepEqual(doc.models[0].columns.map((c: any) => c.name), ['id', 'email']);
  assert.equal(doc.models[1].name, 'other');
  assert.equal(mergeColumns(noCols, 'missing', cols), undefined);
  assert.deepEqual(mergeColumns(r.text, 'stg_a', cols)!.added, []);
});

test('appendModel adds a models list to a yml that has none', () => {
  const text = appendModel('version: 2\nsources:\n  - name: raw\n', 'c', cols);
  const doc = parse(text);
  assert.equal(doc.sources[0].name, 'raw');
  assert.equal(doc.models[0].name, 'c');
  assert.equal(parse(appendModel('', 'c', cols)).models[0].name, 'c');
});

test('yamlUsable rejects files that cannot be edited safely', () => {
  assert.ok(yamlUsable(existing));
  assert.ok(yamlUsable(''));
  assert.ok(!yamlUsable('version: 2\n---\nmodels: []\n'));
  assert.ok(!yamlUsable('models:\n  - name: a\nmodels:\n  - name: b\n'));
  assert.ok(!yamlUsable('models: [\n'));
  assert.ok(!hasModel('models:\n  - name: a\nmodels:\n  - name: a\n', 'a'));
});
