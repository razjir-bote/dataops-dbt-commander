import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
  CONFIG_FILES,
  CONFIG_FILES_BY_PRIORITY,
  configCore,
  configHasDialect,
  configSearchDirs,
  dialectFor,
  fixAccepted,
  fixArgs,
  fixCopy,
  fixPathArgs,
  fixedText,
  isFixCopy,
  lintArgs,
  lintPathArgs,
  parseLintJson,
  parseSqlfluffVersion,
  refusesStdin,
  sqlfluffExecutable,
  templaterArg
} from '../sqlfluff';

test('configCore: templater from the core section only, lower case, quotes dropped', () => {
  assert.deepEqual(configCore('.sqlfluff', '[sqlfluff]\ndialect = tsql\ntemplater = dbt\n'), { dialect: true, templater: 'dbt' });
  assert.deepEqual(configCore('.sqlfluff', '[sqlfluff]\nTemplater: DBT\n'), { dialect: false, templater: 'dbt' });
  assert.deepEqual(configCore('.sqlfluff', '[sqlfluff:templater:dbt]\nproject_dir = .\n'), { dialect: false });
  assert.deepEqual(configCore('pyproject.toml', '[tool.sqlfluff.core]\ntemplater = "dbt"\n'), { dialect: false, templater: 'dbt' });
  assert.deepEqual(configCore('setup.cfg', '[metadata]\ntemplater = dbt\n'), { dialect: false });
  assert.equal(configCore('.sqlfluff', '[sqlfluff]\n# templater = dbt\ntemplater = jinja\n').templater, 'jinja');
});

test('config files by priority: the same files, the one SQLFluff lets win first', () => {
  assert.deepEqual([...CONFIG_FILES_BY_PRIORITY].sort(), [...CONFIG_FILES].sort());
  assert.deepEqual(CONFIG_FILES_BY_PRIORITY, ['pyproject.toml', '.sqlfluff', 'tox.ini', 'setup.cfg']);
});

test('templaterArg: --templater dbt / --templater=dbt, the last one wins', () => {
  assert.equal(templaterArg(['--rules', 'LT01', '--templater', 'dbt']), 'dbt');
  assert.equal(templaterArg(['--templater=DBT']), 'dbt');
  assert.equal(templaterArg(['--templater', 'dbt', '--templater=jinja']), 'jinja');
  assert.equal(templaterArg(['--templater']), undefined);
  assert.equal(templaterArg([]), undefined);
});

test('refusesStdin: the dbt templater message, on stdout or stderr', () => {
  assert.ok(refusesStdin('User Error: The dbt templater does not support stdin input, provide a path instead'));
  assert.ok(!refusesStdin('[{"filepath": "stdin", "violations": []}]'));
});

test('path mode arguments: the saved file, no stdin; fix writes a marked copy beside it', () => {
  const f = path.join('proj', 'models', 'a.sql');
  assert.deepEqual(lintPathArgs(f, 'tsql', ['--rules', 'LT01']), ['lint', f, '--format', 'json', '--disable-progress-bar', '--dialect', 'tsql', '--rules', 'LT01']);
  const { suffix, copy } = fixCopy(f, '12-3');
  assert.equal(copy, path.join('proj', 'models', 'a' + suffix + '.sql'));
  assert.ok(isFixCopy(copy) && !isFixCopy(f));
  assert.deepEqual(fixPathArgs(f, suffix, undefined, []), ['fix', f, '--fixed-suffix', suffix, '--disable-progress-bar']);
  // SQLFluff 2.x asks before fixing a path unless -f.
  assert.deepEqual(fixPathArgs(f, suffix, 'tsql', [], true), ['fix', f, '-f', '--fixed-suffix', suffix, '--disable-progress-bar', '--dialect', 'tsql']);
});

test('parseLintJson reads SQLFluff 3/4 violations (1-based → 0-based) and older line_no fields', () => {
  const out = JSON.stringify([
    {
      filepath: 'stdin',
      violations: [
        { start_line_no: 2, start_line_pos: 5, end_line_no: 2, end_line_pos: 9, code: 'LT01', description: 'Expected single whitespace.', name: 'layout.spacing', warning: false },
        { start_line_no: 1, start_line_pos: 11, code: 'TMP', description: "Undefined jinja template variable: 'x'", name: '', warning: false },
        { line_no: 3, line_pos: 1, code: 'CP01', description: 'Keywords must be consistently upper case.', name: 'capitalisation.keywords', warning: true }
      ]
    }
  ]);
  assert.deepEqual(parseLintJson(out), [
    { line: 1, col: 4, endLine: 1, endCol: 8, code: 'LT01', message: 'Expected single whitespace.', rule: 'layout.spacing', warning: false },
    { line: 0, col: 10, endLine: 0, endCol: 11, code: 'TMP', message: "Undefined jinja template variable: 'x'", rule: undefined, warning: false },
    { line: 2, col: 0, endLine: 2, endCol: 1, code: 'CP01', message: 'Keywords must be consistently upper case.', rule: 'capitalisation.keywords', warning: true }
  ]);
});

