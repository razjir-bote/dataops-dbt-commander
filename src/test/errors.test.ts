import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLine, executedNodeNames, parseDbtErrors } from '../errors';

test('problems carry the dbt node name', () => {
  assert.equal(parseDbtErrors('Runtime Error in model bad (models/bad.sql)\n  boom')[0].node, 'bad');
  assert.equal(parseDbtErrors('[ERROR]: in test unique_dup_id (models/dup.yml)\n  Got 1 result')[0].node, 'unique_dup_id');
});

test('executedNodeNames reads node names from run_results.json', () => {
  const json = JSON.stringify({
    results: [
      { unique_id: 'model.demo.b', status: 'success' },
      { unique_id: 'test.demo.unique_dup_id.4f0d5e', status: 'fail' },
      { unique_id: 'seed.demo.s', status: 'success' }
    ]
  });
  assert.deepEqual(executedNodeNames(json), ['b', 'unique_dup_id', 's']);
  assert.deepEqual(executedNodeNames('not json'), []);
});

const ESC = '\u001b';

const runtimeError = [
  '08:48:02  Completed with 1 error, 0 partial successes, and 0 warnings:',
  '08:48:02  ',
  `08:48:02  [${ESC}[31mERROR${ESC}[0m]: in model bad (models\\bad.sql)`,
  '08:48:02    Runtime Error in model bad (models\\bad.sql)',
  '  Catalog Error: Table with name does_not_exist does not exist!',
  '  Did you mean "pg_settings"?',
  '08:48:02  ',
  '08:48:02    compiled code at target\\compiled\\demo\\models\\bad.sql',
  '08:48:02  ',
  '08:48:02  Done. PASS=2 WARN=0 ERROR=1 SKIP=0 NO-OP=0 REUSED=0 TOTAL=3'
].join('\r\n');

const compilationError = [
  '08:47:45  Running with dbt=1.12.7',
  '08:47:45  [ERROR]: Encountered an error:',
  'Compilation Error in model bad2 (models\\bad2.sql)',
  "  unexpected '}', expected ')'",
  '    line 1',
  '      select {{ oops( }}'
].join('\n');

test('cleanLine strips ANSI codes and timestamps', () => {
  assert.equal(cleanLine(`08:48:02  [${ESC}[31mERROR${ESC}[0m]: x`), '[ERROR]: x');
  assert.equal(cleanLine('  indented'), '  indented');
});

test('runtime error reported once with its message', () => {
  const problems = parseDbtErrors(runtimeError);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].relPath, 'models\\bad.sql');
  assert.equal(problems[0].severity, 'error');
  assert.equal(problems[0].line, 0);
  assert.match(problems[0].message, /^Runtime Error: Catalog Error: Table with name does_not_exist does not exist!/);
  assert.doesNotMatch(problems[0].message, /compiled code at/);
});

test('compilation error picks up the line number', () => {
  const [p] = parseDbtErrors(compilationError);
  assert.equal(p.relPath, 'models\\bad2.sql');
  assert.equal(p.line, 0);
  assert.match(p.message, /unexpected '\}', expected '\)'/);
});

test('compilation error on a later line', () => {
  const [p] = parseDbtErrors('Compilation Error in model x (models/x.sql)\n  bad thing\n    line 7\n      code');
  assert.equal(p.line, 6);
});

// Real dbt-core 1.12.7 output for a failing test and a warn-severity test.
test('test failure ([ERROR]: in test ...) maps to the yml file', () => {
  const out = [
    '08:57:08  Completed with 1 error, 0 partial successes, and 0 warnings:',
    '08:57:08  ',
    '08:57:08  [ERROR]: in test unique_dup_id (models\\dup.yml)',
    '08:57:08    Got 1 result, configured to fail if != 0',
    '08:57:08  ',
    '08:57:08    compiled code at target\\compiled\\demo\\models\\dup.yml\\unique_dup_id.sql'
  ].join('\n');
  const problems = parseDbtErrors(out);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].relPath, 'models\\dup.yml');
  assert.equal(problems[0].severity, 'error');
  assert.equal(problems[0].message, 'Failure in test unique_dup_id: Got 1 result, configured to fail if != 0');
});

test('test warning ([WARNING]: in test ...) is a warning with its message', () => {
  const out = [
    '08:57:23  Completed with 1 warning:',
    '08:57:23  ',
    '08:57:23  [WARNING]: in test unique_dup_id (models\\dup.yml)',
    '08:57:23  [WARNING]: Got 1 result, configured to warn if != 0',
    '08:57:23  ',
    '08:57:23    compiled code at target\\compiled\\demo\\models\\dup.yml\\unique_dup_id.sql'
  ].join('\n');
  const problems = parseDbtErrors(out);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].severity, 'warning');
  assert.equal(problems[0].message, 'Warning in test unique_dup_id: Got 1 result, configured to warn if != 0');
});

test('clean run yields no problems', () => {
  assert.deepEqual(parseDbtErrors('09:00:00  Done. PASS=3 WARN=0 ERROR=0 SKIP=0 NO-OP=0 REUSED=0 TOTAL=3'), []);
});
