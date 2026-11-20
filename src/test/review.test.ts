import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { folderSelectors, graphSelectors, modelSelector } from '../dbt';
import { ProblemStore, executedNodes } from '../errors';
import { fileFor } from '../manifest';
import { parseValueList } from '../yamlfix';
import { toCsv, toTsv } from '../exportrows';

const root = path.resolve('proj');

test('modelSelector: spaces and glob characters in paths become glob patterns dbt splits nothing on', () => {
  assert.equal(modelSelector(root, path.join(root, 'models', 'my folder', 'a b.sql')), 'path:models/my?folder/a?b.sql');
  assert.equal(modelSelector(root, path.join(root, 'models', 'br[1]')), 'path:models/br[[]1[]]');
  assert.equal(modelSelector(root, path.join(root, 'models', 'plain.sql')), 'path:models/plain.sql');
  assert.deepEqual(folderSelectors(root, [path.join(root, 'seeds', 'my seeds')]), ['path:seeds/my?seeds']);
  assert.deepEqual(graphSelectors(root, [path.join(root, 'models', 'x y.sql')], 'both'), ['+path:models/x?y.sql+']);
});

test('executedNodes: name and package of every node in run_results.json', () => {
  const json = JSON.stringify({ results: [{ unique_id: 'model.demo.b' }, { unique_id: 'test.dbt_utils.not_null_x.ab12' }, { unique_id: 'model.demo.dim.v2' }] });
  assert.deepEqual(executedNodes(json), [
    { name: 'b', package: 'demo' },
    { name: 'not_null_x', package: 'dbt_utils' },
    { name: 'dim', package: 'demo' }
  ]);
  assert.deepEqual(executedNodes('{'), []);
});

test('ProblemStore keeps problems of same-named nodes in different projects apart', () => {
  const a = path.resolve('a');
  const b = path.resolve('b');
  const store = new ProblemStore<string>();
  store.update(a, ['stg'], [{ node: 'stg', file: path.join(a, 'stg.sql'), item: 'A broken' }]);
  store.update(b, ['stg'], []); // B's stg ran fine
  assert.deepEqual([...store.byFile().values()], [['A broken']], "B's run cleared A's problem");
  store.update(b, ['stg'], [{ node: 'stg', file: path.join(b, 'stg.sql'), item: 'B broken' }]);
  assert.equal(store.byFile().size, 2);
  store.update(a.toUpperCase(), ['stg'], []); // same project, path spelled differently
  assert.deepEqual([...store.byFile().values()], [['B broken']]);
});

test('ProblemStore: problems of a node that did not run (e.g. a parse error) still replace its old ones', () => {
  const store = new ProblemStore<string>();
  store.update(root, [], [{ node: 'x', file: 'f', item: 'one' }]);
  store.update(root, [], [{ node: 'x', file: 'f', item: 'two' }]);
  assert.deepEqual([...store.byFile().values()], [['two']]);
});

test('fileFor maps a package node path into the packages folder', () => {
  assert.equal(fileFor(root, 'demo', 'demo', 'models/x.sql'), path.join(root, 'models', 'x.sql'));
  assert.equal(fileFor(root, 'demo', 'dbt_utils', 'macros\\m.sql', 'vendor/pkgs'), path.join(root, 'vendor', 'pkgs', 'dbt_utils', 'macros', 'm.sql'));
});

test('parseValueList: commas separate values; quotes keep commas and spaces', () => {
  assert.deepEqual(parseValueList('placed, shipped ,completed'), ['placed', 'shipped', 'completed']);
  assert.deepEqual(parseValueList('"shipped, partially", \'  padded \', x'), ['shipped, partially', '  padded ', 'x']);
  assert.deepEqual(parseValueList(' , ,'), []);
  assert.deepEqual(parseValueList('"it\'s", \'say "hi"\''), ["it's", 'say "hi"']);
});

test('CSV / TSV export: formula-like text is prefixed with an apostrophe; numbers are not', () => {
  const rows = [{ v: '=HYPERLINK("x")' }, { v: '+1 555' }, { v: '@SUM(A1)' }, { v: '-12.5' }, { v: -3 }, { v: '-x' }];
  assert.equal(toCsv(['v'], rows), 'v\r\n"\'=HYPERLINK(""x"")"\r\n\'+1 555\r\n\'@SUM(A1)\r\n-12.5\r\n-3\r\n\'-x\r\n');
  assert.equal(toTsv(['v'], [{ v: '=1+1' }, { v: '-1' }]), "v\n'=1+1\n-1\n");
});