test('parseLintJson: ignored file, noise around the JSON, garbage', () => {
  assert.deepEqual(parseLintJson('[]\n'), []);
  assert.equal(parseLintJson('WARNING something\n[{"filepath": "stdin", "violations": []}]\n')?.length, 0);
  assert.equal(parseLintJson('Traceback ...'), undefined);
});

test('dialectFor maps dbt adapters to SQLFluff dialects', () => {
  assert.equal(dialectFor('synapse'), 'tsql');
  assert.equal(dialectFor('sqlserver'), 'tsql');
  assert.equal(dialectFor('fabric'), 'tsql');
  assert.equal(dialectFor('databricks'), 'databricks');
  assert.equal(dialectFor('spark'), 'sparksql');
  assert.equal(dialectFor('duckdb'), 'duckdb');
  assert.equal(dialectFor('snowflake'), 'snowflake');
  assert.equal(dialectFor('something_new'), 'ansi');
  assert.equal(dialectFor(undefined), 'ansi');
});

test('configHasDialect finds dialect in .sqlfluff / setup.cfg / tox.ini / pyproject.toml sections only', () => {
  assert.equal(configHasDialect('.sqlfluff', '[sqlfluff]\ndialect = tsql\n'), true);
  assert.equal(configHasDialect('.sqlfluff', '[sqlfluff]\ntemplater = jinja\n[sqlfluff:rules]\ndialect = x\n'), false);
  assert.equal(configHasDialect('setup.cfg', '[metadata]\nname=x\n[sqlfluff]\n  dialect=postgres\n'), true);
  assert.equal(configHasDialect('pyproject.toml', '[tool.sqlfluff.core]\ndialect = "snowflake"\n'), true);
  assert.equal(configHasDialect('pyproject.toml', '[tool.black]\ndialect = "x"\n'), false);
  assert.equal(configHasDialect('.sqlfluff', '[sqlfluff]\n# dialect = tsql\n'), false);
});

test('lint / fix arguments: stdin with the file name, dialect only when given, extra flags last', () => {
  const f = path.resolve('models', 'a.sql');
  assert.deepEqual(lintArgs(f, 'tsql', ['--rules', 'LT01']), ['lint', '-', '--stdin-filename', f, '--format', 'json', '--disable-progress-bar', '--dialect', 'tsql', '--rules', 'LT01']);
  assert.deepEqual(fixArgs(f, undefined, []), ['fix', '-', '--stdin-filename', f, '--disable-progress-bar']);
});

test('fixedText: Windows CRLF output is mapped back to the file\'s line endings; unchanged / empty = no edit', () => {
  assert.equal(fixedText('select\r\n    a\r\nfrom x\r\n', 'select a from x\n', '\n'), 'select\n    a\nfrom x\n');
  assert.equal(fixedText('select a\r\n', 'select a\r\n', '\r\n'), undefined, 'unchanged');
  assert.equal(fixedText('select a from where (\r\n', 'select a from where (\n', '\n'), undefined, 'unparsable: echoed back');
  assert.equal(fixedText('', 'select 1\n', '\n'), undefined, 'no output');
});

test('sqlfluffExecutable and version', () => {
  const venv = path.resolve('venv');
  assert.equal(sqlfluffExecutable(venv, p => p === path.join(venv, 'Scripts', 'sqlfluff.exe')), path.join(venv, 'Scripts', 'sqlfluff.exe'));
  assert.equal(sqlfluffExecutable(venv, p => p === path.join(venv, 'bin', 'sqlfluff')), path.join(venv, 'bin', 'sqlfluff'));
  assert.equal(sqlfluffExecutable(venv, () => false), undefined);
  assert.equal(sqlfluffExecutable('  ', () => true), undefined);
  assert.equal(parseSqlfluffVersion('sqlfluff, version 4.5.0\n'), '4.5.0');
  assert.equal(parseSqlfluffVersion('nope'), undefined);
});

test('configSearchDirs: the file folder up to the drive root, then home and the user config folder, no repeats', () => {
  const file = path.resolve('work', 'proj', 'models', 'legacy', 'a.sql');
  const dirs = configSearchDirs(file, path.resolve('work'), path.resolve('appdir'));
  assert.equal(dirs[0], path.dirname(file));
  assert.ok(dirs.includes(path.resolve('work', 'proj')));
  assert.equal(dirs.filter(d => d === path.resolve('work')).length, 1, 'home listed once');
  assert.equal(dirs[dirs.length - 1], path.resolve('appdir'));
});

test('fixAccepted: exit 0, or 1 (unfixable violations left), and never a killed or failed run', () => {
  assert.equal(fixAccepted(undefined), true);
  assert.equal(fixAccepted({ code: 1, killed: false }), true);
  assert.equal(fixAccepted({ code: 1, killed: true }), false, 'timeout');
  assert.equal(fixAccepted({ code: 2, killed: false }), false, 'SQLFluff error');
  assert.equal(fixAccepted({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }), false);
});
