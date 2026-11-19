import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  DbtAction,
  GraphScope,
  buildArgs,
  dbtExecutable,
  findProjectRoot,
  flagArgs,
  groupByProject,
  modelName,
  modelSelector,
  withGraph
} from './dbt';
import { SettingsPanel, detectDbtVersion } from './settingsPanel';
import { DbtDiagnostics, killTree, runDbtTask } from './runner';
import { listTargets, parseProjectFile, profilesDirCandidates } from './profiles';
import { compiledPath, parseShowOutput } from './show';
import { PreviewPanel } from './previewPanel';
import { registerLanguageFeatures } from './language';

let statusItem: vscode.StatusBarItem;
let targetItem: vscode.StatusBarItem;
let diagnostics: DbtDiagnostics;
let context: vscode.ExtensionContext;

const exists = (p: string) => fs.existsSync(p);
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const cfg = () => vscode.workspace.getConfiguration('dbtRunner');
const workspaceFolderOf = (p: string) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p));
const stopAt = (p: string) => workspaceFolderOf(p)?.uri.fsPath;

// ---------- project / profile helpers ----------

function readProject(root: string): ReturnType<typeof parseProjectFile> {
  try {
    return parseProjectFile(fs.readFileSync(path.join(root, 'dbt_project.yml'), 'utf8'));
  } catch {
    return {};
  }
}

