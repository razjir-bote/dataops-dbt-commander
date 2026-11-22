// Runs inside the VS Code extension host (see run.js) against a fresh copy of test/fixtures/demo.
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { groupOf } = require('./groups');

exports.run = async () => {
  const root = process.env.DBT_PROJ;
  const out = [];
  // Parallel runs (run.js): ITEST_GROUP selects one group of sections (groups.js); unset = every step, in order.
  const only = process.env.ITEST_GROUP;
  let group = '1';
  let setUp = false;
  const step = async (name, fn) => {
    if (only && group !== only) {
      return;
    }
    const started = Date.now();
    const secs = () => `(${((Date.now() - started) / 1000).toFixed(1)}s)`;
    try {
      await fn();
      out.push(`PASS ${name} ${secs()}`);
    } catch (e) {
      out.push(`FAIL ${name} ${secs()}: ` + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    }
  };
  // What the steps before a group would have left behind: seeds loaded, everything built, a catalog.
  const setup = async () => {
    const all = vscode.Uri.file(root);
    await vscode.commands.executeCommand('dbtCommander.seed');
    await vscode.commands.executeCommand('dbtCommander.build', all, [all]);
    await vscode.commands.executeCommand('dbtCommander.docsGenerate'); // openDocsAfterGenerate=false
  };
  /** Start a section of the suite (see groups.js); in a parallel run, the first section of a later group sets up. */
  const section = async name => {
    group = groupOf(name);
    if (only && group === only && !setUp && group !== '1') {
      setUp = true;
      await step(`setup for group ${group}: seed, build, docs generate`, setup);
    }
  };
  const uri = (...p) => vscode.Uri.file(path.join(root, ...p));
  const file = (...p) => path.join(root, ...p);
  const results = () => JSON.parse(fs.readFileSync(file('target', 'run_results.json'), 'utf8')).results.map(r => r.unique_id).sort();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = (cmd, ...p) => vscode.commands.executeCommand(`dbtCommander.${cmd}`, uri(...p), [uri(...p)]);
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  // Windows: a file VS Code just saved can stay locked for a moment (EBUSY / EPERM); retry briefly.
  const writeRetry = async (p, text) => {
    for (let i = 0; ; i++) {
      try {
        fs.writeFileSync(p, text);
        return;
      } catch (e) {
        if (i >= 20 || !['EBUSY', 'EPERM'].includes(e && e.code)) throw e;
        await sleep(250);
      }
    }
  };

  const api = await vscode.extensions.getExtension('local.dataops-dbt-commander').activate();
  // v0.8 commands with their inputs given directly (no input boxes / refactor preview in tests).
  const createStaging = (item, rel) => api.projectEdits.createStaging(item, rel);
  const newModelIn = (folderUri, name) => api.projectEdits.newModel(folderUri, name);
  const rename = (u, name) => api.projectEdits.rename(u, name, false);
  const cfg = () => vscode.workspace.getConfiguration('dbtCommander');

  await section('core');

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
      // Real children only: Windows reuses ids, so a boot-time process (csrss, winlogon...) can name a reused
      // id as its parent. A child must have been created after its parent.
      const grow = ids => {
        for (let grew = true; grew; ) {
          grew = false;
          for (const p of all) {
            const parent = byPid.get(p.ppid);
            if (ids.has(p.ppid) && !ids.has(p.pid) && parent && p.created >= parent.created) { ids.add(p.pid); grew = true; }
          }
        }
        return ids;
      };
      // Only this VS Code's dbt: other test groups may be running dbt from the same venv at the same time.
      const ours = grow(new Set([process.pid]));
      const ids = grow(new Set(all.filter(p => ours.has(p.pid) && p.name === 'dbt.exe' && p.exe.startsWith(venv)).map(p => p.pid)));
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
  await section('language');

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
  await section('v04');

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
  await section('v06');

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
  await section('v05');

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
  await section('v07');

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
  await section('v08');

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
      // The bronze template: `id` is the key (any case) — kept, and copied to entity_id; deduped on it. (VS Code may write CRLF.)
      assert.match(sql, /CAST\(\[id\] AS NVARCHAR\(4000\)\)\)\), ''\) AS \[entity_id\],\r?\n\r?\n {8}NULLIF\(LTRIM\(RTRIM\(CAST\(\[id\] AS NVARCHAR\(4000\)\)\)\), ''\) AS \[id\],/);
      assert.match(sql, /AS \[name\]\r?\n\r?\n {4}FROM source/);
      assert.match(sql, /PARTITION BY\r?\n {16}\[entity_id\]\r?\n/);
      await vscode.workspace.saveAll(false);
      const yml = fs.readFileSync(file('models', 'staging', 'seeded', 'stg_seeded__s.yml'), 'utf8');
      assert.match(yml, /- name: stg_seeded__s[\s\S]*- name: entity_id[\s\S]*- name: id[\s\S]*- name: name/);
      // A source the warehouse doesn't have: select * with a TODO.
      const raw = await child(await api.sidebar.getChildren(await child(top, 'Sources')), 'raw');
      const orders = await child(await api.sidebar.getChildren(raw), 'orders');
      const f2 = await createStaging(orders, 'models/staging/raw/stg_raw__orders.sql');
      created.push(f2, file('models', 'staging', 'raw'));
      assert.match(fs.readFileSync(f2, 'utf8'), /TODO: list the columns[\s\S]*SELECT \*\r?\nFROM source/);
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
    // The folder's YAML file (made by a Generate YAML step in a serial run): the new model's entry goes there.
    if (before === undefined) fs.writeFileSync(yml, 'version: 2\nmodels:\n  - name: stg_a\n');
    const f = await newModelIn(uri('models', 'staging'), 'zz_new');
    try {
      assert.ok(same(f, file('models', 'staging', 'zz_new.sql')));
      assert.match(fs.readFileSync(f, 'utf8'), /ref\('replace_me'\)/);
      await vscode.workspace.saveAll(false);
      assert.match(fs.readFileSync(yml, 'utf8'), /- name: zz_new\r?\n\s+description: ""/);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(f, { force: true, maxRetries: 5, retryDelay: 200 });
      if (before !== undefined) await writeRetry(yml, before);
      else fs.rmSync(yml, { force: true, maxRetries: 5, retryDelay: 200 });
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
    // The dbt submenu opens on seed CSVs through its CSV clause (and offers Seed there).
    const menu = pkg.contributes.menus['explorer/context'].find(m => m.submenu === 'dbtCommander.submenu').when;
    const when = menu.split(') || (').find(part => part.includes('csv'));
    assert.ok(pkg.contributes.menus['dbtCommander.submenu'].some(m => m.command === 'dbtCommander.seedFiles' && /csv/.test(m.when)));
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
  await section('v10');
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

  // ----- v0.11: preview data for export, column profile, relationships / dbt_utils quick fixes -----
  await section('v11');

  await step('preview keeps the rows for Copy / Save CSV', async () => {
    await vscode.commands.executeCommand('dbtCommander.preview', uri('models', 'b.sql'));
    const data = api.query.previewData();
    assert.ok(data && data.columns.includes('id') && data.rows.length > 0, JSON.stringify(data));
  });

  await step('column profile: a model column (YAML lightbulb) and a source column', async () => {
    const yml = await vscode.workspace.openTextDocument(uri('models', 'schema.yml'));
    const line = yml.getText().split(/\r?\n/).findIndex(l => /^      - name: id\s*$/.test(l));
    assert.ok((await actionsAt(yml.uri, line)).some(a => a.title === 'Profile column id'), 'no Profile action');
    let r = await api.query.profileYamlColumn(yml.uri, line);
    assert.ok(r && r.rows, JSON.stringify(r));
    const stat = name => r.rows.find(x => x.statistic === name);
    assert.ok(stat('rows') && Number(stat('rows').value) > 0, JSON.stringify(r.rows));
    assert.match(String(stat('nulls').value), /^0 \(0%\)$/);
    assert.ok(stat('top value 1') && stat('top value 1').count > 0);

    const src = file('models', 'zz_src2.yml');
    fs.writeFileSync(src, 'version: 2\nsources:\n  - name: seeded2\n    schema: main\n    tables:\n      - name: s\n        columns:\n          - name: name\n');
    try {
      const doc = await vscode.workspace.openTextDocument(src);
      const titles = (await actionsAt(doc.uri, 7)).map(a => a.title);
      assert.deepEqual(titles.filter(t => /^(Add|Profile)/.test(t)), ['Profile column name'], 'sources get profile only');
      r = await api.query.profileYamlColumn(doc.uri, 7);
      assert.ok(r && r.rows && r.rows.find(x => x.statistic === 'distinct'), JSON.stringify(r));
    } finally {
      await closeAll();
      fs.rmSync(src, { force: true });
    }
  });

  await step('quick fixes: relationships test (dbt accepts it); no dbt_utils tests without the package', async () => {
    const model = file('models', 'zz_rel.sql');
    fs.writeFileSync(model, "select id as b_id from {{ ref('b') }}\n");
    const f = file('models', 'schema.yml');
    const original = fs.readFileSync(f, 'utf8');
    try {
      fs.writeFileSync(f, original.replace(/\s*$/, '\n') + '  - name: zz_rel\n    columns:\n      - name: b_id\n');
      const doc = await vscode.workspace.openTextDocument(f);
      // schema.yml may already be open (profile step): wait for VS Code to pick up the change on disk.
      await waitFor('schema.yml reload', () => doc.getText().includes('zz_rel'));
      const line = doc.getText().split(/\r?\n/).lastIndexOf('      - name: b_id');
      const titles = (await actionsAt(doc.uri, line)).map(a => a.title);
      assert.ok(titles.includes('Add relationships test to b_id…'), titles.join(', '));
      assert.ok(!titles.some(t => t.includes('dbt_utils')), 'dbt_utils offered without the package');
      assert.ok(await api.query.addColumnTests(doc.uri, line, [{ test: 'relationships', args: { to: "ref('b')", field: 'id' } }]));
      assert.match(doc.getText(), /- relationships:\r?\n\s+arguments:\r?\n\s+to: ref\('b'\)\r?\n\s+field: id/);
      await doc.save();
      await vscode.commands.executeCommand('dbtCommander.build', vscode.Uri.file(model), [vscode.Uri.file(model)]);
      const r = results();
      assert.ok(r.some(x => x.startsWith('test.demo.relationships_zz_rel_b_id')), r.join(','));
      const rr = JSON.parse(fs.readFileSync(file('target', 'run_results.json'), 'utf8'));
      assert.ok(rr.results.every(x => x.status === 'success' || x.status === 'pass'), JSON.stringify(rr.results.map(x => [x.unique_id, x.status])));
    } finally {
      await closeAll();
      fs.writeFileSync(f, original);
      fs.rmSync(model, { force: true });
    }
  });

  // ----- review fixes -----
  await section('review');

  await step('paths with spaces: a model and its folder build (dbt splits selectors on spaces)', async () => {
    const dir = file('models', 'my folder');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'zz_space.sql'), 'select 1 as id\n');
    try {
      await run('build', 'models', 'my folder', 'zz_space.sql');
      assert.deepEqual(results(), ['model.demo.zz_space']);
      await run('build', 'models', 'my folder');
      assert.deepEqual(results(), ['model.demo.zz_space']);
    } finally {
      await closeAll();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  await step('Show lineage on an exposure or a source (sidebar) and on a Lineage panel item', async () => {
    const ex = file('models', 'zz_exposures2.yml');
    fs.writeFileSync(ex, "version: 2\nexposures:\n  - name: dash2\n    type: dashboard\n    owner:\n      name: me\n    depends_on:\n      - ref('c')\n");
    try {
      await vscode.commands.executeCommand('dbtCommander.parse');
      const top = await api.sidebar.getChildren();
      const [dash] = await api.sidebar.getChildren(await child(top, 'Exposures'));
      await vscode.commands.executeCommand('dbtCommander.showLineage', dash);
      assert.deepEqual([api.lineage.current.id, api.lineage.current.pinned], ['exposure.demo.dash2', true]);
      const [focus] = await api.lineage.getChildren();
      const [up, down] = await api.lineage.getChildren(focus);
      assert.deepEqual(labels(await api.lineage.getChildren(up)), ['c']);
      assert.equal(down.description, 'none');

      // Re-centre on an item listed in the panel (c, upstream of the exposure).
      const [c] = await api.lineage.getChildren(up);
      await vscode.commands.executeCommand('dbtCommander.showLineage', c);
      assert.equal(api.lineage.current.id, 'model.demo.c');

      const raw = await child(await api.sidebar.getChildren(await child(top, 'Sources')), 'raw');
      const orders = await child(await api.sidebar.getChildren(raw), 'orders');
      await vscode.commands.executeCommand('dbtCommander.showLineage', orders);
      assert.equal(api.lineage.current.id, 'source.demo.raw.orders');
    } finally {
      await api.lineage.unpin();
      fs.rmSync(ex, { force: true });
      await vscode.commands.executeCommand('dbtCommander.parse');
    }
  });

  // ----- v0.12: optional SQLFluff -----
  await section('v12');

  const sqlfluffProblems = u => vscode.languages.getDiagnostics(u).filter(d => d.source === 'sqlfluff');

  await step('SQLFluff is off by default: nothing runs, nothing registered', async () => {
    assert.equal(cfg().get('sqlfluff.enabled'), 'off');
    assert.equal(api.sqlfluff.active, false);
    const doc = await vscode.workspace.openTextDocument(uri('models', 'c.sql'));
    await vscode.window.showTextDocument(doc);
    await sleep(1500);
    assert.deepEqual(sqlfluffProblems(doc.uri), []);
    const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 4, insertSpaces: true });
    assert.ok(!edits || edits.length === 0, 'a formatter ran while SQLFluff is off');
    await closeAll();
  });

  await step('SQLFluff on: problems (dialect from the dbt adapter), Format Document, fix on save, then off clears all', async () => {
    const f = file('models', 'zz_lint.sql');
    const messy = "SELECT a,b from {{ ref('b') }}\n";
    fs.writeFileSync(f, messy);
    try {
      await cfg().update('sqlfluff.enabled', 'on', vscode.ConfigurationTarget.Workspace);
      await waitFor('sqlfluff active', () => api.sqlfluff.active);
      const doc = await vscode.workspace.openTextDocument(f);
      await vscode.window.showTextDocument(doc);
      const problems = await waitFor('sqlfluff problems', () => (sqlfluffProblems(doc.uri).length ? sqlfluffProblems(doc.uri) : undefined), 60000);
      assert.ok(problems.some(p => /^LT\d\d/.test(String(p.code))), problems.map(p => p.code).join(', '));

      const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 4, insertSpaces: true });
      // VS Code turns the provider's whole-file replacement into minimal edits: check the result, not the count.
      assert.ok(edits && edits.length > 0, 'Format Document gave no edit: ' + JSON.stringify(edits));
      const formatted = await vscode.workspace.openTextDocument({ language: 'sql', content: doc.getText() });
      const p2 = new vscode.WorkspaceEdit();
      p2.set(formatted.uri, edits);
      assert.ok(await vscode.workspace.applyEdit(p2));
      assert.match(formatted.getText(), /SELECT\r?\n\s+a,\r?\n\s+b\r?\n/i, formatted.getText());

      await cfg().update('sqlfluff.fixOnSave', true, vscode.ConfigurationTarget.Workspace);
      const ed = await vscode.window.showTextDocument(doc);
      await ed.edit(e => e.insert(new vscode.Position(0, 0), '-- touched\n'));
      await doc.save();
      // Within VS Code's will-save budget the fix is part of this save; on a slow machine it misses the budget and
      // is applied right after, then saved again: wait for either.
      const saved = await waitFor(
        'fix on save (in the save, or applied and saved right after it)',
        () => {
          const s = fs.readFileSync(f, 'utf8');
          return s.replace(/\r\n/g, '\n') !== '-- touched\n' + messy && !doc.isDirty ? s : undefined;
        },
        30000
      );
      assert.match(saved, /SELECT\r?\n\s+a,\r?\n\s+b\r?\n/i, saved);
      assert.ok(!/\r\n/.test(saved) || /\r\n/.test(doc.getText()), 'line endings changed');

      await cfg().update('sqlfluff.enabled', 'off', vscode.ConfigurationTarget.Workspace);
      await waitFor('sqlfluff off', () => !api.sqlfluff.active);
      await waitFor('problems cleared', () => sqlfluffProblems(doc.uri).length === 0);
    } finally {
      await cfg().update('sqlfluff.enabled', undefined, vscode.ConfigurationTarget.Workspace);
      await cfg().update('sqlfluff.fixOnSave', undefined, vscode.ConfigurationTarget.Workspace);
      await closeAll();
      fs.rmSync(f, { force: true });
    }
  });

  // ----- v0.13: YAML autocomplete -----
  await section('v13');

  await step('YAML autocomplete: model names, columns (catalog), tests, keys, config values, ref()', async () => {
    const f = file('models', 'zz_complete.yml');
    const text = [
      'version: 2',
      'models:',
      '  - name: b',
      '    columns:',
      '      - name: ',
      '        data_tests:',
      '          - ',
      '    config:',
      '      materialized: ',
      '  - name: ',
      '    ',
      'unit_tests:',
      '  - name: t',
      "    model: ",
      ''
    ].join('\n');
    fs.writeFileSync(f, text);
    try {
      const doc = await vscode.workspace.openTextDocument(f);
      const labelsAt = async (line, col) => {
        const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, col));
        return list.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label));
      };
      const line = n => doc.lineAt(n).text.length;
      // catalog.json exists: docs generate ran earlier in the suite.
      assert.ok((await labelsAt(4, line(4))).includes('id'), 'column id of b from the catalog');
      const tests = await labelsAt(6, line(6));
      for (const t of ['not_null', 'unique', 'accepted_values', 'relationships']) assert.ok(tests.includes(t), t + ' missing: ' + tests.join(','));
      const mats = await labelsAt(8, line(8));
      for (const m of ['view', 'table', 'incremental', 'ephemeral']) assert.ok(mats.includes(m), m);
      const models = await labelsAt(9, line(9));
      // b is already listed in this file, so only the others are offered.
      assert.ok(!models.includes('b') && models.includes('c'), models.join(','));
      const keys = await labelsAt(10, line(10));
      assert.ok(keys.includes('description') && keys.includes('columns') && !keys.includes('name'), keys.join(','));
      assert.ok((await labelsAt(13, line(13))).includes('b'), 'unit test model');
      // Not in YAML that isn't a property file: dbt_project.yml's models: is a different structure.
      const project = await vscode.workspace.openTextDocument(file('dbt_project.yml'));
      const plist = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', project.uri, new vscode.Position(0, 0));
      assert.ok(!plist.items.some(i => (typeof i.label === 'string' ? i.label : i.label.label) === 'semantic_models'), 'dbt keys offered in dbt_project.yml');
    } finally {
      await closeAll();
      fs.rmSync(f, { force: true });
    }
  });

  // ----- v0.14: SCD2 change-key model -----
  await section('v14');

  await step('SCD2 change-key model from a staging model: template, hash_columns macro, compiles with dbt', async () => {
    const rel = 'models/intermediate/changekey/int_a__changekey.sql';
    const varsFile = file('vars.yaml');
    fs.writeFileSync(varsFile, 'other_var: 1  # kept\nscd2_dimensions:\n  - name: dim_existing\n    source: int_existing__changekey\n');
    const macro = file('macros', 'hash_columns.sql');
    // Stand-ins for the project's own SCD2 macros, so the generated models compile.
    const scd2Macros = file('macros', 'zz_scd2.sql');
    fs.writeFileSync(
      scd2Macros,
      ['candidate', 'history', 'published'].map(s => `{% macro scd2_${s}(dim) %}select '{{ dim }}' as dim, '${s}' as stage{% endmacro %}`).join('\n') +
        "\n{% macro scd2_gate_test(dim) %}select '{{ dim }}' as failing where 1 = 0{% endmacro %}\n"
    );
    try {
      // stg_a (select 1 as id) has neither versionnumber nor _full_row_hash: the hash_columns macro is used.
      const created = await api.projectEdits.createChangeKey(uri('models', 'staging', 'stg_a.sql'), rel);
      assert.ok(created && same(created, file(...rel.split('/'))), String(created));
      const sql = fs.readFileSync(created, 'utf8');
      assert.match(sql, /identifier='dim_a__history'/);
      assert.match(sql, /FROM \{\{ ref\('stg_a'\) \}\}/);
      assert.match(sql, /\{\{ hash_columns\(\['id'\]\) \}\} AS \[attribute_hash\]/);
      assert.ok(fs.existsSync(macro), 'hash_columns macro not written');
      // dbt renders the template and the macro (compile doesn't run the T-SQL).
      await vscode.commands.executeCommand('dbtCommander.compile', vscode.Uri.file(created));
      const compiled = fs.readFileSync(file('target', 'compiled', 'demo', ...rel.split('/')), 'utf8');
      assert.match(compiled, /HASHBYTES\('SHA2_256', CAST\(\[id\] AS NVARCHAR\(4000\)\)\)/);
      assert.match(compiled, /SELECT CAST\(NULL AS DATETIME2\) AS valid_from/, 'no history table yet: the empty branch');
      // The rest of the SCD2 chain, in the generated folder, calling the project's macros.
      for (const stage of ['candidate', 'history', 'published']) {
        const g = file('models', 'intermediate', 'scd2', 'generated', `dim_a__${stage}.sql`);
        assert.equal(fs.readFileSync(g, 'utf8').replace(/\r\n/g, '\n'), `{{ scd2_${stage}('dim_a') }}\n`);
      }
      await vscode.commands.executeCommand('dbtCommander.compile', uri('models', 'intermediate', 'scd2', 'generated', 'dim_a__published.sql'));
      const pub = fs.readFileSync(file('target', 'compiled', 'demo', 'models', 'intermediate', 'scd2', 'generated', 'dim_a__published.sql'), 'utf8');
      assert.match(pub, /select 'dim_a' as dim, 'published' as stage/);
      // The gates test: a singular test under tests/, which dbt runs.
      const gates = file('tests', 'scd2', 'generated', 'dim_a__gates.sql');
      assert.equal(fs.readFileSync(gates, 'utf8').replace(/\r\n/g, '\n'), "{{ scd2_gate_test('dim_a') }}\n");
      const dbtExe = path.join(cfg().get('venvPath'), process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'dbt.exe' : 'dbt');
      const ran = execFileSync(dbtExe, ['test', '--select', 'dim_a__gates'], { cwd: root, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }).toString();
      assert.match(ran, /PASS=1/, ran.slice(-600));
      // The dimension's entry, appended to scd2_dimensions in vars.yaml (the rest of the file untouched).
      const vars = fs.readFileSync(varsFile, 'utf8').replace(/\r\n/g, '\n');
      assert.ok(vars.startsWith('other_var: 1  # kept\nscd2_dimensions:\n  - name: dim_existing\n    source: int_existing__changekey\n  - name: dim_a\n    source: int_a__changekey\n'), vars);
      assert.match(vars, /    natural_key: \[entity_id\]\n    change_date_column: _landing_extract_date\n/);
      assert.match(vars, /    baseline_source: int_a__changekey\n/);
      // Again: the existing generated models are kept (not overwritten).
      fs.writeFileSync(file('models', 'intermediate', 'scd2', 'generated', 'dim_a__history.sql'), '-- edited\n');
      await api.projectEdits.createChangeKey(uri('models', 'staging', 'stg_a.sql'), 'models/intermediate/changekey/int_a__changekey_2.sql');
      assert.equal(fs.readFileSync(varsFile, 'utf8').replace(/\r\n/g, '\n'), vars, 'dim_a already in scd2_dimensions: not added twice');
      assert.equal(fs.readFileSync(file('models', 'intermediate', 'scd2', 'generated', 'dim_a__history.sql'), 'utf8'), '-- edited\n');
      // Not for a model that isn't a staging model.
      assert.equal(await api.projectEdits.createChangeKey(uri('models', 'b.sql'), 'models/intermediate/changekey/x.sql'), undefined);
    } finally {
      await closeAll();
      fs.rmSync(file('models', 'intermediate'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      fs.rmSync(macro, { force: true });
      fs.rmSync(scd2Macros, { force: true });
      fs.rmSync(varsFile, { force: true });
      fs.rmSync(file('tests', 'scd2'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  // ----- v0.15: seed as source -----
  await section('v15');

  await step('add seeds as a source: YAML entry at the seeds\' schema, queryable with source() after dbt seed', async () => {
    const rel = 'models/staging/bronze/_bronze__sources.yml';
    const yml = file(...rel.split('/'));
    try {
      const written = await api.projectEdits.addSeedsAsSource([uri('seeds', 's.csv'), uri('seeds', 'ref', 'countries.csv')], 'bronze', rel);
      assert.ok(written && same(written, yml), String(written));
      const doc = require('yaml').parse(fs.readFileSync(yml, 'utf8'));
      assert.equal(doc.sources[0].name, 'bronze');
      assert.equal(doc.sources[0].schema, 'main');
      assert.deepEqual(doc.sources[0].tables.map(t => [t.name, t.columns.map(c => c.name)]), [['s', ['id', 'name']], ['countries', ['code', 'name']]]);
      // Again: nothing changes.
      const before = fs.readFileSync(yml, 'utf8');
      await api.projectEdits.addSeedsAsSource([uri('seeds', 's.csv')], 'bronze', rel);
      assert.equal(fs.readFileSync(yml, 'utf8'), before);
      // The source reads the seed's table.
      await vscode.commands.executeCommand('dbtCommander.seed');
      const ed = await api.query.newScratchpad(root);
      await ed.edit(e => e.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), "select count(*) as n from {{ source('bronze', 's') }}"));
      const r = await api.query.previewSelection(ed);
      assert.ok(r && r.rows && Number(Object.values(r.rows[0])[0]) > 0, JSON.stringify(r));
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    } finally {
      await closeAll();
      fs.rmSync(file('models', 'staging', 'bronze'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  await step('create staging model from a sources YAML entry (lightbulb on the table)', async () => {
    const yml = file('models', 'zz_yaml_src.yml');
    fs.writeFileSync(yml, 'version: 2\nsources:\n  - name: yamlsrc\n    schema: main\n    tables:\n      - name: s\n        columns:\n          - name: id\n');
    const created = [];
    try {
      await vscode.commands.executeCommand('dbtCommander.parse');
      const doc = await vscode.workspace.openTextDocument(yml);
      const actions = await actionsAt(doc.uri, 5); // '      - name: s'
      const create = actions.find(a => a.title === 'Create staging model for yamlsrc.s');
      assert.ok(create, actions.map(a => a.title).join(', '));
      const f = await createStaging(create.command.arguments[0], 'models/staging/yamlsrc/stg_yamlsrc__s.sql');
      created.push(f, file('models', 'staging', 'yamlsrc'));
      const sql = fs.readFileSync(f, 'utf8');
      assert.match(sql, /source\('yamlsrc', 's'\)/);
      assert.match(sql, /AS \[entity_id\]/, 'bronze template, id is the key');
      // From a column line of the same table: the same table (the editor right-click path).
      const ed = await vscode.window.showTextDocument(doc);
      ed.selection = new vscode.Selection(7, 12, 7, 12);
      const again = await createStaging(undefined, 'models/staging/yamlsrc/stg_yamlsrc__s_2.sql');
      created.push(again);
      assert.match(fs.readFileSync(again, 'utf8'), /source\('yamlsrc', 's'\)/);
    } finally {
      await vscode.workspace.saveAll(false);
      await closeAll();
      for (const c of [...created, yml]) fs.rmSync(c, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await vscode.commands.executeCommand('dbtCommander.parse');
    }
  });

  // ----- v0.16: auto-parse -----
  await section('v16');

  await step('auto-parse: new / edited / broken files reach the sidebar without a command; waits for dbt run; off = nothing', async () => {
    const ap = api.autoParse;
    const model = file('models', 'zz_auto.sql');
    const yml = file('models', 'zz_auto.yml');
    const modelNames = async () => {
      const top = await api.sidebar.getChildren();
      return labels(await api.sidebar.getChildren(await child(top, 'Models')));
    };
    const manifestNode = name => {
      let m;
      try {
        m = JSON.parse(fs.readFileSync(file('target', 'manifest.json'), 'utf8'));
      } catch {
        return undefined; // dbt is writing it right now: waitFor tries again
      }
      return Object.values(m.nodes).find(n => n.resource_type === 'model' && n.name === name);
    };
    try {
      await cfg().update('autoParse', true, vscode.ConfigurationTarget.Workspace);
      // A new model: in the sidebar, no dbt command run by the test.
      fs.writeFileSync(model, 'select 1 as id\n');
      await waitFor('zz_auto in the sidebar', async () => (await modelNames()).includes('zz_auto'), 60000);
      // Its YAML: the description reaches the manifest.
      fs.writeFileSync(yml, 'version: 2\nmodels:\n  - name: zz_auto\n    description: written by auto-parse\n');
      await waitFor('description in the manifest', () => manifestNode('zz_auto')?.description === 'written by auto-parse', 60000);

      // Broken: the failure shows, the sidebar keeps the last parse; fixing it clears the failure.
      fs.writeFileSync(model, "select * from {{ ref('b' }}\n");
      await waitFor('parse failure', () => ap.failure(root), 60000);
      assert.match(ap.failure(root), /error/i, ap.failure(root));
      assert.ok((await modelNames()).includes('b'), 'the sidebar still lists the other models');
      fs.writeFileSync(model, "select * from {{ ref('b') }}\n");
      await waitFor('failure cleared', () => !ap.failure(root), 60000);

      // During a dbt run: a change waits for the run, then parses once.
      const before = ap.parses;
      const running = vscode.commands.executeCommand('dbtCommander.run', uri('models', 'b.sql'));
      await waitFor('dbt run started', () => vscode.tasks.taskExecutions.some(t => t.task.definition.type === 'dbtCommander'), 30000);
      fs.writeFileSync(model, "select * from {{ ref('b') }} -- touched\n");
      await running;
      await waitFor('parse after the run', () => ap.parses > before, 60000);
      assert.equal(ap.parses, before + 1, 'one parse');

      // Off: nothing runs.
      await cfg().update('autoParse', false, vscode.ConfigurationTarget.Workspace);
      const off = ap.parses;
      fs.writeFileSync(model, 'select 2 as id\n');
      await sleep(4000);
      assert.equal(ap.parses, off, 'auto-parse off: no parse');
    } finally {
      await cfg().update('autoParse', undefined, vscode.ConfigurationTarget.Workspace);
      fs.rmSync(model, { force: true });
      fs.rmSync(yml, { force: true });
      await vscode.commands.executeCommand('dbtCommander.parse');
    }
  });

  await step('preview selection ending in a comma: selects from the last CTE selected', async () => {
    const ed = await api.query.newScratchpad(root);
    try {
      const sql = [
        'with first_cte as (',
        "  select 1 as n from {{ ref('b') }}",
        '),',
        'second_cte as (',
        '  select n + 1 as n from first_cte',
        '),',
        'third_cte as (select n + 1 as n from second_cte)',
        'select * from third_cte',
        ''
      ].join('\n');
      await ed.edit(e => e.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), sql));
      // From the top through the comma after second_cte.
      ed.selection = new vscode.Selection(0, 0, 5, 2);
      const r = await api.query.previewSelection(ed);
      assert.deepEqual(r && r.rows, [{ n: 2 }], JSON.stringify(r));
      // Just first_cte, with its comma.
      ed.selection = new vscode.Selection(0, 0, 2, 2);
      assert.deepEqual((await api.query.previewSelection(ed)).rows, [{ n: 1 }]);
      // Only third_cte (the last, no comma): the CTEs it reads from come from the model.
      ed.selection = new vscode.Selection(6, 0, 6, 48);
      const third = await api.query.previewSelection(ed);
      assert.deepEqual(third && third.rows, [{ n: 3 }], JSON.stringify(third));
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  await step('copy compiled SQL: a model, a selected CTE, a scratchpad; a compile error leaves the clipboard alone', async () => {
    const clip = () => vscode.env.clipboard.readText();
    await closeAll();
    // A model picked in the Explorer / sidebar (not open): dbt compile --select, its compiled file.
    const model = await api.query.copyCompiled(uri('models', 'c.sql'));
    assert.ok(model, 'nothing copied');
    assert.equal(await clip(), model);
    assert.match(model, /from "demo"\."main"\."b"/i, model);
    assert.doesNotMatch(model, /\{\{/);
    // Not a model (a macro file, even open in the editor): nothing compiled, nothing copied.
    await vscode.window.showTextDocument(uri('macros', 'money.sql'));
    assert.equal(await api.query.copyCompiled(uri('macros', 'money.sql')), undefined);
    assert.equal(await clip(), model);
    await closeAll();
    const ed = await api.query.newScratchpad(root);
    try {
      await ed.edit(e => e.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), "with a as (select * from {{ ref('b') }}),\nz as (select 1 as q)\nselect * from z\n"));
      // The first CTE with its comma: compiled, selecting from it.
      ed.selection = new vscode.Selection(0, 0, 0, 41);
      const cte = await api.query.copyCompiled();
      assert.ok(cte && cte === (await clip()), String(cte));
      assert.match(cte, /^with a as \(select \* from "demo"\."main"\."b"\),\s*z as \(select 1 as q\)\s*select \* from a\s*$/i, cte);
      // No selection in a scratchpad: the whole query.
      ed.selection = new vscode.Selection(2, 0, 2, 0);
      assert.match(await api.query.copyCompiled(), /select \* from z\s*$/);
      // A compile error: nothing copied, the clipboard keeps what it had.
      await vscode.env.clipboard.writeText('keep me');
      await ed.edit(e => e.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), "select * from {{ ref('nope') }}\n"));
      assert.equal(await api.query.copyCompiled(), undefined);
      assert.equal(await clip(), 'keep me');
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await closeAll();
    }
  });

  fs.writeFileSync(process.env.ITEST_OUT, out.join('\n'));
};
