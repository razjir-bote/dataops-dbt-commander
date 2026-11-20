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
  folderSelectors,
  graphSelectors,
  isUnderPackages,
  modelSelector,
  withGraph
} from './dbt';
import { SettingsPanel, detectDbtVersion } from './settingsPanel';
import { DbtDiagnostics, killTree, lastRunOptions, runDbtTask } from './runner';
import { listTargets, parseProjectFile, profilesDirCandidates } from './profiles';
import { ShowResult, compiledPath } from './show';
import { TestSpec } from './yamlfix';
import { LanguageDeps, clearManifestCache, inProjectPaths, loadManifest, registerLanguageFeatures } from './language';
import { Column, appendModel, hasModel, mergeColumns, newModelYaml, parseColumnsOutput, yamlUsable } from './yamlgen';
import { cleanLine } from './errors';
import { DbtItem, DbtSidebar } from './sidebar';
import { pickSelection } from './tree';
import { ProjectPaths, projectPaths, resourcePaths } from './projectconfig';
import { DbtTests } from './testing';
import { DbtLineage } from './lineage';
import { RunStatusStore } from './runstatus';
import { DbtLastRun } from './lastrun';
import { MIGRATED_KEYS, Scope, plannedMigrations } from './migrate';
import { EditDeps, checkConnection, createStagingModel, newModel, openInDocs, renameModel } from './projectedits';
import { DbtCodeActions, QueryDeps, addColumnTests, newScratchpad, previewSelection, profileColumn, profileYamlColumn, runShow, trackScratchpads } from './query';
import { loadCatalog } from './hover';
import { PreviewPanel } from './previewPanel';

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
const cfg = () => vscode.workspace.getConfiguration('dbtCommander');
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
    const root = findProjectRoot(doc.uri.fsPath, exists, stopAt(doc.uri.fsPath), isPackageRoot);
    if (root) {
      return root;
    }
  }
  const roots = await projectRoots();
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

/** `<venv>/Lib/site-packages/dbt/include` (Windows) or `<venv>/lib/python3.*\/site-packages/dbt/include`. */
function dbtIncludeDir(): string | undefined {
  const venv = cfg().get<string>('venvPath', '').trim();
  if (!venv) {
    return undefined;
  }
  const win = path.join(venv, 'Lib', 'site-packages', 'dbt', 'include');
  if (exists(win)) {
    return win;
  }
  try {
    for (const py of fs.readdirSync(path.join(venv, 'lib')).filter(d => d.startsWith('python'))) {
      const p = path.join(venv, 'lib', py, 'site-packages', 'dbt', 'include');
      if (exists(p)) {
        return p;
      }
    }
  } catch {
    // no lib/ folder
  }
  return undefined;
}

/** Configured folders from dbt_project.yml (defaults when absent), cached by file mtime. */
const pathsCache = new Map<string, { mtime: number; paths: ProjectPaths }>();
function pathsOf(root: string): ProjectPaths {
  const file = path.join(root, 'dbt_project.yml');
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    // no dbt_project.yml: defaults
  }
  const hit = pathsCache.get(root);
  if (hit && hit.mtime === mtime) {
    return hit.paths;
  }
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // defaults
  }
  const paths = projectPaths(text);
  pathsCache.set(root, { mtime, paths });
  return paths;
}

// ---------- configured folders → menu context keys ----------

/** Last published sets (fsPath → true), also returned to the integration suite. */
let pathKeys: { model: Record<string, true>; seed: Record<string, true>; snapshot: Record<string, true> } = { model: {}, seed: {}, snapshot: {} };

/**
 * Publish each project's model / seed / snapshot folders and files (from dbt_project.yml, so custom names like
 * `model-paths: [transform]` work) for menu conditions: `resourcePath in dbtCommander.modelPaths`.
 */
async function publishPathKeys(): Promise<void> {
  const keys: typeof pathKeys = { model: {}, seed: {}, snapshot: {} };
  const list = (dir: string) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, dir: e.isDirectory() }));
    } catch {
      return undefined;
    }
  };
  for (const root of await projectRoots()) {
    const paths = pathsOf(root);
    // Use each folder's real on-disk spelling (dbt_project.yml may say `Transform` for `transform`): the
    // context keys must match VS Code's `resourcePath` exactly.
    const onDisk = (d: string) => {
      try {
        return path.relative(root, fs.realpathSync.native(path.join(root, ...d.split('/')))).split(path.sep).join('/');
      } catch {
        return d;
      }
    };
    const add = (set: Record<string, true>, dirs: string[], ext: RegExp) => {
      for (const p of resourcePaths(root, dirs.map(onDisk), ext, list)) {
        set[vscode.Uri.file(p).fsPath] = true; // same form as the `resourcePath` context key
      }
    };
    add(keys.model, paths.model, /\.sql$/i);
    add(keys.seed, paths.seed, /\.csv$/i);
    add(keys.snapshot, paths.snapshot, /\.sql$/i);
  }
  pathKeys = keys;
  await Promise.all([
    vscode.commands.executeCommand('setContext', 'dbtCommander.modelPaths', keys.model),
    vscode.commands.executeCommand('setContext', 'dbtCommander.seedPaths', keys.seed),
    vscode.commands.executeCommand('setContext', 'dbtCommander.snapshotPaths', keys.snapshot)
  ]);
}

