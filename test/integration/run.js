// Runs the integration suite inside a real VS Code against a copy of test/fixtures/demo,
// using a dbt-core 1.12 + dbt-duckdb venv that is created on first run and cached in .vscode-test/.
// By default the suite's groups (groups.js) run in parallel — one VS Code, user-data folder and project copy each.
// `--serial` (or ITEST_SERIAL=1) runs every step in one VS Code, in order (as before; easier to debug).
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { GROUPS } = require('./groups');

const repo = path.resolve(__dirname, '..', '..');
const cache = path.join(repo, '.vscode-test');
const venv = path.join(cache, 'dbt-venv');
const serial = process.argv.includes('--serial') || process.env.ITEST_SERIAL === '1';
const isWin = process.platform === 'win32';
const venvPython = path.join(venv, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
const dbtExe = path.join(venv, isWin ? 'Scripts' : 'bin', isWin ? 'dbt.exe' : 'dbt');
const sqlfluffExe = path.join(venv, isWin ? 'Scripts' : 'bin', isWin ? 'sqlfluff.exe' : 'sqlfluff');

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

// SQLFluff for the optional linting checks (also added to a venv cached before it was needed).
function ensureSqlfluff() {
  if (!fs.existsSync(sqlfluffExe)) {
    execFileSync(venvPython, ['-m', 'pip', 'install', '--quiet', 'sqlfluff>=3,<5'], { stdio: 'inherit' });
  }
}

function ensureVenv() {
  if (fs.existsSync(dbtExe)) {
    let works = false;
    try {
      execFileSync(dbtExe, ['--version'], { stdio: 'ignore' });
      works = true;
    } catch {
      // e.g. a cached venv whose base Python moved: rebuild it
      console.log('Cached dbt venv is broken; rebuilding ...');
      fs.rmSync(venv, { recursive: true, force: true });
    }
    if (works) {
      ensureSqlfluff(); // outside the try: a pip failure must not wipe a working dbt venv
      return;
    }
  }
  const [py, ...pyArgs] = basePython();
  console.log(`Creating dbt venv with ${py} ${pyArgs.join(' ')} ...`);
  execFileSync(py, [...pyArgs, '-m', 'venv', venv], { stdio: 'inherit' });
  execFileSync(venvPython, ['-m', 'pip', 'install', '--quiet', 'dbt-core~=1.12.0', 'dbt-duckdb'], { stdio: 'inherit' });
  ensureSqlfluff();
}

function freshProject(work) {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.cpSync(path.join(repo, 'test', 'fixtures', 'demo'), work, { recursive: true });
  fs.mkdirSync(path.join(work, '.vscode'), { recursive: true });
  fs.writeFileSync(
    path.join(work, '.vscode', 'settings.json'),
    JSON.stringify({ 'dbtCommander.venvPath': venv, 'dbtCommander.openDocsAfterGenerate': false, 'dbtCommander.autoParse': false }, null, 2)
  );
}

/** One VS Code running the suite (one group, or everything) on its own project copy; resolves with its result lines. */
async function runOne(vscodeExecutablePath, label, group) {
  const work = path.join(cache, 'work', label, 'demo');
  const results = path.join(cache, `results-${label}.txt`);
  const started = Date.now();
  try {
    // Inside the try: a locked folder (e.g. a VS Code left over from an earlier run) fails this group, not the others.
    freshProject(work);
    fs.rmSync(results, { force: true });
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: repo,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [work, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', path.join(cache, `user-data-${label}`)],
      extensionTestsEnv: { DBT_PROJ: work, ITEST_OUT: results, ...(group ? { ITEST_GROUP: group } : {}) }
    });
  } catch (e) {
    console.error(`VS Code test run ${label} failed:`, e);
  }
  const out = fs.existsSync(results) ? fs.readFileSync(results, 'utf8').trim() : `FAIL ${label}: no results written`;
  return { label, out, secs: ((Date.now() - started) / 1000).toFixed(0) };
}

(async () => {
  ensureVenv();
  // Download VS Code once, before any parallel instance would race to do it.
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: process.env.VSCODE_VERSION || 'stable', cachePath: cache });
  const started = Date.now();
  const runs = serial
    ? [await runOne(vscodeExecutablePath, 'serial')]
    : await Promise.all(GROUPS.map((_, i) => runOne(vscodeExecutablePath, `g${i + 1}`, String(i + 1))));
  for (const r of runs) {
    console.log(`== ${r.label} (${r.secs}s)`);
    console.log(r.out);
  }
  const all = runs.map(r => r.out).join('\n');
  const pass = (all.match(/^PASS /gm) ?? []).length;
  const fail = (all.match(/^FAIL /gm) ?? []).length;
  console.log(`== ${pass} passed, ${fail} failed in ${((Date.now() - started) / 1000).toFixed(0)}s (${serial ? 'serial' : `${runs.length} groups in parallel`})`);
  process.exit(fail ? 1 : 0);
})();
