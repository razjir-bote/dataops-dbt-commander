import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { compiledPath, parseShowOutput } from '../show';
import { modelSelector } from '../dbt';

// Lines captured from dbt-core 1.12.7 `dbt show --output json --log-format json`.
const showOk = [
  '{"data": {"version": "=1.12.7"}, "info": {"level": "info", "msg": "Running with dbt=1.12.7", "name": "MainReportVersion"}}',
  '{"data": {"is_inline": false, "node_name": "b", "output_format": "json", "preview": "[{\\"id\\": 1}]", "quiet": false, "unique_id": "model.demo.b"}, "info": {"category": "", "code": "Q041", "level": "info", "msg": "{}", "name": "ShowNode"}}'
].join('\n');

const showErr =
  '{"data": {"exc": "Runtime Error\\n  Runtime Error in model bad (models\\\\bad.sql)\\n    Catalog Error: Table with name does_not_exist does not exist!"}, "info": {"code": "Z002", "level": "error", "msg": "[\\u001b[31mERROR\\u001b[0m]: Encountered an error:", "name": "MainEncounteredError"}}';

test('parseShowOutput returns the preview rows', () => {
  assert.deepEqual(parseShowOutput(showOk), { rows: [{ id: 1 }] });
});

test('parseShowOutput returns the dbt error text when there is no preview', () => {
  const r = parseShowOutput(showErr);
  assert.equal(r.rows, undefined);
  assert.match(r.error ?? '', /Catalog Error: Table with name does_not_exist/);
});

test('parseShowOutput falls back to raw output when nothing is recognised', () => {
  assert.match(parseShowOutput('Traceback: boom').error ?? '', /Traceback: boom/);
});

test('compiledPath maps a model to target/compiled/<project>/...', () => {
  const root = path.join('C:/p');
  assert.equal(compiledPath(root, 'demo', undefined, path.join(root, 'models', 'b.sql')), path.join(root, 'target', 'compiled', 'demo', 'models', 'b.sql'));
  assert.equal(compiledPath(root, 'demo', 'build', path.join(root, 'models', 'b.sql')), path.join(root, 'build', 'compiled', 'demo', 'models', 'b.sql'));
});

test('modelSelector works for folders, including models itself', () => {
  const root = path.join('C:/p');
  assert.equal(modelSelector(root, path.join(root, 'models')), 'path:models');
  assert.equal(modelSelector(root, path.join(root, 'models', 'staging')), 'path:models/staging');
});
