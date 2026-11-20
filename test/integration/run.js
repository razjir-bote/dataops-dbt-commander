// Runs the integration suite inside a real VS Code against a copy of test/fixtures/demo,
// using a dbt-core 1.12 + dbt-duckdb venv that is created on first run and cached in .vscode-test/.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { runTests } = require('@vscode/test-electron');

const repo = path.resolve(__dirname, '..', '..');
const cache = path.join(repo, '.vscode-test');
const venv = path.join(cache, 'dbt-venv');
const work = path.join(cache, 'work', 'demo');
const results = path.join(cache, 'results.txt');
const isWin = process.platform === 'win32';
const venvPython = path.join(venv, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
const dbtExe = path.join(venv, isWin ? 'Scripts' : 'bin', isWin ? 'dbt.exe' : 'dbt');

function basePython() {
  if (process.env.DBT_PYTHON) return [process.env.DBT_PYTHON];
  if (isWin) {
    try {
      execFileSync('py', ['-3.12', '--version'], { stdio: 'ignore' });
      return ['py', '-3.12'];
    } catch {
      /* fall through */
    }
  }
  return [isWin ? 'python' : 'python3'];
}

function ensureVenv() {
  if (fs.existsSync(dbtExe)) {
    try {
      execFileSync(dbtExe, ['--version'], { stdio: 'ignore' });
      return;
    } catch {
      // e.g. a cached venv whose base Python moved: rebuild it
      console.log('Cached dbt venv is broken; rebuilding ...');
      fs.rmSync(venv, { recursive: true, force: true });
    }
  }
  const [py, ...pyArgs] = basePython();
  console.log(`Creating dbt venv with ${py} ${pyArgs.join(' ')} ...`);
  execFileSync(py, [...pyArgs, '-m', 'venv', venv], { stdio: 'inherit' });
  execFileSync(venvPython, ['-m', 'pip', 'install', '--quiet', 'dbt-core~=1.12.0', 'dbt-duckdb'], { stdio: 'inherit' });
}

function freshProject() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.cpSync(path.join(repo, 'test', 'fixtures', 'demo'), work, { recursive: true });
  fs.mkdirSync(path.join(work, '.vscode'), { recursive: true });
  fs.writeFileSync(
    path.join(work, '.vscode', 'settings.json'),
    JSON.stringify({ 'dbtCommander.venvPath': venv, 'dbtCommander.openDocsAfterGenerate': false }, null, 2)
  );
}

(async () => {
  ensureVenv();
  freshProject();
  fs.rmSync(results, { force: true });
  try {
    await runTests({
      version: process.env.VSCODE_VERSION || 'stable',
      cachePath: cache,
      extensionDevelopmentPath: repo,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [work, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', path.join(cache, 'user-data')],
      extensionTestsEnv: { DBT_PROJ: work, ITEST_OUT: results }
    });
  } catch (e) {
    console.error('VS Code test run failed:', e);
  }
  const out = fs.existsSync(results) ? fs.readFileSync(results, 'utf8') : 'FAIL no results written';
  console.log(out);
  process.exit(/^FAIL/m.test(out) ? 1 : 0);
})();