function targetsFor(root: string): { targets: string[]; defaultTarget?: string } | undefined {
  const profile = readProject(root).profile;
  if (!profile) {
    return undefined;
  }
  for (const dir of profilesDirCandidates(root, cfg().get<string>('extraArgs', ''), process.env, os.homedir())) {
    const file = path.join(dir, 'profiles.yml');
    if (exists(file)) {
      try {
        return listTargets(fs.readFileSync(file, 'utf8'), profile);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** dbt project of the active editor, else the only project in the workspace, else ask. */
async function pickProjectRoot(ask: boolean): Promise<string | undefined> {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file') {
    const root = findProjectRoot(doc.uri.fsPath, exists, stopAt(doc.uri.fsPath));
    if (root) {
      return root;
    }
  }
  const found = await vscode.workspace.findFiles('**/dbt_project.yml', '**/{dbt_packages,target,node_modules,.venv,venv}/**', 50);
  const roots = found.map(u => path.dirname(u.fsPath)).sort();
  if (roots.length <= 1 || !ask) {
    return roots[0];
  }
  const pick = await vscode.window.showQuickPick(
    roots.map(r => ({ label: readProject(r).name ?? path.basename(r), description: r, root: r })),
    { placeHolder: 'Which dbt project?' }
  );
  return pick?.root;
}

const targetDirOf = (root: string) => path.join(root, readProject(root).targetPath ?? 'target');

async function requireExe(): Promise<string | undefined> {
  // dbt executes project code (macros, hooks) against the warehouse: only in trusted workspaces.
  if (!vscode.workspace.isTrusted) {
    const choice = await vscode.window.showErrorMessage(
      'dbt Runner: dbt only runs in trusted workspaces, because dbt executes the project’s macros and hooks.',
      'Manage Workspace Trust'
    );
    if (choice) {
      await vscode.commands.executeCommand('workbench.trust.manage');
    }
    return undefined;
  }
  const exe = dbtExecutable(cfg().get<string>('venvPath', ''), exists);
  if (!exe) {
    const choice = await vscode.window.showErrorMessage(
      'dbt Runner: dbt executable not found. Set the venv path in dbt Runner settings.',
      'Open Settings'
    );
    if (choice === 'Open Settings') {
      openSettings();
    }
  }
  return exe;
}

function settingsScope(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

// ---------- selection ----------

interface Selection {
  root: string;
  paths: string[];
}

async function resolveSelection(uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined, allowFolders: boolean): Promise<Selection | undefined> {
  const picked = uris && uris.length ? uris : uri instanceof vscode.Uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
  const paths = picked
    .filter(u => u.scheme === 'file')
    .map(u => u.fsPath)
    .filter(p => /\.sql$/i.test(p) || (allowFolders && isDir(p)));

  if (paths.length === 0) {
    void vscode.window.showErrorMessage(`dbt Runner: select one or more .sql models${allowFolders ? ' or model folders' : ''}.`);
    return undefined;
  }
  // A folder's project is found by walking up from inside it.
  const probe = (p: string) => (isDir(p) ? path.join(p, '_') : p);
  const { projects, orphans } = groupByProject(paths.map(probe), exists, stopAt);
  if (orphans.length) {
    void vscode.window.showErrorMessage(`dbt Runner: no dbt_project.yml found above ${orphans.map(o => path.basename(path.dirname(o)) + '/' + path.basename(o)).join(', ')}.`);
    return undefined;
  }
  if (projects.size > 1) {
    void vscode.window.showErrorMessage('dbt Runner: selection spans several dbt projects. Run them separately.');
    return undefined;
  }
  const root = [...projects.keys()][0];
  // Save unsaved edits to the selected models so dbt sees them.
  for (const d of vscode.workspace.textDocuments) {
    if (d.isDirty && paths.some(p => d.uri.fsPath === p || d.uri.fsPath.startsWith(p + path.sep))) {
      await d.save();
    }
  }
  return { root, paths };
}

const displayName = (p: string) => (isDir(p) ? path.basename(p) + '/' : modelName(p));

// ---------- commands ----------

async function runDbt(action: DbtAction, graph: GraphScope, uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const sel = await resolveSelection(uri, uris, graph === 'none');
  const exe = sel && (await requireExe());
  if (!sel || !exe) {
    return;
  }
  const selectors = sel.paths.map(p => withGraph(modelSelector(sel.root, p), graph));
  const args = buildArgs(action, selectors, cfg().get<string>('target', ''), cfg().get<string>('extraArgs', ''));
  await runDbtTask({
    exe,
    args,
    cwd: sel.root,
    title: `${action} ${sel.paths.map(p => withGraph(displayName(p), graph)).join(' ')}`,
    diagnostics,
    targetDir: targetDirOf(sel.root),
    folder: workspaceFolderOf(sel.root)
  });
}

async function compileModel(uri?: vscode.Uri): Promise<void> {
  const sel = await resolveSelection(uri, undefined, false);
  const exe = sel && (await requireExe());
  if (!sel || !exe) {
    return;
  }
  const file = sel.paths[0];
  const code = await runDbtTask({
    exe,
    args: buildArgs('compile', [modelSelector(sel.root, file)], cfg().get<string>('target', ''), cfg().get<string>('extraArgs', '')),
    cwd: sel.root,
    title: `compile ${modelName(file)}`,
    diagnostics,
    targetDir: targetDirOf(sel.root),
    folder: workspaceFolderOf(sel.root)
  });
  if (code !== 0) {
    return;
  }
  const project = readProject(sel.root);
  const compiled = compiledPath(sel.root, project.name ?? path.basename(sel.root), project.targetPath, file);
  if (!exists(compiled)) {
    void vscode.window.showWarningMessage(`dbt Runner: compiled file not found at ${compiled}`);
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(compiled), { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
}

async function previewModel(uri?: vscode.Uri): Promise<void> {
  const sel = await resolveSelection(uri, undefined, false);
  const exe = sel && (await requireExe());
  if (!sel || !exe) {
    return;
  }
  const file = sel.paths[0];
  const name = modelName(file);
  const limit = Math.max(1, cfg().get<number>('previewLimit', 100));
  const args = [
    ...buildArgs('show', [modelSelector(sel.root, file)], cfg().get<string>('target', ''), cfg().get<string>('extraArgs', '')),
    '--limit', String(limit), '--output', 'json', '--log-format', 'json'
  ];

  const run = async () => {
    const seq = ++previewSeq;
    const panel = PreviewPanel.loading(name, () => void run());
    const started = Date.now();
    const output = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `dbt show ${name}`, cancellable: true },
      (_progress, token) =>
        new Promise<string>(resolve => {
          const child = execFile(
            exe,
            args,
            { cwd: sel.root, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
            (err, stdout, stderr) => resolve(`${stdout}\n${stderr}${err && !stdout && !stderr ? err.message : ''}`)
          );
          token.onCancellationRequested(() => killTree(child));
        })
    );
    if (seq === previewSeq) {
      panel.showResult(name, parseShowOutput(output), Date.now() - started, limit); // drop stale results
    }
  };
  await run();
}
let previewSeq = 0;

/** Runs a project-level dbt command; resolves with the project root and exit code (undefined if it didn't run). */
async function projectCommand(args: string[], label: string): Promise<{ root: string; code: number | undefined } | undefined> {
  const root = await pickProjectRoot(true);
  if (!root) {
    void vscode.window.showErrorMessage('dbt Runner: no dbt project (dbt_project.yml) found in this workspace.');
    return undefined;
  }
  const exe = await requireExe();
  if (!exe) {
    return undefined;
  }
  const flags = args[0] === 'deps' ? [] : flagArgs(cfg().get<string>('target', ''), cfg().get<string>('extraArgs', ''));
  const code = await runDbtTask({ exe, args: [...args, ...flags], cwd: root, title: label, diagnostics, targetDir: targetDirOf(root), folder: workspaceFolderOf(root) });
  return { root, code };
}

/** `dbt docs generate --static` writes a self-contained static_index.html; open it in the browser. */
async function docsGenerate(): Promise<void> {
  const result = await projectCommand(['docs', 'generate', '--static'], 'docs generate');
  if (!result || result.code !== 0) {
    return;
  }
  const page = path.join(targetDirOf(result.root), 'static_index.html');
  if (!exists(page)) {
    void vscode.window.showWarningMessage(`dbt Runner: static docs page not found at ${page}`);
    return;
  }
  if (cfg().get<boolean>('openDocsAfterGenerate', true)) {
    await vscode.env.openExternal(vscode.Uri.file(page));
  } else {
    void vscode.window.showInformationMessage(`dbt Runner: docs written to ${page}`);
  }
}

async function selectTarget(): Promise<void> {
  const root = await pickProjectRoot(true);
  const info = root ? targetsFor(root) : undefined;
  const current = cfg().get<string>('target', '');
  let chosen: string | undefined;
  if (info && info.targets.length) {
    const items = [
      { label: `(profile default${info.defaultTarget ? `: ${info.defaultTarget}` : ''})`, value: '' },
      ...info.targets.map(t => ({ label: t, value: t }))
    ].map(i => ({ ...i, description: i.value === current ? 'current' : undefined }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'dbt target' });
    chosen = pick?.value;
  } else {
    chosen = await vscode.window.showInputBox({
      prompt: 'dbt target (no profiles.yml targets found). Leave empty for the profile default.',
      value: current
    });
  }
  if (chosen !== undefined) {
    await cfg().update('target', chosen || undefined, settingsScope());
  }
}

async function showMenu(): Promise<void> {
  void refreshStatus(); // dbt may have been installed into the venv since the last check
  const items: (vscode.QuickPickItem & { command: string })[] = [
    { label: '$(package) dbt deps', command: 'dbtRunner.deps' },
    { label: '$(table) dbt seed', command: 'dbtRunner.seed' },
    { label: '$(history) dbt snapshot', command: 'dbtRunner.snapshot' },
    { label: '$(book) dbt docs generate', description: 'build static docs and open in browser', command: 'dbtRunner.docsGenerate' },
    { label: '$(target) Switch target…', command: 'dbtRunner.selectTarget' },
    { label: '$(gear) Settings', command: 'dbtRunner.openSettings' }
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: statusItem.tooltip?.toString().split('\n')[0] });
  if (pick) {
    await vscode.commands.executeCommand(pick.command);
  }
}

function openSettings(): void {
  // Resolve the project now: once the settings webview opens there is no active text editor.
  const rootPromise = pickProjectRoot(false);
  let targets: string[] = [];
  void rootPromise.then(root => (targets = (root && targetsFor(root)?.targets) || []));
  void rootPromise.then(() =>
    SettingsPanel.show(
      context,
      () => {
        void refreshStatus();
        void refreshTarget();
      },
      () => targets
    )
  );
}

// ---------- status bar ----------

let statusSeq = 0;
async function refreshStatus(): Promise<void> {
  const seq = ++statusSeq;
  const venv = cfg().get<string>('venvPath', '');
  if (!venv.trim()) {
    statusItem.text = '$(gear) dbt: not configured';
    statusItem.tooltip = 'dbt Runner: set the dbt venv';
    statusItem.backgroundColor = undefined;
    return;
  }
  const info = await detectDbtVersion(venv);
  if (seq !== statusSeq) {
    return; // a newer refresh superseded this one
  }
  if (info.error) {
    statusItem.text = '$(error) dbt: not found';
    statusItem.tooltip = info.error;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (info.major !== 1) {
    statusItem.text = `$(warning) dbt ${info.version}`;
    statusItem.tooltip = `dbt ${info.version} detected; dbt Runner supports dbt-core 1.x only.`;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusItem.text = `$(database) dbt ${info.version}`;
    statusItem.tooltip = `dbt-core ${info.version}\n${info.exe}`;
    statusItem.backgroundColor = undefined;
  }
}

async function refreshTarget(): Promise<void> {
  const root = await pickProjectRoot(false);
  if (!root) {
    targetItem.hide();
    return;
  }
  const configured = cfg().get<string>('target', '');
  const rawDefault = targetsFor(root)?.defaultTarget;
  const def = rawDefault && !rawDefault.includes('{{') ? rawDefault : undefined; // Jinja default: can't resolve
  targetItem.text = `$(target) ${configured || def || 'default'}`;
  targetItem.tooltip = configured ? `dbt target: ${configured} — click to switch` : `dbt target: profile default${def ? ` (${def})` : ''} — click to switch`;
  targetItem.show();
}

// ---------- activation ----------

export function activate(ctx: vscode.ExtensionContext): void {
  context = ctx;
  diagnostics = new DbtDiagnostics(vscode.languages.createDiagnosticCollection('dbt'));

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'dbtRunner.menu';
  statusItem.show();
  targetItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  targetItem.command = 'dbtRunner.selectTarget';

  const runCommands: [string, DbtAction, GraphScope][] = [
    ['run', 'run', 'none'],
    ['build', 'build', 'none'],
    ['test', 'test', 'none'],
    ['buildUpstream', 'build', 'upstream'],
    ['buildDownstream', 'build', 'downstream'],
    ['buildUpDownstream', 'build', 'both']
  ];
  for (const [id, action, graph] of runCommands) {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(`dbtRunner.${id}`, (uri?: vscode.Uri, uris?: vscode.Uri[]) => runDbt(action, graph, uri, uris))
    );
  }

  ctx.subscriptions.push(
    statusItem,
    targetItem,
    diagnostics,
    vscode.commands.registerCommand('dbtRunner.compile', (uri?: vscode.Uri) => compileModel(uri)),
    vscode.commands.registerCommand('dbtRunner.preview', (uri?: vscode.Uri) => previewModel(uri)),
    vscode.commands.registerCommand('dbtRunner.deps', () => projectCommand(['deps'], 'deps')),
    vscode.commands.registerCommand('dbtRunner.seed', () => projectCommand(['seed'], 'seed')),
    vscode.commands.registerCommand('dbtRunner.snapshot', () => projectCommand(['snapshot'], 'snapshot')),
    vscode.commands.registerCommand('dbtRunner.docsGenerate', docsGenerate),
    vscode.commands.registerCommand('dbtRunner.selectTarget', selectTarget),
    vscode.commands.registerCommand('dbtRunner.menu', showMenu),
    vscode.commands.registerCommand('dbtRunner.openSettings', openSettings),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('dbtRunner.venvPath')) {
        void refreshStatus();
      }
      if (e.affectsConfiguration('dbtRunner.target') || e.affectsConfiguration('dbtRunner.extraArgs')) {
        void refreshTarget();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => void refreshTarget()),
    vscode.window.onDidChangeWindowState(s => {
      if (s.focused) {
        void refreshStatus();
      }
    })
  );

  registerLanguageFeatures(ctx, {
    projectRootOf: file => findProjectRoot(file, exists, stopAt(file)),
    targetDirOf,
    projectNameOf: root => readProject(root).name
  });

  void refreshStatus();
  void refreshTarget();
}

export function deactivate(): void {}
