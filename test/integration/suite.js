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
  const run = (cmd, ...p) => vscode.commands.executeCommand(`dbtCommander.${cmd}`, uri(...p), [uri(...p)]);
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  const api = await vscode.extensions.getExtension('local.dataops-dbt-commander').activate();
  // v0.8 commands with their inputs given directly (no input boxes / refactor preview in tests).
  const createStaging = (item, rel) => api.projectEdits.createStaging(item, rel);
  const newModelIn = (folderUri, name) => api.projectEdits.newModel(folderUri, name);
  const rename = (u, name) => api.projectEdits.rename(u, name, false);
  const cfg = () => vscode.workspace.getConfiguration('dbtCommander');

  await step('venv setting read from workspace', async () => assert.ok(fs.existsSync(cfg().get('venvPath'))));

  await step('settings saved under the old name (dbtRunner.*) are migrated to dbtCommander.*', async () => {
    const settingsFile = file('.vscode', 'settings.json');
    const original = fs.readFileSync(settingsFile, 'utf8');
    const s = JSON.parse(original);
    s['dbtRunner.previewLimit'] = 7;
    fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
    try {
      const end = Date.now() + 8000;
      while (vscode.workspace.getConfiguration().inspect('dbtRunner.previewLimit')?.workspaceValue !== 7) {
        if (Date.now() > end) throw new Error('old setting never loaded');
        await sleep(200);
      }
      assert.equal(await api.migrateSettings(), 1);
      assert.equal(cfg().get('previewLimit'), 7);
      assert.equal(await api.migrateSettings(), 0, 'migrated twice');
    } finally {
      await cfg().update('previewLimit', undefined, vscode.ConfigurationTarget.Workspace);
      fs.writeFileSync(settingsFile, original);
    }
  });

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
    await vscode.commands.executeCommand('dbtCommander.run'); // no uri: active editor (▶ / shortcut path)
    assert.ok(!doc.isDirty, 'document still dirty');
    assert.deepEqual(results(), ['model.demo.b']);
  });

  await step('compile opens compiled SQL beside', async () => {
    await vscode.commands.executeCommand('dbtCommander.compile', uri('models', 'b.sql'));
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
        execFileSync('powershell', [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.ExecutablePath)|$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })" }'
        ])
          .toString().trim().split(/\r?\n/)
          .map(l => { const [pid, ppid, name, exe, created] = l.trim().split('|'); return { pid: +pid, ppid: +ppid, name, exe: (exe || '').toLowerCase(), created: +created }; });
      const venv = path.resolve(cfg().get('venvPath')).toLowerCase();
      const all = procs();
      const byPid = new Map(all.map(p => [p.pid, p]));
      const ids = new Set(all.filter(p => p.name === 'dbt.exe' && p.exe.startsWith(venv)).map(p => p.pid));
      // Real children only: Windows reuses ids, so a boot-time process (csrss, winlogon...) can name a reused
      // id as its parent. A child must have been created after its parent.
      for (let grew = true; grew; ) {
        grew = false;
        for (const p of all) {
          const parent = byPid.get(p.ppid);
          if (ids.has(p.ppid) && !ids.has(p.pid) && parent && p.created >= parent.created) { ids.add(p.pid); grew = true; }
        }
      }
      const tree = all.filter(p => ids.has(p.pid)).map(p => `${p.pid}:${p.name}`);
      for (const e of vscode.tasks.taskExecutions) e.terminate();
      await running;
      await sleep(4000);
      const alive = procs().filter(p => ids.has(p.pid) && byPid.get(p.pid).created === p.created).map(p => `${p.pid}:${p.name}`);
      fs.unlinkSync(slow);
      assert.ok(tree.some(t => t.endsWith('python.exe')), 'dbt was not running: ' + tree.join(','));
      assert.ok(!tree.some(t => /csrss|winlogon|dwm|fontdrvhost/i.test(t)), 'system processes in the tree: ' + tree.join(','));
      assert.deepEqual(alive, [], `still running: ${alive.join(',')} (tree=${tree.join(',')})`);
    });
  }

  await step("Ctrl+' shortcut chords are unused by VS Code defaults", async () => {
    await vscode.commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
    await sleep(1500);
    const text = vscode.window.activeTextEditor.document.getText();
    assert.ok(text.length > 10000, 'default keybindings not loaded');
    const keys = [...text.matchAll(/"key":\s*"([^"]+)",\s*"command":\s*"([^"]+)"/g)].filter(m => !m[2].startsWith('dbtCommander.')).map(m => m[1]);
    const ours = require(path.resolve(__dirname, '..', '..', 'package.json'))
      .contributes.keybindings.filter(k => !/dbtCommander\.isScratchpad/.test(k.when || '') || k.key.startsWith("ctrl+'"))
      .map(k => k.key);
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
    await vscode.commands.executeCommand('dbtCommander.preview', uri('models', 'b.sql'));
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
    // Open the model first: right after closeAllEditors, VS Code's codelens command intermittently threw
    // "Illegal argument" while the document was being disposed.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri('models', 'b.sql')));
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri('models', 'b.sql'));
    // A model that has run also gets a status badge lens first (no command); the actions follow.
    const cmds = lenses.map(l => l.command && l.command.command).filter(Boolean);
    assert.deepEqual(cmds, ['dbtCommander.run', 'dbtCommander.build', 'dbtCommander.test', 'dbtCommander.compile', 'dbtCommander.preview']);
    const none = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri('analyses', 'from_source.sql'));
    assert.equal(none.length, 0, 'lenses shown outside models/');
  });

  // ----- v0.4: macros, YAML generation, sidebar -----

  await step('go to definition: project macro', async () => {
    const d = await definition(['analyses', 'uses_macro.sql'], 'cents_to_dollars');
    assert.ok(d && same(d.file, file('macros', 'money.sql')), JSON.stringify(d));
    assert.equal(d.line, 2);
  });

  await step("go to definition: dbt's own macro inside the venv", async () => {
    const d = await definition(['analyses', 'uses_macro.sql'], 'current_timestamp');
    assert.ok(d, 'no definition');
    assert.match(d.file.replace(/\\/g, '/'), /dbt\/include\/global_project\//);
    const line = fs.readFileSync(d.file, 'utf8').split(/\r?\n/)[d.line];
    assert.match(line, /macro\s+current_timestamp\s*\(/);
  });

  const docText = async f => (await vscode.workspace.openTextDocument(vscode.Uri.file(f))).getText();

  await step('generate YAML: appends a model to the folder yml', async () => {
    const before = fs.readFileSync(file('models', 'schema.yml'), 'utf8');
    await vscode.commands.executeCommand('dbtCommander.generateYaml', uri('models', 'c.sql'));
    const text = await docText(file('models', 'schema.yml'));
    assert.ok(text.startsWith(before.replace(/\s+$/, '')), 'existing lines of schema.yml changed');
    assert.match(text, /- name: b[\s\S]*- name: c\s/);
    assert.match(text, /- name: c\s+description: ""\s+columns:\s+- name: id\s+data_type: \S+/);
    await vscode.workspace.saveAll(false);
  });

  await step('generate YAML: creates <model>.yml when the folder has none', async () => {
    await vscode.commands.executeCommand('dbtCommander.generateYaml', uri('models', 'staging', 'stg_a.sql'));
    const f = file('models', 'staging', 'stg_a.yml');
    // VS Code applies the editor's line endings (CRLF by default on Windows) to inserted text.
    assert.match(await docText(f), /^version: 2\r?\n\r?\nmodels:\r?\n  - name: stg_a\r?\n/);
    await vscode.workspace.saveAll(false);
    assert.ok(fs.existsSync(f));
  });

  await step('generate YAML: merges missing columns and keeps comments', async () => {
    const f = file('models', 'staging', 'stg_a.yml');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), 'version: 2\nmodels:\n  - name: stg_a\n    description: "staging a" # keep me\n');
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    await vscode.commands.executeCommand('dbtCommander.generateYaml', uri('models', 'staging', 'stg_a.sql'));
    const text = await docText(f);
    assert.match(text, /# keep me/);
    assert.match(text, /description: "?staging a"?/);
    assert.match(text, /- name: id/);
    await vscode.workspace.saveAll(false);
  });

  const labels = items => items.map(i => (typeof i.label === 'string' ? i.label : i.label.label));
  const child = async (items, label) => {
    const it = items.find(i => labels([i])[0] === label);
    assert.ok(it, `no "${label}" in ${labels(items).join(', ')}`);
    return it;
  };

  await step('sidebar: sections, model folders, sources, seeds, tests', async () => {
    await vscode.commands.executeCommand('dbtCommander.parse'); // pick up the new YAML
    const top = await api.sidebar.getChildren();
    assert.deepEqual(labels(top), ['Models', 'Sources', 'Seeds', 'Snapshots', 'Tests']);
    const models = await api.sidebar.getChildren(await child(top, 'Models'));
    assert.deepEqual(labels(models), ['staging', 'b', 'c']);
    assert.deepEqual(labels(await api.sidebar.getChildren(await child(models, 'staging'))), ['stg_a']);
    const sources = await api.sidebar.getChildren(await child(top, 'Sources'));
    assert.deepEqual(labels(await api.sidebar.getChildren(await child(sources, 'raw'))), ['customers', 'orders']);
    const seeds = await api.sidebar.getChildren(await child(top, 'Seeds'));
    assert.deepEqual(labels(seeds), ['ref', 's']);
    assert.deepEqual(labels(await api.sidebar.getChildren(await child(seeds, 'ref'))), ['countries']);
    const groups = await api.sidebar.getChildren(await child(top, 'Tests'));
    assert.deepEqual(labels(await api.sidebar.getChildren(await child(groups, 'b'))), ['not_null_b_id']);
  });

  await step('sidebar: run a model, build a folder, run a test', async () => {
    const top = await api.sidebar.getChildren();
    const models = await api.sidebar.getChildren(await child(top, 'Models'));
    await vscode.commands.executeCommand('dbtCommander.tree.run', await child(models, 'b'));
    assert.deepEqual(results(), ['model.demo.b']);
    await vscode.commands.executeCommand('dbtCommander.tree.build', await child(models, 'staging'));
    assert.deepEqual(results(), ['model.demo.stg_a']);
    const groups = await api.sidebar.getChildren(await child(top, 'Tests'));
    const tests = await api.sidebar.getChildren(await child(groups, 'b'));
    await vscode.commands.executeCommand('dbtCommander.tree.runTest', tests[0]);
    assert.equal(results().length, 1);
    assert.match(results()[0], /^test\.demo\.not_null_b_id/);
  });

  // ----- v0.6: sidebar folders / sections, lineage -----

  await step('sidebar: seed folder and section buttons run on everything inside', async () => {
    const top = await api.sidebar.getChildren();
    const seedsSection = await child(top, 'Seeds');
    assert.equal(seedsSection.contextValue, 'section-seeds');
    assert.ok(same(seedsSection.resourceUri.fsPath, file('seeds')));
    const ref = await child(await api.sidebar.getChildren(seedsSection), 'ref');
    assert.equal(ref.contextValue, 'seedFolder');
    await vscode.commands.executeCommand('dbtCommander.tree.seed', ref);
    assert.deepEqual(results(), ['seed.demo.countries']);
    await vscode.commands.executeCommand('dbtCommander.tree.build', ref);
    assert.deepEqual(results(), ['seed.demo.countries']);
    await vscode.commands.executeCommand('dbtCommander.tree.seed', seedsSection);
    assert.deepEqual(results(), ['seed.demo.countries', 'seed.demo.s']);
    const models = await child(top, 'Models');
    assert.equal(models.contextValue, 'section-models');
    await vscode.commands.executeCommand('dbtCommander.tree.run', models);
    assert.deepEqual(results(), ['model.demo.b', 'model.demo.c', 'model.demo.stg_a']);
    const snaps = await child(top, 'Snapshots');
    assert.equal(snaps.contextValue, 'section-snapshots');
    await vscode.commands.executeCommand('dbtCommander.tree.snapshotAll', snaps);
    assert.deepEqual(results(), ['snapshot.demo.snap']);
  });

  await step('sidebar multi-select: one dbt command for the whole Ctrl-click selection', async () => {
    const top = await api.sidebar.getChildren();
    const models = await api.sidebar.getChildren(await child(top, 'Models'));
    const seeds = await api.sidebar.getChildren(await child(top, 'Seeds'));
    const [b, c, stagingFolder] = [await child(models, 'b'), await child(models, 'c'), await child(models, 'staging')];
    const [s, refFolder] = [await child(seeds, 's'), await child(seeds, 'ref')];

    // Run on two models: VS Code passes (clicked item, selection).
    await vscode.commands.executeCommand('dbtCommander.tree.run', b, [b, c]);
    assert.deepEqual(results(), ['model.demo.b', 'model.demo.c']);

    // Build a model, a model folder and a seed folder together.
    await vscode.commands.executeCommand('dbtCommander.tree.build', b, [b, stagingFolder, refFolder]);
    const r = results();
    for (const id of ['model.demo.b', 'model.demo.stg_a', 'seed.demo.countries']) {
      assert.ok(r.includes(id), `${id} missing from ${r.join(',')}`);
    }
    assert.ok(!r.includes('model.demo.c') && !r.includes('seed.demo.s'), 'built more than selected: ' + r.join(','));

    // Seed a seed and a seed folder.
    await vscode.commands.executeCommand('dbtCommander.tree.seed', s, [s, refFolder]);
    assert.deepEqual(results(), ['seed.demo.countries', 'seed.demo.s']);

    // A button on a row that isn't part of the selection acts on that row only.
    await vscode.commands.executeCommand('dbtCommander.tree.run', c, [b, stagingFolder]);
    assert.deepEqual(results(), ['model.demo.c']);

    // Build on a single seed (seeds are buildable now).
    await vscode.commands.executeCommand('dbtCommander.tree.build', s, [s]);
    assert.deepEqual(results(), ['seed.demo.s']);

    // Upstream / downstream on a selection: one command, graph operators on each selected item.
    await vscode.commands.executeCommand('dbtCommander.tree.buildDownstream', stagingFolder, [stagingFolder]);
    let g = results();
    for (const id of ['model.demo.stg_a', 'model.demo.b', 'model.demo.c', 'snapshot.demo.snap']) {
      assert.ok(g.includes(id), `downstream: ${id} missing from ${g.join(',')}`);
    }
    await vscode.commands.executeCommand('dbtCommander.tree.buildUpstream', c, [c, s]);
    g = results();
    for (const id of ['model.demo.stg_a', 'model.demo.b', 'model.demo.c', 'seed.demo.s']) {
      assert.ok(g.includes(id), `upstream: ${id} missing from ${g.join(',')}`);
    }
    assert.ok(!g.includes('seed.demo.countries') && !g.includes('snapshot.demo.snap'), 'upstream built too much: ' + g.join(','));

    // The project folder has no "upstream": refused, nothing runs.
    const rr = file('target', 'run_results.json');
    const before = fs.statSync(rr).mtimeMs;
    await vscode.commands.executeCommand('dbtCommander.tree.buildUpstream', { resourceUri: vscode.Uri.file(root), data: {} }, undefined);
    assert.equal(fs.statSync(rr).mtimeMs, before, 'dbt ran for upstream of the whole project');
  });

  const lineageTree = async () => {
    const [focus] = await api.lineage.getChildren();
    assert.ok(focus, 'no lineage focus');
    const [up, down] = await api.lineage.getChildren(focus);
    return { focus, up, down, upKids: await api.lineage.getChildren(up), downKids: await api.lineage.getChildren(down) };
  };

  await step('lineage: follows the open model; upstream and downstream, clickable', async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri('models', 'b.sql')));
    await api.lineage.follow(uri('models', 'b.sql'));
    const t = await lineageTree();
    assert.equal(t.focus.label, 'b');
    assert.deepEqual([t.up.label, t.down.label], ['Upstream', 'Downstream']);
    assert.deepEqual(labels(t.upKids), ['stg_a']);
    assert.deepEqual(labels(t.downKids), ['c', 'snap']);
    const c = t.downKids[0];
    assert.ok(same(c.command.arguments[0].fsPath, file('models', 'c.sql')));
    assert.equal(c.contextValue, 'lineage-model');
    const stg = t.upKids[0];
    assert.equal(stg.collapsibleState, vscode.TreeItemCollapsibleState.None); // stg_a has no parents
  });

  await step('lineage: pin a model, ignore other editors, follow again', async () => {
    await vscode.commands.executeCommand('dbtCommander.showLineage', uri('models', 'c.sql'));
    assert.deepEqual([api.lineage.current.id, api.lineage.current.pinned], ['model.demo.c', true]);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri('models', 'staging', 'stg_a.sql')));
    await api.lineage.follow(uri('models', 'staging', 'stg_a.sql'));
    assert.equal(api.lineage.current.id, 'model.demo.c', 'pinned lineage followed the editor');
    const t = await lineageTree();
    assert.deepEqual(labels(t.upKids), ['b']);
    const bUp = await api.lineage.getChildren(t.upKids[0]);
    assert.deepEqual(labels(bUp), ['stg_a'], 'expanding b upstream');
    await vscode.commands.executeCommand('dbtCommander.lineage.followEditor');
    assert.deepEqual([api.lineage.current.id, api.lineage.current.pinned], ['model.demo.stg_a', false]);
    await api.lineage.follow(uri('macros', 'money.sql')); // not a node: keeps the current one
    assert.equal(api.lineage.current.id, 'model.demo.stg_a');
  });

  // ----- v0.5: Testing panel, hovers -----

  const testItems = async () => {
    await api.tests.refresh();
    const projects = [];
    api.tests.controller.items.forEach(p => projects.push(p));
    assert.equal(projects.length, 1, 'expected one project in the Testing panel');
    const groups = new Map();
    projects[0].children.forEach(g => {
      const tests = [];
      g.children.forEach(t => tests.push(t));
      groups.set(g.label, tests);
    });
    return { project: projects[0], groups };
  };
  const runTests = items => api.tests.run(new vscode.TestRunRequest(items), new vscode.CancellationTokenSource().token);

  await step('Testing panel: tests grouped by model, located in the YAML', async () => {
    const { groups } = await testItems();
    const b = groups.get('b');
    assert.ok(b, 'no "b" group: ' + [...groups.keys()].join(','));
    assert.deepEqual(b.map(t => t.label), ['not_null_b_id']);
    const lines = fs.readFileSync(file('models', 'schema.yml'), 'utf8').split(/\r?\n/);
    assert.match(lines[b[0].range.start.line], /- name: id/);
  });

  await step('Testing panel: run one test → passed', async () => {
    const { groups } = await testItems();
    const t = groups.get('b')[0];
    // A refresh while the run is in progress (dbt rewrites the manifest) must not break the run.
    const [out] = await Promise.all([runTests([t]), (async () => { await sleep(200); await api.tests.refresh(); })()]);
    assert.deepEqual(out.get(t.id), { state: 'passed' });
    assert.equal(results().length, 1);
  });

  await step('Testing panel: failing test → failed with dbt message; group and project runs', async () => {
    fs.writeFileSync(file('models', 'dup.sql'), 'select 1 as id union all select 1\n');
    fs.writeFileSync(file('models', 'dup.yml'), 'version: 2\nmodels:\n  - name: dup\n    columns:\n      - name: id\n        data_tests: [unique, not_null]\n');
    try {
      await run('run', 'models', 'dup.sql'); // builds dup and refreshes the manifest
      const { project, groups } = await testItems();
      const dup = groups.get('dup');
      assert.deepEqual(dup.map(t => t.label).sort(), ['not_null_dup_id', 'unique_dup_id']);
      const groupItem = [];
      project.children.forEach(g => g.label === 'dup' && groupItem.push(g));
      const out = await runTests(groupItem);
      const unique = dup.find(t => t.label === 'unique_dup_id');
      const notNull = dup.find(t => t.label === 'not_null_dup_id');
      assert.equal(out.get(unique.id).state, 'failed');
      assert.match(out.get(unique.id).message, /Got 1 result, configured to fail if != 0/);
      assert.equal(out.get(notNull.id).state, 'passed');
      const all = await runTests([project]);
      assert.equal(all.size, 3, [...all.values()].map(o => o.state).join(','));
      assert.equal([...all.values()].filter(o => o.state === 'failed').length, 1);
      // Whole project minus the failing test: runs `dbt test --exclude unique_dup_id`.
      const fresh = await testItems();
      const failing = fresh.groups.get('dup').find(t => t.label === 'unique_dup_id');
      const rest = await api.tests.run(new vscode.TestRunRequest([fresh.project], [failing]), new vscode.CancellationTokenSource().token);
      assert.equal(rest.size, 2);
      assert.ok([...rest.values()].every(o => o.state === 'passed'), [...rest.values()].map(o => o.state).join(','));
      assert.ok(!results().some(r => r.startsWith('test.demo.unique_dup_id')), 'excluded test ran');
    } finally {
      fs.unlinkSync(file('models', 'dup.sql'));
      fs.unlinkSync(file('models', 'dup.yml'));
      await vscode.commands.executeCommand('dbtCommander.parse');
    }
  });

  const hoverText = async (rel, needle) => {
    const doc = await vscode.workspace.openTextDocument(uri(...rel));
    const off = doc.getText().indexOf(needle);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, doc.positionAt(off + 1));
    return hovers.flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : c.value))).join('\n');
  };

  await step('hover on ref() shows the model', async () => {
    const text = await hoverText(['models', 'c.sql'], "'b'");
    assert.match(text, /\*\*b\*\* · model · `view`/);
    assert.match(text, /`models\/b\.sql`/);
    assert.match(text, /\| `id` \|/);
  });

  await step('hover on source() shows the source table', async () => {
    const text = await hoverText(['analyses', 'from_source.sql'], "'customers'");
    assert.match(text, /\*\*raw\.customers\*\* · source/);
    assert.match(text, /`models\/sources\.yml`/);
  });

  // ----- v0.7: retry, rerun, run status, last run, columns, references, custom folders -----

  const waitFor = async (what, check, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await check();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out waiting for ' + what);
      await sleep(200);
    }
  };

  await step('dbt retry reruns only what failed; rerun last repeats the last command', async () => {
    const bad = file('models', 'zz_bad.sql');
    fs.writeFileSync(bad, 'select * from does_not_exist\n');
    try {
      await vscode.commands.executeCommand('dbtCommander.build', vscode.Uri.file(file('models')), [vscode.Uri.file(file('models'))]);
      assert.ok(results().includes('model.demo.zz_bad'));
      await waitFor('error badge', () => (api.runStatus.badge(root, 'model.demo.zz_bad') || '').startsWith('✗ error'));
      fs.writeFileSync(bad, 'select 1 as id\n');
      await vscode.commands.executeCommand('dbtCommander.retry');
      assert.deepEqual(results(), ['model.demo.zz_bad']);
      await waitFor('fixed badge', () => (api.runStatus.badge(root, 'model.demo.zz_bad') || '').startsWith('✓'));
    } finally {
      fs.unlinkSync(bad);
    }
    await run('run', 'models', 'b.sql');
    const rr = file('target', 'run_results.json');
    const firstInvocation = JSON.parse(fs.readFileSync(rr, 'utf8')).metadata.invocation_id;
    await vscode.commands.executeCommand('dbtCommander.rerunLast');
    const again = JSON.parse(fs.readFileSync(rr, 'utf8'));
    assert.notEqual(again.metadata.invocation_id, firstInvocation, 'rerun did not run dbt');
    assert.deepEqual(results(), ['model.demo.b']);
  });

  await step('last run status: store, CodeLens badge, sidebar badge, Last run view', async () => {
    await waitFor('b badge', () => (api.runStatus.badge(root, 'model.demo.b') || '').startsWith('✓'));
    assert.match(api.runStatus.badge(root, 'model.demo.b'), /^✓ (just now|\dm ago) · \d+\.\ds$/);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri('models', 'b.sql')));
    const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri('models', 'b.sql'));
    assert.match(lenses[0].command.title, /^✓ /);
    assert.equal(lenses.length, 6);
    const top = await api.sidebar.getChildren();
    const models = await api.sidebar.getChildren(await child(top, 'Models'));
    assert.match((await child(models, 'b')).description, /^✓ /);
    await waitFor('last run view', async () => (await api.lastRun.getChildren()).length > 0);
    const items = await api.lastRun.getChildren();
    assert.deepEqual(labels(items), ['b']);
    assert.match(items[0].description, /^success · \d+\.\ds$/);
    assert.ok(same(items[0].command.arguments[0].fsPath, file('models', 'b.sql')));
  });

  await step('column autocomplete after a ref() alias', async () => {
    const tmp = file('models', 'zz_cols.sql');
    const text = "select o. from {{ ref('b') }} o";
    fs.writeFileSync(tmp, text);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(tmp));
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, doc.positionAt(text.indexOf('o.') + 2), '.');
      const names = list.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label));
      assert.ok(names.includes('id'), names.slice(0, 20).join(','));
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(tmp, { force: true });
    }
  });

  await step('find references: who ref()s a model', async () => {
    const refsAt = async (rel, needle) => {
      const doc = await vscode.workspace.openTextDocument(uri(...rel));
      const off = needle ? doc.getText().indexOf(needle) + 1 : 0;
      const locs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, doc.positionAt(off));
      return locs.map(l => `${path.relative(root, l.uri.fsPath).split(path.sep).join('/')}:${l.range.start.line}`).sort();
    };
    const fromCall = await refsAt(['models', 'c.sql'], "'b'");
    assert.ok(fromCall.includes('models/c.sql:0') && fromCall.includes('snapshots/snap.sql:2'), fromCall.join(','));
    const fromFile = await refsAt(['models', 'b.sql']);
    assert.ok(fromFile.includes('models/c.sql:0') && fromFile.includes('snapshots/snap.sql:2'), fromFile.join(','));
  });

  await step('custom model-paths: menus, CodeLens and builds work in a non-default folder', async () => {
    const projectFile = file('dbt_project.yml');
    const original = fs.readFileSync(projectFile, 'utf8');
    fs.mkdirSync(file('transform', 'sub'), { recursive: true });
    fs.writeFileSync(file('transform', 'sub', 't.sql'), 'select 1 as id\n');
    fs.writeFileSync(projectFile, original + 'model-paths: ["models", "transform"]\n');
    try {
      await api.publishPathKeys();
      const keys = api.pathKeys().model;
      for (const p of [file('transform'), file('transform', 'sub'), file('transform', 'sub', 't.sql'), file('models', 'b.sql')]) {
        assert.ok(keys[vscode.Uri.file(p).fsPath], `${p} missing from dbtCommander.modelPaths`);
      }
      // Open it first: VS Code's codelens command can throw "Illegal argument" for unopened documents.
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file('transform', 'sub', 't.sql'))));
      const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', vscode.Uri.file(file('transform', 'sub', 't.sql')));
      assert.ok(lenses.length >= 5, 'no CodeLens in the custom model folder');
      await vscode.commands.executeCommand('dbtCommander.build', vscode.Uri.file(file('transform')), [vscode.Uri.file(file('transform'))]);
      assert.deepEqual(results(), ['model.demo.t']);
    } finally {
      fs.writeFileSync(projectFile, original);
      fs.rmSync(file('transform'), { recursive: true, force: true });
      await vscode.commands.executeCommand('dbtCommander.parse');
      await api.publishPathKeys();
    }
    assert.ok(!api.pathKeys().model[vscode.Uri.file(file('transform')).fsPath], 'transform still published after removal');
  });

  // ----- v0.8: debug, docs, staging, new model, rename, exposures -----

  await step('dbt debug: connection check summary', async () => {
    const r = await vscode.commands.executeCommand('dbtCommander.debug');
    assert.deepEqual(r, { ok: true, text: 'All checks passed!' });
  });

  await step('open in dbt docs: generates the static site and targets the model page', async () => {
    fs.rmSync(file('target', 'static_index.html'), { force: true });
    const url = await vscode.commands.executeCommand('dbtCommander.openInDocs', uri('models', 'b.sql'));
    assert.ok(url && url.endsWith('static_index.html#!/model/model.demo.b'), String(url));
    assert.ok(fs.existsSync(file('target', 'static_index.html')));
    assert.match(fs.readFileSync(file('target', 'dbt_commander_docs.html'), 'utf8'), /static_index\.html#!\/model\/model\.demo\.b/);
  });

  await step('create staging model from a source (columns from the warehouse, YAML entry)', async () => {
    // A source over the seeded table main.s, so the warehouse has columns to read.
    const srcYml = file('models', 'zz_src.yml');
    fs.writeFileSync(srcYml, 'version: 2\nsources:\n  - name: seeded\n    schema: main\n    tables:\n      - name: s\n');
    const created = [];
    try {
      await vscode.commands.executeCommand('dbtCommander.seed');
      await vscode.commands.executeCommand('dbtCommander.parse');
      const top = await api.sidebar.getChildren();
      const seeded = await child(await api.sidebar.getChildren(await child(top, 'Sources')), 'seeded');
      const table = await child(await api.sidebar.getChildren(seeded), 's');
      const f = await createStaging(table, 'models/staging/seeded/stg_seeded__s.sql');
      created.push(f, file('models', 'staging', 'seeded'));
      const sql = fs.readFileSync(f, 'utf8');
      assert.match(sql, /source\('seeded', 's'\)/);
      assert.match(sql, /select\r?\n        id,\r?\n        name\r?\n/); // VS Code writes CRLF on Windows
      await vscode.workspace.saveAll(false);
      const yml = fs.readFileSync(file('models', 'staging', 'seeded', 'stg_seeded__s.yml'), 'utf8');
      assert.match(yml, /- name: stg_seeded__s[\s\S]*- name: id[\s\S]*- name: name/);
      // A source the warehouse doesn't have: select * with a TODO.
      const raw = await child(await api.sidebar.getChildren(await child(top, 'Sources')), 'raw');
      const orders = await child(await api.sidebar.getChildren(raw), 'orders');
      const f2 = await createStaging(orders, 'models/staging/raw/stg_raw__orders.sql');
      created.push(f2, file('models', 'staging', 'raw'));
      assert.match(fs.readFileSync(f2, 'utf8'), /TODO: list the columns[\s\S]*select \* from source/);
    } finally {
      // Save, then close the new files so Windows lets the folders be deleted.
      await vscode.workspace.saveAll(false);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      for (const c of created) fs.rmSync(c, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      fs.rmSync(srcYml, { force: true });
      await vscode.commands.executeCommand('dbtCommander.parse');
    }
  });

  await step('new model from the template, with a YAML entry', async () => {
    const yml = file('models', 'staging', 'stg_a.yml');
    const before = fs.existsSync(yml) ? fs.readFileSync(yml, 'utf8') : undefined;
    const f = await newModelIn(uri('models', 'staging'), 'zz_new');
    try {
      assert.ok(same(f, file('models', 'staging', 'zz_new.sql')));
      assert.match(fs.readFileSync(f, 'utf8'), /ref\('replace_me'\)/);
      await vscode.workspace.saveAll(false);
      assert.match(fs.readFileSync(yml, 'utf8'), /- name: zz_new\r?\n\s+description: ""/);
    } finally {
      fs.rmSync(f, { force: true });
      if (before !== undefined) fs.writeFileSync(yml, before);
    }
  });

  await step('rename model: file, every ref() and the YAML entry; refuses taken names', async () => {
    assert.equal(await rename(uri('models', 'b.sql'), 'c'), false, 'renamed onto an existing model');
    assert.equal(await rename(uri('models', 'b.sql'), 'b_renamed'), true);
    await vscode.workspace.saveAll(false);
    let failure;
    try {
      assert.ok(fs.existsSync(file('models', 'b_renamed.sql')) && !fs.existsSync(file('models', 'b.sql')));
      assert.match(fs.readFileSync(file('models', 'c.sql'), 'utf8'), /ref\('b_renamed'\)/);
      assert.match(fs.readFileSync(file('snapshots', 'snap.sql'), 'utf8'), /ref\('b_renamed'\)/);
      // CI checks the fixtures out with CRLF line endings.
      assert.match(fs.readFileSync(file('models', 'schema.yml'), 'utf8'), /- name: b_renamed\r?\n/);
      await vscode.commands.executeCommand('dbtCommander.parse');
      const m = JSON.parse(fs.readFileSync(file('target', 'manifest.json'), 'utf8'));
      assert.deepEqual(m.parent_map['model.demo.c'], ['model.demo.b_renamed']);
    } catch (e) {
      failure = e; // report this, not a follow-on failure from the clean-up below
    }
    // Rename back without re-parsing first: the (stale) manifest still lists `b`, which must not block it.
    const back = await rename(uri('models', 'b_renamed.sql'), 'b');
    await vscode.workspace.saveAll(false);
    await vscode.commands.executeCommand('dbtCommander.parse');
    if (failure) throw failure;
    assert.equal(back, true, 'rename back');
    assert.match(fs.readFileSync(file('models', 'c.sql'), 'utf8'), /ref\('b'\)/);
  });

  await step('exposures: sidebar section and downstream lineage', async () => {
    const ex = file('models', 'zz_exposures.yml');
    fs.writeFileSync(ex, "version: 2\nexposures:\n  - name: dash\n    type: dashboard\n    owner:\n      name: me\n    depends_on:\n      - ref('c')\n");
    try {
      await vscode.commands.executeCommand('dbtCommander.parse');
      const top = await api.sidebar.getChildren();
      const exposures = await api.sidebar.getChildren(await child(top, 'Exposures'));
      assert.deepEqual(labels(exposures), ['dash']);
      assert.equal(exposures[0].command.arguments[1].selection.start.line, 2);
      await api.lineage.unpin();
      await api.lineage.follow(uri('models', 'c.sql'));
      const [focus] = await api.lineage.getChildren();
      const [, down] = await api.lineage.getChildren(focus);
      assert.deepEqual(labels(await api.lineage.getChildren(down)), ['dash']);
    } finally {
      fs.rmSync(ex, { force: true });
      await vscode.commands.executeCommand('dbtCommander.parse');
    }
  });

  await step('go to definition without a manifest falls back to the file name', async () => {
    fs.rmSync(file('target', 'manifest.json'), { force: true });
    const d = await definition(['models', 'c.sql'], "'b'");
    assert.ok(d && same(d.file, file('models', 'b.sql')), JSON.stringify(d));
  });

  await step('sidebar without a manifest offers dbt parse', async () => {
    const top = await api.sidebar.getChildren();
    assert.equal(top.length, 1);
    assert.equal(top[0].kind, 'noManifest');
    assert.equal(top[0].command.command, 'dbtCommander.parse');
  });

  await step('right-click seed: one CSV in a subfolder', async () => {
    await run('seedFiles', 'seeds', 'ref', 'countries.csv');
    assert.deepEqual(results(), ['seed.demo.countries']);
  });

  await step('right-click seed: several CSVs selected', async () => {
    await vscode.commands.executeCommand('dbtCommander.seedFiles', uri('seeds', 's.csv'), [uri('seeds', 's.csv'), uri('seeds', 'ref', 'countries.csv')]);
    assert.deepEqual(results(), ['seed.demo.countries', 'seed.demo.s']);
  });

  await step('seed menu shows for seed CSVs only', async () => {
    const pkg = require(path.resolve(__dirname, '..', '..', 'package.json'));
    const when = pkg.contributes.menus['explorer/context'].find(m => m.command === 'dbtCommander.seedFiles').when;
    const [ext, inSeeds, excluded] = [...when.matchAll(/=~ \/(.+?)\/i/g)].map(m => new RegExp(m[1], 'i'));
    const shows = p => ext.test(path.extname(p)) && inSeeds.test(p) && !excluded.test(p);
    assert.ok(shows(file('seeds', 's.csv')) && shows(file('seeds', 'ref', 'countries.csv')));
    assert.ok(!shows(file('models', 'data.csv')) && !shows(file('dbt_packages', 'x', 'seeds', 'a.csv')) && !shows(file('seeds', 'notes.txt')));
  });

  await step('right-click any folder: build everything inside (subfolders included)', async () => {
    await vscode.commands.executeCommand('dbtCommander.build', uri('seeds'), [uri('seeds')]);
    assert.deepEqual(results(), ['seed.demo.countries', 'seed.demo.s']);
  });

  await step('right-click any folder: seed a subfolder', async () => {
    await vscode.commands.executeCommand('dbtCommander.seedFiles', uri('seeds', 'ref'), [uri('seeds', 'ref')]);
    assert.deepEqual(results(), ['seed.demo.countries']);
  });

  await step('right-click the project folder: build / seed the whole project', async () => {
    await vscode.commands.executeCommand('dbtCommander.seedFiles', vscode.Uri.file(root), [vscode.Uri.file(root)]);
    assert.deepEqual(results(), ['seed.demo.countries', 'seed.demo.s']);
    await vscode.commands.executeCommand('dbtCommander.build', vscode.Uri.file(root), [vscode.Uri.file(root)]);
    const r = results();
    for (const id of ['model.demo.b', 'model.demo.c', 'model.demo.stg_a', 'seed.demo.s', 'seed.demo.countries']) {
      assert.ok(r.includes(id), `${id} missing from ${r.join(',')}`);
    }
    assert.ok(r.some(x => x.startsWith('test.demo.not_null_b_id')));
  });

  await step('folder menu shows for project folders, not for target / dbt_packages / .git', async () => {
    const pkg = require(path.resolve(__dirname, '..', '..', 'package.json'));
    const when = pkg.contributes.menus['explorer/context'].find(m => m.submenu === 'dbtCommander.submenu').when;
    const folderPart = when.slice(when.indexOf('explorerResourceIsFolder'));
    const [excluded] = [...folderPart.matchAll(/=~ \/(.+?)\/i/g)].map(m => new RegExp(m[1], 'i'));
    const shows = p => !excluded.test(p);
    for (const ok of [root, file('seeds'), file('seeds', 'ref'), file('models', 'staging'), file('snapshots')]) {
      assert.ok(shows(ok), ok);
    }
    for (const no of [file('target'), file('target', 'compiled'), file('dbt_packages', 'x'), file('.git'), file('logs')]) {
      assert.ok(!shows(no), no);
    }
  });

  await step('seed / deps / docs generate (static, not opened) / snapshot', async () => {
    await vscode.commands.executeCommand('dbtCommander.seed');
    assert.deepEqual(results(), ['seed.demo.countries', 'seed.demo.s']);
    await vscode.commands.executeCommand('dbtCommander.deps');
    fs.rmSync(file('target', 'static_index.html'), { force: true });
    await vscode.commands.executeCommand('dbtCommander.docsGenerate'); // openDocsAfterGenerate=false in workspace settings
    assert.ok(fs.existsSync(file('target', 'static_index.html')), 'static_index.html not generated');
    await vscode.commands.executeCommand('dbtCommander.snapshot');
  });

  // ----- v0.10: macro hover, scratchpad, selection / CTE preview, YAML quick fixes, run-state pruning -----
  // At the end of the suite: these add a temporary model, and dbt show re-parses the project.

  const closeAll = () => vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const actionsAt = async (u, line) =>
    (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', u, new vscode.Range(line, 0, line, 0))) || [];

  await step('hover on a macro: signature, description and arguments', async () => {
    const text = await hoverText(['analyses', 'uses_macro.sql'], 'cents_to_dollars');
    assert.match(text, /cents_to_dollars\(col\)/);
    assert.match(text, /Converts cents to dollars/);
    assert.match(text, /\x60col\x60 \(string\): The column in cents/);
    assert.match(text, /demo · macros\/money\.sql/);
  });

  await step('scratchpad: runs the query, or the selection, through dbt show --inline', async () => {
    const ed = await api.query.newScratchpad(root);
    try {
      assert.ok(ed.document.isUntitled);
      assert.match(path.basename(ed.document.uri.fsPath), /^dbt-scratch-\d+\.sql$/);
      const sql = "-- counts\nselect count(*) as \"row count\", 'it''s' as q\nfrom {{ ref('b') }}\n-- trailing comment\n";
      await ed.edit(e => e.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), sql));
      let r = await api.query.previewSelection(ed);
      assert.ok(r && r.rows, JSON.stringify(r));
      assert.deepEqual(Object.keys(r.rows[0]), ['row count', 'q']);
      assert.equal(r.rows[0].q, "it's");
      await ed.edit(e => e.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), 'select nope from\n\nselect 42 as answer;'));
      ed.selection = new vscode.Selection(2, 0, 2, 20);
      r = await api.query.previewSelection(ed);
      assert.deepEqual(r && r.rows, [{ answer: 42 }], JSON.stringify(r));
      ed.selection = new vscode.Selection(0, 0, 0, 0);
      r = await api.query.previewSelection(ed);
      assert.ok(r && r.error && !r.rows, JSON.stringify(r));
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  await step('model: preview the CTE under the cursor (with the CTEs before it), or the selection', async () => {
    const f = file('models', 'zz_ctes.sql');
    fs.writeFileSync(f, 'with one as (\n  select 1 as n\n),\ntwo as (\n  select n + 1 as n from one\n)\nselect n * 10 as n from two\n');
    try {
      const doc = await vscode.workspace.openTextDocument(f);
      const ed = await vscode.window.showTextDocument(doc);
      const at = needle => {
        const p = doc.positionAt(doc.getText().indexOf(needle));
        ed.selection = new vscode.Selection(p, p);
      };
      at('n + 1');
      assert.deepEqual((await api.query.previewSelection(ed)).rows, [{ n: 2 }]);
      at('select 1');
      assert.deepEqual((await api.query.previewSelection(ed)).rows, [{ n: 1 }]);
      const off = doc.getText().indexOf('select n + 1 as n from one');
      ed.selection = new vscode.Selection(doc.positionAt(off), doc.positionAt(off + 10)); // "select n +" is not valid alone
      const bad = await api.query.previewSelection(ed);
      assert.ok(bad && bad.error, JSON.stringify(bad));
      // Cursor outside any CTE with unsaved edits: previews the editor's text and leaves the file unsaved.
      const fin = doc.getText().indexOf('n * 10');
      await ed.edit(e => e.replace(new vscode.Range(doc.positionAt(fin), doc.positionAt(fin + 6)), 'n * 100'));
      at('n * 100');
      assert.deepEqual((await api.query.previewSelection(ed)).rows, [{ n: 200 }]);
      assert.ok(doc.isDirty, 'the model was saved');
      assert.ok(fs.readFileSync(f, 'utf8').includes('n * 10 as'), 'file on disk changed');
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await closeAll();
      fs.rmSync(f, { force: true });
    }
  });

  await step('quick fixes: Generate YAML on a model without YAML; add tests to a YAML column', async () => {
    const model = file('models', 'zz_noyaml.sql');
    fs.writeFileSync(model, 'select 1 as id\n');
    const f = file('models', 'schema.yml');
    const original = fs.readFileSync(f, 'utf8');
    try {
      await vscode.commands.executeCommand('dbtCommander.parse');
      const m = await vscode.workspace.openTextDocument(model);
      assert.ok((await actionsAt(m.uri, 0)).some(a => a.title === 'Generate YAML for this model'), 'no Generate YAML action on zz_noyaml');
      const b = await vscode.workspace.openTextDocument(uri('models', 'b.sql'));
      assert.ok(!(await actionsAt(b.uri, 0)).some(a => a.title === 'Generate YAML for this model'), 'Generate YAML offered for b, which has YAML');

      fs.writeFileSync(f, original.replace(/\s*$/, '\n') + '  - name: zz_noyaml\n    columns:\n      - name: id\n        description: the id\n');
      const doc = await vscode.workspace.openTextDocument(f);
      const lines = doc.getText().split(/\r?\n/);
      const flowLine = lines.findIndex(l => /data_tests: \[not_null\]/.test(l));
      assert.ok(!(await actionsAt(doc.uri, flowLine)).some(a => /^Add /.test(a.title)), 'offered to edit a flow-style list');
      const line = lines.lastIndexOf('      - name: id');
      const titles = (await actionsAt(doc.uri, line)).map(a => a.title);
      for (const t of ['Add unique + not_null tests to id', 'Add not_null test to id', 'Add unique test to id', 'Add accepted_values test to id…']) {
        assert.ok(titles.includes(t), t + ' missing from ' + titles.join(', '));
      }
      const both = (await actionsAt(doc.uri, line)).find(a => a.title === 'Add unique + not_null tests to id');
      assert.ok(await vscode.workspace.applyEdit(both.edit));
      assert.ok(await api.query.addColumnTests(doc.uri, line, [{ accepted_values: ['x', 'y'] }]));
      assert.match(doc.getText(), /      - name: id\r?\n        description: the id\r?\n        data_tests:\r?\n          - unique\r?\n          - not_null\r?\n          - accepted_values:\r?\n              arguments:\r?\n                values: \["x", "y"\]/);
      // The same accepted_values / unique / not_null aren't offered twice.
      assert.ok(!(await actionsAt(doc.uri, line)).some(a => /^Add (unique|not_null)/.test(a.title)));
      // dbt accepts the YAML: unique + not_null pass on zz_noyaml.id.
      await doc.save();
      await vscode.commands.executeCommand('dbtCommander.build', vscode.Uri.file(model), [vscode.Uri.file(model)]);
      const r = results();
      assert.ok(r.some(x => x.startsWith('test.demo.unique_zz_noyaml_id')) && r.some(x => x.startsWith('test.demo.not_null_zz_noyaml_id')), r.join(','));
    } finally {
      await closeAll();
      fs.writeFileSync(f, original);
      fs.rmSync(model, { force: true });
    }
  });

  await step('run state: results of nodes no longer in the project are pruned', async () => {
    const fake = file('target', 'zz_fake_results.json');
    const rr = JSON.parse(fs.readFileSync(file('target', 'run_results.json'), 'utf8'));
    rr.metadata.generated_at = new Date().toISOString();
    rr.args.which = 'build';
    rr.results = [{ unique_id: 'model.demo.zz_gone', status: 'success', execution_time: 1 }];
    fs.writeFileSync(fake, JSON.stringify(rr));
    try {
      await api.runStatus.ingest(fake, false);
      assert.ok(api.runStatus.result(root, 'model.demo.zz_gone'), 'fake result not ingested');
      await api.runStatus.prune(root);
      assert.equal(api.runStatus.result(root, 'model.demo.zz_gone'), undefined);
      assert.ok(api.runStatus.result(root, 'model.demo.b'), 'a live node was pruned');
    } finally {
      fs.rmSync(fake, { force: true });
    }
  });

  fs.writeFileSync(process.env.ITEST_OUT, out.join('\n'));
};
