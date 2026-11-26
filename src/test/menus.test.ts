import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The one right-click list: every dbt menu (Explorer / editor tab / editor submenus, sidebar, Lineage view) shows
 * these items in these groups and this order, filtered to what applies.
 */
const LIST: [group: string, slots: string[][]][] = [
  ['1_run', [['run', 'tree.run'], ['build', 'tree.build'], ['test', 'tree.test'], ['seedFiles', 'tree.seed'], ['tree.snapshot'], ['tree.runTest']]],
  ['2_graph', [['buildUpstream', 'tree.buildUpstream'], ['buildDownstream', 'tree.buildDownstream'], ['buildUpDownstream', 'tree.buildUpDownstream'], ['buildScd2Chain']]],
  ['3_inspect', [['compile'], ['copyCompiled'], ['preview'], ['previewSelection'], ['showLineage'], ['openInDocs']]],
  ['4_create', [['generateYaml'], ['newModel'], ['createStaging'], ['createChangeKey'], ['addSeedAsSource']]],
  ['5_refactor', [['renameModel']]],
  ['6_sqlfluff', [['sqlfluff.lint'], ['sqlfluff.fix']]],
  ['9_settings', [['openSettings']]]
];

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const menus: Record<string, { command?: string; submenu?: string; group?: string; when?: string }[]> = pkg.contributes.menus;
const slotOf = (command: string) => {
  const id = command.replace(/^dbtCommander\./, '');
  for (const [group, slots] of LIST) {
    const i = slots.findIndex(s => s.includes(id));
    if (i >= 0) {
      return { group, order: i + 1 };
    }
  }
  return undefined;
};

test('menus: every dbt right-click list uses the one list (groups and order)', () => {
  const lists: [string, typeof menus[string]][] = [
    ['dbtCommander.submenu', menus['dbtCommander.submenu']],
    ['dbtCommander.editorSubmenu', menus['dbtCommander.editorSubmenu']],
    ['sidebar', menus['view/item/context'].filter(m => /view == dbtCommander\.project/.test(m.when ?? '') && !/^inline/.test(m.group ?? ''))],
    ['lineage', menus['view/item/context'].filter(m => /view == dbtCommander\.lineage/.test(m.when ?? '') && !/^inline/.test(m.group ?? ''))]
  ];
  for (const [name, items] of lists) {
    assert.ok(items?.length, `${name}: no items`);
    for (const m of items) {
      const want = slotOf(m.command!);
      assert.ok(want, `${name}: ${m.command} isn't in the list`);
      assert.equal(m.group, `${want.group}@${want.order}`, `${name}: ${m.command}`);
    }
  }
});

test('menus: VS Code menus get one dbt submenu, nothing loose', () => {
  assert.deepEqual(
    pkg.contributes.submenus.map((s: { id: string; label: string }) => [s.id, s.label]),
    [
      ['dbtCommander.submenu', 'dbt'],
      ['dbtCommander.editorSubmenu', 'dbt']
    ]
  );
  assert.deepEqual(menus['explorer/context'].map(m => m.submenu ?? m.command), ['dbtCommander.submenu']);
  assert.deepEqual(menus['editor/title/context'].map(m => m.submenu ?? m.command), ['dbtCommander.submenu']);
  assert.deepEqual(menus['editor/context'].map(m => m.submenu ?? m.command), ['dbtCommander.editorSubmenu']);
  // Seed CSVs open the submenu too.
  assert.match(menus['explorer/context'][0].when!, /\\\.csv/);
});

test('menus: titles without a "dbt " prefix (the category / submenu says it), one capitalisation', () => {
  const keepDbt = new Set(['deps', 'seed', 'snapshot', 'docsGenerate', 'parse', 'retry', 'debug']);
  for (const c of pkg.contributes.commands as { command: string; title: string }[]) {
    const id = c.command.replace(/^dbtCommander\./, '');
    if (!keepDbt.has(id)) {
      assert.doesNotMatch(c.title, /^dbt /, c.command);
    }
    // Title Case for the words after the first (small words and "dbt" excepted).
    // Words in parentheses and dbt's own command names stay lower case.
    const plain = c.title.replace(/\([^)]*\)/g, '').replace(/\bdbt( [a-z]+)+/g, 'dbt');
    for (const w of plain.split(/\s+/).filter(Boolean).slice(1)) {
      if (/^[a-z]/.test(w) && !/^(a|an|and|as|in|of|on|or|the|to|dbt)$/.test(w)) {
        assert.fail(`${c.command}: "${c.title}" — "${w}" should be capitalised`);
      }
    }
  }
});
