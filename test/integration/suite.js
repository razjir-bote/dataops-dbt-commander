// Runs inside the VS Code extension host (see run.js) against a fresh copy of test/fixtures/demo.
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

exports.run = async () => {
  const root = process.env.DBT_PROJ;
  const out = [];
  const step = async (name, fn) => {
    try {
      await fn();
      out.push('PASS ' + name);
    } catch (e) {
      out.push('FAIL ' + name + ': ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    }
  };
  const uri = (...p) => vscode.Uri.file(path.join(root, ...p));
  const file = (...p) => path.join(root, ...p);
  const results = () => JSON.parse(fs.readFileSync(file('target', 'run_results.json'), 'utf8')).results.map(r => r.unique_id).sort();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = (cmd, ...p) => vscode.commands.executeCommand(`dbtRunner.${cmd}`, uri(...p), [uri(...p)]);
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  await vscode.extensions.getExtension('local.dbt-runner').activate();
  const cfg = () => vscode.workspace.getConfiguration('dbtRunner');

  await step('venv setting read from workspace', async () => assert.ok(fs.existsSync(cfg().get('venvPath'))));

  await step('build single model (right-click)', async () => {
    await run('build', 'models', 'b.sql');
    const r = results();
    assert.equal(r.length, 2, r.join());
    assert.equal(r[0], 'model.demo.b');
    assert.match(r[1], /^test\.demo\.not_null_b_id/);
  });

  await step('folder run selects only that folder', async () => {
    await run('run', 'models', 'staging');
    assert.deepEqual(results(), ['model.demo.stg_a']);
  });

  await step('whole models folder', async () => {
    await run('run', 'models');
    assert.deepEqual(results(), ['model.demo.b', 'model.demo.c', 'model.demo.stg_a']);
  });

  await step('build + upstream', async () => {
    await run('buildUpstream', 'models', 'c.sql');
    assert.deepEqual(results().filter(r => r.startsWith('model.')), ['model.demo.b', 'model.demo.c', 'model.demo.stg_a']);
  });

  await step('unsaved edits are saved before running', async () => {
    const doc = await vscode.workspace.openTextDocument(uri('models', 'b.sql'));
    const ed = await vscode.window.showTextDocument(doc);
    await ed.edit(e => e.insert(new vscode.Position(0, 0), '-- edited\n'));
    assert.ok(doc.isDirty);
    await vscode.commands.executeCommand('dbtRunner.run'); // no uri: active editor (▶ / shortcut path)
    assert.ok(!doc.isDirty, 'document still dirty');
    assert.deepEqual(results(), ['model.demo.b']);
  });

  await step('compile opens compiled SQL beside', async () => {
    await vscode.commands.executeCommand('dbtRunner.compile', uri('models', 'b.sql'));
    await sleep(500);
    const compiled = file('target', 'compiled', 'demo', 'models', 'b.sql');
    const ed = vscode.window.visibleTextEditors.find(e => same(e.document.uri.fsPath, compiled));
    assert.ok(ed, 'compiled file not open');
    assert.match(ed.document.getText(), /stg_a/);
  });

  await step('errors land in Problems, survive other runs, clear when fixed', async () => {
    const bad = file('models', 'bad.sql');
    fs.writeFileSync(bad, 'select * from does_not_exist\n');
    await run('build', 'models', 'bad.sql');
    let diags = vscode.languages.getDiagnostics(uri('models', 'bad.sql'));
    assert.equal(diags.length, 1, JSON.stringify(diags));
    assert.match(diags[0].message, /Catalog Error/);
    assert.equal(diags[0].source, 'dbt');
    await run('run', 'models', 'b.sql');
    assert.equal(vscode.languages.getDiagnostics(uri('models', 'bad.sql')).length, 1, 'unrelated run cleared bad.sql');
    fs.writeFileSync(bad, 'select 1 as id\n');
    await run('run', 'models', 'bad.sql');
    diags = vscode.languages.getDiagnostics(uri('models', 'bad.sql'));
    fs.unlinkSync(bad);
    assert.equal(diags.length, 0, 'fixed model still has problems');
  });

  await step('test failure lands on the yml, clears when the test passes', async () => {
    fs.writeFileSync(file('models', 'dup.sql'), 'select 1 as id union all select 1\n');
    fs.writeFileSync(file('models', 'dup.yml'), 'version: 2\nmodels:\n  - name: dup\n    columns:\n      - name: id\n        data_tests: [unique]\n');
    await run('build', 'models', 'dup.sql');
    const diags = vscode.languages.getDiagnostics(uri('models', 'dup.yml'));
    assert.equal(diags.length, 1, JSON.stringify(diags));
    assert.match(diags[0].message, /unique_dup_id/);
    fs.writeFileSync(file('models', 'dup.sql'), 'select 1 as id\n');
    await run('build', 'models', 'dup.sql');
    const after = vscode.languages.getDiagnostics(uri('models', 'dup.yml')).length;
    fs.unlinkSync(file('models', 'dup.sql'));
    fs.unlinkSync(file('models', 'dup.yml'));
    assert.equal(after, 0);
  });

  await step('same command twice at once does not hang', async () => {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 90000));
    await Promise.race([Promise.all([run('run', 'models', 'b.sql'), run('run', 'models', 'b.sql')]), timeout]);
  });

  if (process.platform === 'win32') {
    await step('closing a running task kills dbt and its python child', async () => {
      const slow = file('models', 'slow.sql');
      fs.writeFileSync(slow, "{{ config(materialized='table') }}\nselect sum((i * 7919) % 104729) as n from range(20000000000) t(i)\n");
      const running = run('run', 'models', 'slow.sql');
      await sleep(10000);
      const procs = () =>
        execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.ExecutablePath)" }'])
          .toString().trim().split(/\r?\n/)
          .map(l => { const [pid, ppid, name, exe] = l.trim().split('|'); return { pid: +pid, ppid: +ppid, name, exe: (exe || '').toLowerCase() }; });
      const venv = path.resolve(cfg().get('venvPath')).toLowerCase();
      const all = procs();
      const ids = new Set(all.filter(p => p.name === 'dbt.exe' && p.exe.startsWith(venv)).map(p => p.pid));
      for (let grew = true; grew; ) {
        grew = false;
        for (const p of all) if (ids.has(p.ppid) && !ids.has(p.pid)) { ids.add(p.pid); grew = true; }
      }
      const tree = all.filter(p => ids.has(p.pid)).map(p => `${p.pid}:${p.name}`);
      for (const e of vscode.tasks.taskExecutions) e.terminate();
      await running;
      await sleep(3000);
      const alive = procs().filter(p => ids.has(p.pid)).map(p => `${p.pid}:${p.name}`);
      fs.unlinkSync(slow);
      assert.ok(tree.some(t => t.endsWith('python.exe')), 'dbt was not running: ' + tree.join(','));
      assert.deepEqual(alive, [], `tree=${tree.join(',')}`);
    });
  }

  await step("Ctrl+' shortcut chords are unused by VS Code defaults", async () => {
    await vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
    await sleep(1500);
    const text = vscode.window.activeTextEditor.document.getText();
    assert.ok(text.length > 10000, 'default keybindings not loaded');
    const keys = [...text.matchAll(/"key":\s*"([^"]+)",\s*"command":\s*"([^"]+)"/g)].filter(m => !m[2].startsWith('dbtRunner.')).map(m => m[1]);
    const ours = require(path.resolve(__dirname, '..', '..', 'package.json')).contributes.keybindings.map(k => k.key);
    const clash = ours.filter(k => keys.includes(k) || keys.includes(k.split(' ')[0]));
    assert.deepEqual(clash, []);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  await step('target setting is applied', async () => {
    await cfg().update('target', 'prod', vscode.ConfigurationTarget.Workspace);
    await run('run', 'models', 'staging', 'stg_a.sql');
    await cfg().update('target', undefined, vscode.ConfigurationTarget.Workspace);
    assert.ok(fs.existsSync(file('prod.duckdb')));
  });

  await step('preview runs; runtime keeps big integers exact', async () => {
    await vscode.commands.executeCommand('dbtRunner.preview', uri('models', 'b.sql'));
    let source;
    JSON.parse('[12345678901234567890]', (k, v, ctx) => (k === '0' && (source = ctx && ctx.source), v));
    assert.equal(source, '12345678901234567890', 'JSON.parse source text access unavailable in this VS Code');
  });

  // ----- language features (manifest.json exists after the runs above) -----

  const definition = async (rel, needle) => {
    const doc = await vscode.workspace.openTextDocument(uri(...rel));
    const off = doc.getText().indexOf(needle);
    assert.ok(off >= 0, `${needle} not in ${rel.join('/')}`);
    const locs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, doc.positionAt(off + 1));
    const loc = (locs || [])[0];
    return loc && { file: (loc.uri || loc.targetUri).fsPath, line: (loc.range || loc.targetRange).start.line };
  };

  await step('go to definition: ref() opens the model', async () => {
    const d = await definition(['models', 'c.sql'], "'b'");
    assert.ok(d && same(d.file, file('models', 'b.sql')), JSON.stringify(d));
  });

  await step('go to definition: source() opens the YAML at the table', async () => {
    const d = await definition(['analyses', 'from_source.sql'], "'customers'");
    assert.ok(d && same(d.file, file('models', 'sources.yml')), JSON.stringify(d));
    const lines = fs.readFileSync(file('models', 'sources.yml'), 'utf8').split(/\r?\n/);
    assert.match(lines[d.line], /name:\s*customers/);
  });

  await step('completion: ref() models and source() tables', async () => {
    const tmps = [];
    const labels = async text => {
      // A new file per case: VS Code keeps an opened document's first contents.
      const tmp = file('models', `zz_completion_${tmps.length}.sql`);
      tmps.push(tmp);
      fs.writeFileSync(tmp, text);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmp));
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, doc.positionAt(text.length));
      return list.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label));
    };
    try {
      const models = await labels("select * from {{ ref('");
      assert.ok(['b', 'c', 'stg_a'].every(m => models.includes(m)), models.slice(0, 20).join(','));
      const sources = await labels("select * from {{ source('");
      assert.ok(sources.includes('raw'), sources.slice(0, 20).join(','));
      const tables = await labels("select * from {{ source('raw', '");
      assert.ok(tables.includes('orders') && tables.includes('customers'), tables.slice(0, 20).join(','));
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      tmps.forEach(t => fs.rmSync(t, { force: true }));
    }
  });

  await step('CodeLens: Run · Build · Test · Compile · Preview above a model', async () => {
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri('models', 'b.sql'));
    const cmds = lenses.map(l => l.command && l.command.command);
    assert.deepEqual(cmds, ['dbtRunner.run', 'dbtRunner.build', 'dbtRunner.test', 'dbtRunner.compile', 'dbtRunner.preview']);
    const none = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri('analyses', 'from_source.sql'));
    assert.equal(none.length, 0, 'lenses shown outside models/');
  });

  await step('go to definition without a manifest falls back to the file name', async () => {
    fs.rmSync(file('target', 'manifest.json'), { force: true });
    const d = await definition(['models', 'c.sql'], "'b'");
    assert.ok(d && same(d.file, file('models', 'b.sql')), JSON.stringify(d));
  });

  await step('seed / deps / docs generate (static, not opened) / snapshot', async () => {
    await vscode.commands.executeCommand('dbtRunner.seed');
    assert.deepEqual(results(), ['seed.demo.s']);
    await vscode.commands.executeCommand('dbtRunner.deps');
    fs.rmSync(file('target', 'static_index.html'), { force: true });
    await vscode.commands.executeCommand('dbtRunner.docsGenerate'); // openDocsAfterGenerate=false in workspace settings
    assert.ok(fs.existsSync(file('target', 'static_index.html')), 'static_index.html not generated');
    await vscode.commands.executeCommand('dbtRunner.snapshot');
  });

  fs.writeFileSync(process.env.ITEST_OUT, out.join('\n'));
};