const languageDeps: LanguageDeps = {
  projectRootOf: file => findProjectRoot(file, exists, stopAt(file), isPackageRoot),
  projectRoots,
  targetDirOf,
  projectNameOf: root => readProject(root).name,
  dbtIncludeDir,
  pathsOf
};

async function requireExe(): Promise<string | undefined> {
  // dbt executes project code (macros, hooks) against the warehouse: only in trusted workspaces.
  if (!vscode.workspace.isTrusted) {
    const choice = await vscode.window.showErrorMessage(
      'dbt Commander: dbt only runs in trusted workspaces, because dbt executes the project’s macros and hooks.',
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
      'dbt Commander: dbt executable not found. Set the venv path in dbt Commander settings.',
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

function asUri(x: unknown): vscode.Uri | undefined {
  if (x instanceof vscode.Uri) {
    return x;
  }
  const r = (x as { resourceUri?: unknown } | undefined)?.resourceUri;
  return r instanceof vscode.Uri ? r : undefined;
}

async function resolveSelection(
  uri: vscode.Uri | undefined,
  uris: vscode.Uri[] | undefined,
  allowFolders: boolean,
  /** model: .sql files · seed: .csv files · buildable: either (dbt build / test also cover seeds). */
  kind: 'model' | 'seed' | 'buildable' = 'model'
): Promise<Selection | undefined> {
  // Commands are also invoked from the sidebar, with tree items (which carry a resourceUri) instead of Uris.
  const fromUris = (uris ?? []).map(asUri).filter((u): u is vscode.Uri => !!u);
  const single = asUri(uri);
  const picked = fromUris.length ? fromUris : single ? [single] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
  const ext = kind === 'seed' ? /\.csv$/i : kind === 'buildable' ? /\.(sql|csv)$/i : /\.sql$/i;
  const paths = [
    ...new Set(
      picked
        .filter(u => u.scheme === 'file')
        .map(u => u.fsPath)
        .filter(p => ext.test(p) || (allowFolders && isDir(p)))
    )
  ];

  if (paths.length === 0) {
    void vscode.window.showErrorMessage(
      kind === 'seed'
        ? 'dbt Commander: select one or more seed .csv files or folders.'
        : kind === 'buildable'
          ? 'dbt Commander: select one or more models, seeds or folders.'
          : `dbt Commander: select one or more .sql models${allowFolders ? ' or model folders' : ''}.`
    );
    return undefined;
  }
  // A folder's project is found by walking up from inside it.
  const probe = (p: string) => (isDir(p) ? path.join(p, '_') : p);
  const { projects, orphans } = groupByProject(paths.map(probe), exists, stopAt, isPackageRoot);
  if (orphans.length) {
    const shown = orphans.map(o => (path.basename(o) === '_' && isDir(path.dirname(o)) ? path.basename(path.dirname(o)) + '/' : path.basename(o)));
    void vscode.window.showErrorMessage(
      `dbt Commander: ${shown.join(', ')} is not inside a dbt project (no dbt_project.yml in it or above it). Right-click a folder inside your dbt project.`
    );
    return undefined;
  }
  if (projects.size > 1) {
    void vscode.window.showErrorMessage('dbt Commander: selection spans several dbt projects. Run them separately.');
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
  // Folders select everything inside them (subfolders included); build / test also take seeds.
  const sel = await resolveSelection(uri, uris, true, action !== 'run' ? 'buildable' : 'model');
  if (!sel) {
    return;
  }
  // The project folder itself = everything (no selector); with upstream/downstream that has no meaning.
  const selectors = graph === 'none' ? folderSelectors(sel.root, sel.paths) : graphSelectors(sel.root, sel.paths, graph);
  if (!selectors) {
    void vscode.window.showErrorMessage('dbt Commander: upstream / downstream needs models, seeds or folders inside the project, not the whole project.');
    return;
  }
  const exe = await requireExe();
  if (!exe) {
    return;
  }
  const args = buildArgs(action, selectors, cfg().get<string>('target', ''), cfg().get<string>('extraArgs', ''));
  await runDbtTask({
    exe,
    args,
    cwd: sel.root,
    title: selectors.length ? `${action} ${sel.paths.map(p => withGraph(displayName(p), graph)).join(' ')}` : `${action} (whole project)`,
    diagnostics,
    targetDir: targetDirOf(sel.root),
    folder: workspaceFolderOf(sel.root)
  });
}

// ---------- generate YAML ----------

/** Ask the warehouse (through dbt) for a built model's columns. */
function fetchColumns(exe: string, root: string, model: string): Promise<{ columns: Column[]; error?: string }> {
  return fetchRelationColumns(exe, root, `ref('${model.replace(/'/g, "\\'")}')`, model);
}

/** Columns of any relation dbt can name (`ref('x')`, `source('raw', 'orders')`), read from the warehouse. */
async function fetchRelationColumns(exe: string, root: string, relation: string, label: string): Promise<{ columns: Column[]; error?: string }> {
  const jinja = `{%- for c in adapter.get_columns_in_relation(${relation}) -%}` + 'DBTCOL|{{ c.name }}|{{ c.data_type }}\n{% endfor -%}';
  const args = ['compile', '--inline', jinja, '--quiet', ...flagArgs(cfg().get<string>('target', ''), cfg().get<string>('extraArgs', ''))];
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `dbt: reading columns of ${label}`, cancellable: true },
    (_p, token) =>
      new Promise(resolve => {
        const child = execFile(
          exe,
          args,
          { cwd: root, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
          (err, stdout, stderr) => {
            const columns = parseColumnsOutput(stdout);
            const text = cleanOutput(`${stdout}\n${stderr}`);
            resolve(columns.length || !err ? { columns } : { columns, error: text || err.message });
          }
        );
        token.onCancellationRequested(() => killTree(child));
      })
  );
}

const cleanOutput = (s: string) =>
  s
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(l => l.trim())
    .join('\n')
    .trim();

/** Where a model's YAML entry goes: its existing entry, a sibling yml with `models:`, or a new `<model>.yml`. */
async function yamlTargetFor(root: string, modelFile: string, model: string): Promise<{ file: string; mode: 'merge' | 'append' | 'create' }> {
  const textOf = async (f: string) => (await vscode.workspace.openTextDocument(vscode.Uri.file(f))).getText();
  const patch = (await loadManifest(languageDeps, root))?.patches.get(model);
  if (patch && exists(patch) && hasModel(await textOf(patch), model)) {
    return { file: patch, mode: 'merge' };
  }
  const dir = path.dirname(modelFile);
  const ymls = fs.readdirSync(dir).filter(f => /\.ya?ml$/i.test(f)).sort().map(f => path.join(dir, f));
  for (const f of ymls) {
    if (hasModel(await textOf(f), model)) {
      return { file: f, mode: 'merge' };
    }
  }
  for (const f of ymls) {
    const text = await textOf(f);
    // Skip files we can't edit safely (several documents, duplicate keys, syntax errors).
    if (/^models:/m.test(text) && yamlUsable(text)) {
      return { file: f, mode: 'append' };
    }
  }
  const own = path.join(dir, `${model}.yml`);
  if (exists(own)) {
    // e.g. a <model>.yml that only has `version: 2` or sources: add a models list to it.
    if (!yamlUsable(await textOf(own))) {
      throw new Error(`${path.basename(own)} has YAML errors or several documents; fix it first`);
    }
    return { file: own, mode: 'append' };
  }
  return { file: own, mode: 'create' };
}

async function generateYaml(uri?: vscode.Uri, retried = false): Promise<void> {
  const sel = await resolveSelection(uri, undefined, false);
  const exe = sel && (await requireExe());
  if (!sel || !exe) {
    return;
  }
  const modelFile = sel.paths[0];
  const entry = (await loadManifest(languageDeps, sel.root))?.models.find(m => m.file.toLowerCase() === modelFile.toLowerCase());
  if (entry?.version !== undefined) {
    void vscode.window.showInformationMessage(
      `dbt Commander: ${path.basename(modelFile)} is version ${entry.version} of the versioned model ${entry.name}; Generate YAML doesn't support versioned models yet.`
    );
    return;
  }
  if (entry?.materialized === 'ephemeral') {
    void vscode.window.showInformationMessage(`dbt Commander: ${entry.name} is ephemeral, so it has no table or view to read columns from.`);
    return;
  }
  const model = entry?.name ?? modelName(modelFile);
  const { columns, error } = await fetchColumns(exe, sel.root, model);
  if (!columns.length) {
    const why = error ? `dbt could not read the columns of ${model}:\n${error.slice(0, 600)}` : `No columns found for ${model} — it may not be built yet.`;
    if (retried) {
      void vscode.window.showWarningMessage(`dbt Commander: ${why}`);
      return;
    }
    const choice = await vscode.window.showWarningMessage(`dbt Commander: ${why}`, 'Build & retry');
    if (choice) {
      const code = await runDbtTask({
        exe,
        args: buildArgs('build', [modelSelector(sel.root, modelFile)], cfg().get<string>('target', ''), cfg().get<string>('extraArgs', '')),
        cwd: sel.root,
        title: `build ${model}`,
        diagnostics,
        targetDir: targetDirOf(sel.root),
        folder: workspaceFolderOf(sel.root)
      });
      if (code === 0) {
        await generateYaml(vscode.Uri.file(modelFile), true);
      }
    }
    return;
  }

  try {
    await writeModelYaml(sel.root, modelFile, model, columns);
  } catch (err) {
    void vscode.window.showErrorMessage(`dbt Commander: could not write YAML for ${model}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writeModelYaml(root: string, modelFile: string, model: string, columns: Column[]): Promise<void> {
  const target = await yamlTargetFor(root, modelFile, model);
  const fileUri = vscode.Uri.file(target.file);
  const edit = new vscode.WorkspaceEdit();
  let message: string;
  if (target.mode === 'create') {
    edit.createFile(fileUri, { ignoreIfExists: true });
    edit.insert(fileUri, new vscode.Position(0, 0), newModelYaml(model, columns));
    message = `created ${path.basename(target.file)} with ${columns.length} column${columns.length === 1 ? '' : 's'}`;
  } else {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const before = doc.getText();
    let after: string;
    if (target.mode === 'merge') {
      const merged = mergeColumns(before, model, columns)!;
      after = merged.text;
      message = merged.added.length
        ? `added ${merged.added.length} column${merged.added.length === 1 ? '' : 's'} (${merged.added.join(', ')}) to ${path.basename(target.file)}`
        : `${model} in ${path.basename(target.file)} already lists all ${columns.length} columns`;
    } else {
      after = appendModel(before, model, columns);
      message = `added ${model} with ${columns.length} column${columns.length === 1 ? '' : 's'} to ${path.basename(target.file)}`;
    }
    if (after !== before) {
      edit.replace(fileUri, new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)), after);
    }
  }
  if (edit.size && !(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showErrorMessage(`dbt Commander: could not edit ${target.file}`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(fileUri);
  const line = Math.max(0, doc.getText().split(/\r?\n/).findIndex(l => new RegExp(`^\\s*-\\s*name:\\s*['"]?${model}['"]?\\s*$`).test(l)));
  const ed = await vscode.window.showTextDocument(doc, { preview: false });
  ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
  ed.selection = new vscode.Selection(line, 0, line, 0);
  void vscode.window.showInformationMessage(`dbt Commander: ${message}.${edit.size ? ' Review and save the file.' : ''}`);
}

/** `dbt seed --select path:seeds/<file>.csv ...` for the selected seed CSVs. */
async function seedFiles(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const sel = await resolveSelection(uri, uris, true, 'seed');
  const exe = sel && (await requireExe());
  if (!sel || !exe) {
    return;
  }
  const selectors = folderSelectors(sel.root, sel.paths);
  await runDbtTask({
    exe,
    args: buildArgs('seed', selectors, cfg().get<string>('target', ''), cfg().get<string>('extraArgs', '')),
    cwd: sel.root,
    title: selectors.length ? `seed ${sel.paths.map(p => (isDir(p) ? path.basename(p) + '/' : path.basename(p, path.extname(p)))).join(' ')}` : 'seed (whole project)',
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
    void vscode.window.showWarningMessage(`dbt Commander: compiled file not found at ${compiled}`);
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
  const root = sel.root;
  await runShow(exe, root, modelName(file), ['--select', modelSelector(root, file)], queryDeps, {
    // Resolved when Σ is pressed: the manifest is fresh by then, and versioned models profile the version shown.
    onProfile: async column => {
      const model = (await loadManifest(languageDeps, root))?.models.find(m => m.file.toLowerCase() === file.toLowerCase());
      const owner = { kind: 'model' as const, name: model?.name ?? modelName(file), ...(model?.version !== undefined ? { version: model.version } : {}) };
      await profileColumn(queryDeps, root, owner, column);
    }
  });
}

let dbtVersion: string | undefined;

const queryDeps: QueryDeps = {
  requireExe,
  pickProjectRoot: () => pickProjectRoot(true),
  projectRootOf: file => languageDeps.projectRootOf(file),
  isModelFile: file => inProjectPaths(languageDeps, file, ['model']),
  showArgs: select => [...buildArgs('show', [], cfg().get<string>('target', ''), cfg().get<string>('extraArgs', '')), ...select],
  previewLimit: () => Math.max(1, cfg().get<number>('previewLimit', 100)),
  previewModel: uri => previewModel(uri),
  dbtVersion: () => dbtVersion,
  isProjectYaml: file => {
    const root = languageDeps.projectRootOf(file);
    if (!root) {
      return false;
    }
    const rel = path.relative(root, file).split(path.sep).join('/').toLowerCase();
    const p = pathsOf(root);
    return ![p.target, p.packagesInstall].some(d => rel === d.toLowerCase() || rel.startsWith(d.toLowerCase() + '/'));
  },
  lacksYaml: async file => {
    const root = languageDeps.projectRootOf(file);
    const index = root ? await loadManifest(languageDeps, root) : undefined;
    const model = index?.models.find(m => m.file.toLowerCase() === file.toLowerCase());
    return !!model && !index!.patches.has(model.name);
  },
  hasPackage: async (root, pkg) => !!(await loadManifest(languageDeps, root))?.macros.some(m => m.package === pkg),
  relations: async root => {
    const index = await loadManifest(languageDeps, root);
    if (!index) {
      return [];
    }
    const lit = (x: string) => `'${x.replace(/'/g, "\\'")}'`;
    const project = readProject(root).name ?? path.basename(root);
    return [
      ...index.models
        .filter(m => m.package === project && m.version === undefined)
        .map(m => ({ label: m.name, description: 'model', to: `ref(${lit(m.name)})`, uniqueId: m.uniqueId })),
      ...index.seeds.filter(m => m.package === project).map(m => ({ label: m.name, description: 'seed', to: `ref(${lit(m.name)})`, uniqueId: m.uniqueId })),
      ...index.snapshots.filter(m => m.package === project).map(m => ({ label: m.name, description: 'snapshot', to: `ref(${lit(m.name)})`, uniqueId: m.uniqueId })),
      ...index.sources.map(x => ({
        label: `${x.source}.${x.table}`,
        description: 'source',
        to: `source(${lit(x.source)}, ${lit(x.table)})`,
        uniqueId: x.uniqueId
      }))
    ].sort((a, b) => a.label.localeCompare(b.label));
  },
  columnNames: async (root, uniqueId) => {
    const index = await loadManifest(languageDeps, root);
    const documented = [...(index?.models ?? []), ...(index?.sources ?? [])].find(n => n.uniqueId === uniqueId)?.columns ?? [];
    const catalog = (await loadCatalog(languageDeps, root))?.get(uniqueId) ?? [];
    // Documented spelling first; the catalog's (e.g. Snowflake's upper case) only for columns not documented.
    const seen = new Map<string, string>();
    for (const c of [...documented, ...catalog]) {
      if (!seen.has(c.name.toLowerCase())) {
        seen.set(c.name.toLowerCase(), c.name);
      }
    }
    return [...seen.values()];
  }
};

/** Runs a project-level dbt command; resolves with the project root and exit code (undefined if it didn't run). */
async function projectCommand(
  args: string[],
  label: string,
  forRoot?: string
): Promise<{ root: string; code: number | undefined } | undefined> {
  const root = forRoot ?? (await pickProjectRoot(true));
  if (!root) {
    void vscode.window.showErrorMessage('dbt Commander: no dbt project (dbt_project.yml) found in this workspace.');
    return undefined;
  }
  const exe = await requireExe();
  if (!exe) {
    return undefined;
  }
  // deps takes no target. retry still needs the flags dbt reads before the previous run's arguments
  // (e.g. --profiles-dir); --target is accepted and harmless.
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
    void vscode.window.showWarningMessage(`dbt Commander: static docs page not found at ${page}`);
    return;
  }
  if (cfg().get<boolean>('openDocsAfterGenerate', true)) {
    await vscode.env.openExternal(vscode.Uri.file(page));
  } else {
    void vscode.window.showInformationMessage(`dbt Commander: docs written to ${page}`);
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
    { label: '$(debug-restart) Rerun last command', command: 'dbtCommander.rerunLast' },
    { label: '$(notebook) New SQL scratchpad', description: 'run queries with ref() / source() through dbt show', command: 'dbtCommander.newScratchpad' },
    { label: '$(plug) Check connection (dbt debug)', command: 'dbtCommander.debug' },
    { label: '$(refresh) dbt retry', description: 'rerun only what failed last time', command: 'dbtCommander.retry' },
    { label: '$(package) dbt deps', command: 'dbtCommander.deps' },
    { label: '$(table) dbt seed', command: 'dbtCommander.seed' },
    { label: '$(history) dbt snapshot', command: 'dbtCommander.snapshot' },
    { label: '$(book) dbt docs generate', description: 'build static docs and open in browser', command: 'dbtCommander.docsGenerate' },
    { label: '$(target) Switch target…', command: 'dbtCommander.selectTarget' },
    { label: '$(gear) Settings', command: 'dbtCommander.openSettings' }
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
    dbtVersion = undefined;
    statusItem.text = '$(gear) dbt: not configured';
    statusItem.tooltip = 'dbt Commander: set the dbt venv';
    statusItem.backgroundColor = undefined;
    return;
  }
  const info = await detectDbtVersion(venv);
  if (seq !== statusSeq) {
    return; // a newer refresh superseded this one
  }
  dbtVersion = info.error ? undefined : info.version;
  if (info.error) {
    statusItem.text = '$(error) dbt: not found';
    statusItem.tooltip = info.error;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (info.major !== 1) {
    statusItem.text = `$(warning) dbt ${info.version}`;
    statusItem.tooltip = `dbt ${info.version} detected; dbt Commander supports dbt-core 1.x only.`;
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

/** Run a dbt command for sidebar tests / snapshots selected by name (one or several). */
async function runNodes(items: DbtItem[], action: 'test' | 'snapshot'): Promise<void> {
  const nodes = items.filter(i => i.data?.name && i.kind === (action === 'test' ? 'test' : 'snapshot'));
  if (!nodes.length) {
    return;
  }
  const roots = new Set(nodes.map(n => n.root));
  if (roots.size > 1) {
    void vscode.window.showErrorMessage('dbt Commander: selection spans several dbt projects. Run them separately.');
    return;
  }
  const exe = await requireExe();
  if (!exe) {
    return;
  }
  const root = nodes[0].root;
  // A singular test (its own .sql file) is selected by path: a bare name could also match a model of
  // the same name and run that model's tests too. Generic tests (defined in YAML) are selected by name.
  const selectors = nodes.map(n => {
    const file = n.resourceUri?.fsPath;
    return file && /\.sql$/i.test(file) ? modelSelector(root, file) : n.data.name!;
  });
  await runDbtTask({
    exe,
    args: [action, '--select', ...selectors, ...flagArgs(cfg().get<string>('target', ''), cfg().get<string>('extraArgs', ''))],
    cwd: root,
    title: `${action} ${nodes.map(n => n.data.name).join(' ')}`,
    diagnostics,
    targetDir: targetDirOf(root),
    folder: workspaceFolderOf(root)
  });
}

/** Files / folders a set of sidebar items stands for (sections expand to their target folders). */
const treeUris = (items: DbtItem[]): vscode.Uri[] =>
  items.flatMap(i => (i.data?.targets?.length ? i.data.targets.map(t => vscode.Uri.file(t)) : i.resourceUri ? [i.resourceUri] : []));
const treeSel = (item: DbtItem | undefined, selected: DbtItem[] | undefined) => pickSelection(item, selected);

/** dbt projects in the workspace — not installed packages, wherever packages-install-path puts them. */
async function projectRoots(): Promise<string[]> {
  const found = await vscode.workspace.findFiles('**/dbt_project.yml', '**/{dbt_packages,target,node_modules,.venv,venv,.vscode-test}/**', 50);
  return [...new Set(found.map(u => path.dirname(u.fsPath)))].filter(r => !isPackageRoot(r)).sort();
}

/** A configured model / seed / snapshot folder, or anything inside one (for the menu context keys). */
function inResourceFolder(file: string): boolean {
  if (/[\\/](\.git|node_modules|\.venv|venv|__pycache__)([\\/]|$)/i.test(file)) {
    return false;
  }
  const root = languageDeps.projectRootOf(file);
  if (!root) {
    return false;
  }
  const rel = path.relative(root, file).split(path.sep).join('/');
  const p = pathsOf(root);
  const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const under = (a: string, d: string) => same(a, d) || (process.platform === 'win32' ? a.toLowerCase() : a).startsWith((process.platform === 'win32' ? d.toLowerCase() : d) + '/');
  return [...p.model, ...p.seed, ...p.snapshot].some(d => under(rel, d)) && ![p.target, p.packagesInstall].some(d => under(rel, d));
}

/** An installed package's folder (inside an ancestor project's packages-install-path), not a project. */
function isPackageRoot(dir: string): boolean {
  return isUnderPackages(dir, d => exists(path.join(d, 'dbt_project.yml')), r => pathsOf(r).packagesInstall);
}

export interface DbtRunnerApi {
  sidebar: DbtSidebar;
  tests: DbtTests;
  lineage: DbtLineage;
  runStatus: RunStatusStore;
  lastRun: DbtLastRun;
  pathKeys: () => typeof pathKeys;
  publishPathKeys: () => Promise<void>;
  migrateSettings: () => Promise<number>;
  /** The v0.8 edit commands with their inputs given directly (no input box / refactor preview), for tests. */
  projectEdits: {
    rename(target: unknown, name: string, preview?: boolean): Promise<boolean>;
    createStaging(target: unknown, relPath: string): Promise<string | undefined>;
    newModel(folder: unknown, name: string): Promise<string | undefined>;
  };
  /** v0.10: scratchpads, previews of a selection / CTE (resolve with the rows), YAML test quick fixes. */
  query: {
    newScratchpad(root: string): Promise<vscode.TextEditor | undefined>;
    previewSelection(editor: vscode.TextEditor): Promise<ShowResult | undefined>;
    addColumnTests(uri: vscode.Uri, line: number, tests: TestSpec[]): Promise<boolean>;
    profileYamlColumn(uri: vscode.Uri, line: number): Promise<ShowResult | undefined>;
    /** Rows held by the preview panel and what Copy / Save CSV would write for a view state. */
    previewData(): { columns: string[]; rows: Record<string, unknown>[] } | undefined;
  };
}

/** Run dbt and capture its output (with a cancellable progress notification). */
function runCaptured(exe: string, args: string[], cwd: string, title: string): Promise<string> {
  return Promise.resolve(
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (_p, token) =>
      new Promise<string>(resolve => {
        const child = execFile(exe, args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout, stderr) =>
          resolve(`${stdout}\n${stderr}${err && !stdout && !stderr ? err.message : ''}`)
        );
        token.onCancellationRequested(() => killTree(child));
      })
    )
  );
}

/**
 * One-time move of settings saved under the extension's old name (`dbtRunner.*`) to `dbtCommander.*`, for user
 * and workspace settings. Old values are left in place; a value already set under the new name wins.
 */
async function migrateSettings(): Promise<number> {
  const all = vscode.workspace.getConfiguration();
  const now = vscode.workspace.getConfiguration('dbtCommander');
  const value = (i: ReturnType<typeof all.inspect>, scope: Scope) => (scope === 'global' ? i?.globalValue : i?.workspaceValue);
  const plan = plannedMigrations(
    MIGRATED_KEYS,
    (scope, key) => value(all.inspect(`dbtRunner.${key}`), scope),
    (scope, key) => value(now.inspect(key), scope)
  ).filter(p => p.scope === 'global' || vscode.workspace.workspaceFolders?.length);
  for (const p of plan) {
    await now.update(p.key, p.value, p.scope === 'global' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
  }
  return plan.length;
}

export function activate(ctx: vscode.ExtensionContext): DbtRunnerApi {
  context = ctx;
  diagnostics = new DbtDiagnostics(vscode.languages.createDiagnosticCollection('dbt'));
  // Settings from before the rename (dbt Runner → DataOps dbt Commander); then refresh what depends on them.
  void migrateSettings().then(n => {
    if (n) {
      void refreshStatus();
      void refreshTarget();
    }
  });

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'dbtCommander.menu';
  statusItem.show();
  targetItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  targetItem.command = 'dbtCommander.selectTarget';

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
      vscode.commands.registerCommand(`dbtCommander.${id}`, (uri?: vscode.Uri, uris?: vscode.Uri[]) => runDbt(action, graph, uri, uris))
    );
  }

  ctx.subscriptions.push(
    statusItem,
    targetItem,
    diagnostics,
    vscode.commands.registerCommand('dbtCommander.compile', (uri?: vscode.Uri) => compileModel(uri)),
    vscode.commands.registerCommand('dbtCommander.seedFiles', (uri?: vscode.Uri, uris?: vscode.Uri[]) => seedFiles(uri, uris)),
    vscode.commands.registerCommand('dbtCommander.generateYaml', (uri?: vscode.Uri) => generateYaml(uri)),
    vscode.commands.registerCommand('dbtCommander.preview', (uri?: vscode.Uri) => previewModel(uri)),
    vscode.commands.registerCommand('dbtCommander.newScratchpad', () => newScratchpad(queryDeps)),
    vscode.commands.registerCommand('dbtCommander.previewSelection', () => previewSelection(queryDeps)),
    vscode.commands.registerCommand('dbtCommander.addColumnTests', (uri: vscode.Uri, line: number, tests: Parameters<typeof addColumnTests>[3]) =>
      addColumnTests(queryDeps, uri, line, tests)
    ),
    vscode.commands.registerCommand('dbtCommander.profileColumn', (uri: vscode.Uri, line: number) => profileYamlColumn(queryDeps, uri, line)),
    vscode.languages.registerCodeActionsProvider(
      [{ scheme: 'file', pattern: '**/*.{yml,yaml}' }, { scheme: 'file', pattern: '**/*.sql' }],
      new DbtCodeActions(queryDeps),
      { providedCodeActionKinds: DbtCodeActions.kinds }
    ),
    trackScratchpads(),
    vscode.commands.registerCommand('dbtCommander.deps', () => projectCommand(['deps'], 'deps')),
    vscode.commands.registerCommand('dbtCommander.seed', () => projectCommand(['seed'], 'seed')),
    vscode.commands.registerCommand('dbtCommander.snapshot', () => projectCommand(['snapshot'], 'snapshot')),
    vscode.commands.registerCommand('dbtCommander.docsGenerate', docsGenerate),
    vscode.commands.registerCommand('dbtCommander.selectTarget', selectTarget),
    vscode.commands.registerCommand('dbtCommander.menu', showMenu),
    vscode.commands.registerCommand('dbtCommander.openSettings', openSettings),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('dbtCommander.venvPath')) {
        clearManifestCache(); // macro paths into the venv change with it
        void refreshStatus();
      }
      if (e.affectsConfiguration('dbtCommander.target') || e.affectsConfiguration('dbtCommander.extraArgs')) {
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

  // Last result per node, from every run_results.json (extension and terminal runs).
  const runStatus = new RunStatusStore(ctx.workspaceState, { projectRootOf: languageDeps.projectRootOf, targetDirOf, projectRoots });
  ctx.subscriptions.push(runStatus);
  void runStatus.init();

  registerLanguageFeatures(ctx, languageDeps, runStatus);

  const lastRunView = new DbtLastRun(languageDeps, runStatus);
  lastRunView.view = vscode.window.createTreeView('dbtCommander.lastRun', { treeDataProvider: lastRunView });
  ctx.subscriptions.push(
    lastRunView,
    lastRunView.view,
    // dbt retry: rerun only what failed / was skipped in the last run, in that run's project.
    vscode.commands.registerCommand('dbtCommander.retry', async (forRoot?: unknown) => {
      // From a notification: the project that run was in. Otherwise the latest run's project.
      const root = (typeof forRoot === 'string' && forRoot) || runStatus.lastRun?.root || (await pickProjectRoot(true));
      if (!root || !exists(path.join(targetDirOf(root), 'run_results.json'))) {
        void vscode.window.showInformationMessage('dbt Commander: there is no previous dbt run to retry.');
        return;
      }
      await projectCommand(['retry'], 'retry', root);
    }),
    vscode.commands.registerCommand('dbtCommander.rerunLast', async () => {
      const last = lastRunOptions();
      if (!last) {
        void vscode.window.showInformationMessage('dbt Commander: no dbt command has been run yet in this window.');
        return;
      }
      await runDbtTask(last);
    })
  );

  // Menus for custom folder names (model-paths etc.): publish now, and when projects or files change.
  void publishPathKeys();
  let pathTimer: NodeJS.Timeout | undefined;
  const republish = () => {
    clearTimeout(pathTimer);
    pathTimer = setTimeout(() => void publishPathKeys(), 1000);
  };
  const projectWatcher = vscode.workspace.createFileSystemWatcher('**/dbt_project.yml');
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false); // create / delete only
  ctx.subscriptions.push(
    projectWatcher,
    fileWatcher,
    projectWatcher.onDidChange(republish),
    projectWatcher.onDidCreate(republish),
    projectWatcher.onDidDelete(republish),
    // Only changes inside configured model / seed / snapshot folders (or those folders themselves) matter —
    // not target/ writes during runs, .git, venvs or packages.
    fileWatcher.onDidCreate(uri => inResourceFolder(uri.fsPath) && republish()),
    fileWatcher.onDidDelete(uri => inResourceFolder(uri.fsPath) && republish()),
    { dispose: () => clearTimeout(pathTimer) }
  );

  const sidebar = new DbtSidebar(languageDeps, runStatus);
  ctx.subscriptions.push(
    sidebar,
    vscode.window.createTreeView('dbtCommander.project', { treeDataProvider: sidebar, showCollapseAll: true, canSelectMany: true }),
    vscode.commands.registerCommand('dbtCommander.refreshSidebar', () => sidebar.refresh()),
    vscode.commands.registerCommand('dbtCommander.parse', async (item?: DbtItem) => {
      await projectCommand(['parse'], 'parse', item?.root);
      sidebar.refresh();
    }),
    // VS Code passes (clicked item, selected items): act on the whole Ctrl/Shift-click selection, in one dbt
    // command. Section items carry their target folders (data.targets); everything else its resourceUri.
    vscode.commands.registerCommand('dbtCommander.tree.run', (item?: DbtItem, selected?: DbtItem[]) =>
      runDbt('run', 'none', undefined, treeUris(treeSel(item, selected)))
    ),
    vscode.commands.registerCommand('dbtCommander.tree.build', (item?: DbtItem, selected?: DbtItem[]) =>
      runDbt('build', 'none', undefined, treeUris(treeSel(item, selected)))
    ),
    vscode.commands.registerCommand('dbtCommander.tree.test', (item?: DbtItem, selected?: DbtItem[]) =>
      runDbt('test', 'none', undefined, treeUris(treeSel(item, selected)))
    ),
    vscode.commands.registerCommand('dbtCommander.tree.seed', (item?: DbtItem, selected?: DbtItem[]) => seedFiles(undefined, treeUris(treeSel(item, selected)))),
    ...(['upstream', 'downstream', 'both'] as GraphScope[]).map(scope =>
      vscode.commands.registerCommand(`dbtCommander.tree.build${scope === 'upstream' ? 'Upstream' : scope === 'downstream' ? 'Downstream' : 'UpDownstream'}`, (item?: DbtItem, selected?: DbtItem[]) =>
        runDbt('build', scope, undefined, treeUris(treeSel(item, selected)))
      )
    ),
    vscode.commands.registerCommand('dbtCommander.tree.snapshot', (item?: DbtItem, selected?: DbtItem[]) => runNodes(treeSel(item, selected), 'snapshot')),
    vscode.commands.registerCommand('dbtCommander.tree.runTest', (item?: DbtItem, selected?: DbtItem[]) => runNodes(treeSel(item, selected), 'test')),
    vscode.commands.registerCommand('dbtCommander.tree.snapshotAll', (item: DbtItem) => projectCommand(['snapshot'], 'snapshot', item.root))
  );

  void refreshStatus();
  void refreshTarget();
  const tests = new DbtTests({
    language: languageDeps,
    projectRoots,
    requireExe,
    flags: () => flagArgs(cfg().get<string>('target', ''), cfg().get<string>('extraArgs', '')),
    diagnostics
  });
  ctx.subscriptions.push(tests);
  void tests.refresh();

  const lineage = new DbtLineage(languageDeps);
  lineage.view = vscode.window.createTreeView('dbtCommander.lineage', { treeDataProvider: lineage });
  ctx.subscriptions.push(
    lineage,
    lineage.view,
    vscode.commands.registerCommand('dbtCommander.showLineage', async (target?: unknown) => {
      const uri = asUri(target) ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri || !(await lineage.pin(uri))) {
        void vscode.window.showInformationMessage('dbt Commander: open a model, seed or snapshot (and run dbt parse) to see its lineage.');
        return;
      }
      await vscode.commands.executeCommand('dbtCommander.lineage.focus');
    }),
    vscode.commands.registerCommand('dbtCommander.lineage.followEditor', () => lineage.unpin())
  );
  void lineage.follow(vscode.window.activeTextEditor?.document.uri);

  // v0.8: rename model, staging model from a source, new model, open in docs, dbt debug.
  const edits: EditDeps = {
    language: languageDeps,
    requireExe,
    flags: () => flagArgs(cfg().get<string>('target', ''), cfg().get<string>('extraArgs', '')),
    settings: () => ({ target: cfg().get<string>('target', ''), extraArgs: cfg().get<string>('extraArgs', '') }),
    pickProjectRoot: () => pickProjectRoot(true),
    fetchRelationColumns,
    writeModelYaml,
    projectCommand,
    runCaptured,
    asUri
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand('dbtCommander.renameModel', (target?: unknown) => renameModel(edits, target)),
    vscode.commands.registerCommand('dbtCommander.createStaging', (target?: unknown) => createStagingModel(edits, target)),
    vscode.commands.registerCommand('dbtCommander.newModel', (target?: unknown) => newModel(edits, target)),
    vscode.commands.registerCommand('dbtCommander.openInDocs', (target?: unknown) => openInDocs(edits, target)),
    vscode.commands.registerCommand('dbtCommander.debug', () => checkConnection(edits))
  );

  return {
    sidebar,
    tests,
    lineage,
    runStatus,
    lastRun: lastRunView,
    pathKeys: () => pathKeys,
    publishPathKeys,
    migrateSettings,
    projectEdits: {
      rename: (target, name, preview) => renameModel(edits, target, name, preview),
      createStaging: (target, relPath) => createStagingModel(edits, target, relPath),
      newModel: (folder, name) => newModel(edits, folder, name)
    },
    query: {
      newScratchpad: root => newScratchpad(queryDeps, root),
      previewSelection: editor => previewSelection(queryDeps, editor),
      addColumnTests: (uri, line, tests) => addColumnTests(queryDeps, uri, line, tests),
      profileYamlColumn: (uri, line) => profileYamlColumn(queryDeps, uri, line),
      previewData: () => PreviewPanel.active?.data
    }
  };
}

export function deactivate(): void {}
