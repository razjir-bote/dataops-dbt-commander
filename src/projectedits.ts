import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LanguageDeps, inProjectPaths, loadManifest } from './language';
import { TextEdit, isValidModelName, renameRefEdits, renameYamlEdits, takenModelNames } from './refactor';
import { debugArgs, debugSummary, docsFragment, docsRedirectHtml, newModelSql, stagingName } from './scaffold';
import { BRONZE_DEFAULTS, BronzeRules, bronzeStaging } from './bronze';
import { HASH_COLUMNS_MACRO, SCD2_DEFAULTS, Scd2Rules, changeKeyNames, changeKeySql } from './scd2';

/** The SCD2 rules from settings (`dbtCommander.scd2.*`), defaults for anything unset. */
function scd2Rules(): Scd2Rules {
  const c = vscode.workspace.getConfiguration('dbtCommander.scd2');
  return {
    historySchema: c.get<string>('historySchema', SCD2_DEFAULTS.historySchema) || SCD2_DEFAULTS.historySchema,
    historyPrefix: c.get<string>('historyPrefix', SCD2_DEFAULTS.historyPrefix),
    changeKeyFolder: (c.get<string>('changeKeyFolder', SCD2_DEFAULTS.changeKeyFolder) || SCD2_DEFAULTS.changeKeyFolder).replace(/\\/g, '/').replace(/\/+$/, ''),
    hashColumns: c.get<string[]>('hashColumns', SCD2_DEFAULTS.hashColumns),
    extractDateColumn: c.get<string>('extractDateColumn', SCD2_DEFAULTS.extractDateColumn) || SCD2_DEFAULTS.extractDateColumn
  };
}

/** The bronze staging rules from settings (`dbtCommander.bronzeStaging.*`), defaults for anything unset. */
function bronzeRules(): BronzeRules {
  const c = vscode.workspace.getConfiguration('dbtCommander.bronzeStaging');
  const str = (k: keyof BronzeRules) => c.get<string>(k, BRONZE_DEFAULTS[k] as string);
  const list = (k: keyof BronzeRules) => c.get<string[]>(k, BRONZE_DEFAULTS[k] as string[]);
  return {
    datetimePattern: str('datetimePattern'),
    datePattern: str('datePattern'),
    keyColumn: str('keyColumn'),
    keyAlias: str('keyAlias') || BRONZE_DEFAULTS.keyAlias,
    partitionColumns: list('partitionColumns'),
    orderColumns: list('orderColumns'),
    deleteColumn: str('deleteColumn'),
    deleteKeepValues: list('deleteKeepValues')
  };
}
import { Column, addSourceTable, csvHeader } from './yamlgen';
import { callAt } from './jinja';

/** What the v0.8 project-edit commands need from the extension. */
export interface EditDeps {
  language: LanguageDeps;
  requireExe(): Promise<string | undefined>;
  flags(): string[];
  /** Raw target / extra-flags settings (dbt debug accepts only some flags). */
  settings(): { target: string; extraArgs: string };
  pickProjectRoot(): Promise<string | undefined>;
  fetchRelationColumns(exe: string, root: string, relation: string, label: string): Promise<{ columns: Column[]; error?: string }>;
  writeModelYaml(root: string, modelFile: string, model: string, columns: Column[]): Promise<void>;
  projectCommand(args: string[], label: string, root: string): Promise<{ root: string; code: number | undefined } | undefined>;
  runCaptured(exe: string, args: string[], cwd: string, title: string): Promise<string>;
  asUri(x: unknown): vscode.Uri | undefined;
  /** Remembers choices (e.g. the last source name) per workspace. */
  memento?: vscode.Memento;
}

const exists = (p: string) => fs.existsSync(p);

/** Line/character of an offset in a text (any line endings). */
function positionAt(text: string, offset: number): vscode.Position {
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g) ?? []).length;
  return new vscode.Position(line, offset - (before.lastIndexOf('\n') + 1));
}

async function currentText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
  return open ? open.getText() : fs.promises.readFile(uri.fsPath, 'utf8');
}

/** Project files that may ref() a model, outside target / packages / venvs. */
async function projectFiles(deps: EditDeps, root: string): Promise<vscode.Uri[]> {
  const paths = deps.language.pathsOf(root);
  const skip = [paths.target, paths.packagesInstall].map(d => d.toLowerCase());
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, '**/*.{sql,py,yml,yaml}'),
    '**/{dbt_packages,target,node_modules,.venv,venv,logs,.git}/**'
  );
  return found.filter(u => {
    const rel = path.relative(root, u.fsPath).split(path.sep).join('/').toLowerCase();
    return !rel.startsWith('..') && !skip.some(d => rel === d || rel.startsWith(d + '/'));
  });
}

// ---------- rename model ----------

/**
 * Rename a model: the .sql file, every ref() to it (models, snapshots, analyses, tests, macros, YAML) and its
 * `models:` YAML entry — as one edit. With `preview`, VS Code's refactor preview shows every change first.
 */
export async function renameModel(deps: EditDeps, target?: unknown, newName?: string, preview = true): Promise<boolean> {
  const uri = deps.asUri(target) ?? vscode.window.activeTextEditor?.document.uri;
  const file = uri?.fsPath;
  if (!uri || !file || !/\.sql$/i.test(file) || !inProjectPaths(deps.language, file, ['model'])) {
    void vscode.window.showErrorMessage('dbt Commander: pick a model (.sql file in your model folders) to rename.');
    return false;
  }
  const root = deps.language.projectRootOf(file)!;
  const pkg = deps.language.projectNameOf(root) ?? path.basename(root);
  const index = await loadManifest(deps.language, root);
  const node = index?.models.find(m => m.file.toLowerCase() === file.toLowerCase());
  if (node?.version !== undefined) {
    // orders_v2.sql is version 2 of `orders`: renaming one file would split the versioned model.
    void vscode.window.showErrorMessage(`dbt Commander: ${path.basename(file)} is version ${node.version} of the versioned model ${node.name}; renaming versioned models isn't supported yet.`);
    return false;
  }
  const oldName = node?.name ?? path.basename(file, path.extname(file));
  const taken = takenModelNames(index?.models ?? [], pkg, exists);
  const targetFile = (n: string) => path.join(path.dirname(file), `${n}.sql`);
  const problem = (v: string) =>
    !isValidModelName(v)
      ? 'Use letters, digits and _ (not starting with a digit).'
      : v === oldName
        ? 'That is the current name.'
        : (taken.has(v.toLowerCase()) && v.toLowerCase() !== oldName.toLowerCase()) || (exists(targetFile(v)) && v.toLowerCase() !== oldName.toLowerCase())
          ? `A model called ${v} already exists.`
          : undefined;
  const name =
    newName ??
    (await vscode.window.showInputBox({
      title: `Rename model ${oldName}`,
      prompt: 'New model name. The file, every ref() to it and its YAML entry are renamed.',
      value: oldName,
      validateInput: problem
    }));
  if (!name) {
    return false;
  }
  const why = problem(name);
  if (why) {
    void vscode.window.showErrorMessage(`dbt Commander: ${why}`);
    return false;
  }

  const edit = new vscode.WorkspaceEdit();
  const meta: vscode.WorkspaceEditEntryMetadata = { needsConfirmation: preview, label: `Rename ${oldName} → ${name}` };
  let changes = 0;
  for (const u of await projectFiles(deps, root)) {
    let text: string;
    try {
      text = await currentText(u);
    } catch {
      continue;
    }
    const edits: TextEdit[] = [
      ...renameRefEdits(text, oldName, name, pkg),
      ...(/\.ya?ml$/i.test(u.fsPath) ? renameYamlEdits(text, oldName, name) : [])
    ];
    for (const e of edits) {
      edit.replace(u, new vscode.Range(positionAt(text, e.start), positionAt(text, e.end)), e.text, meta);
      changes++;
    }
  }
  edit.renameFile(uri, vscode.Uri.file(targetFile(name)), { overwrite: false }, meta);
  const ok = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
  if (ok) {
    void vscode.window.showInformationMessage(
      `dbt Commander: renamed ${oldName} → ${name} (${changes} reference${changes === 1 ? '' : 's'}). ` +
        `Per-model settings under models: in dbt_project.yml are not renamed — check them if ${oldName} had any.`
    );
  }
  return ok;
}

// ---------- staging model from a source ----------

/** The source table a command was invoked on: sidebar source table, lineage source, or source() at the cursor. */
function sourceOf(target: unknown): { source: string; table: string; file?: string } | undefined {
  const t = target as { data?: { source?: string; name?: string }; node?: { type?: string; source?: string; table?: string } } | undefined;
  if (t?.data?.source && t.data.name) {
    return { source: t.data.source, table: t.data.name };
  }
  if (t?.node?.type === 'source' && t.node.source && t.node.table) {
    return { source: t.node.source, table: t.node.table };
  }
  const ed = vscode.window.activeTextEditor;
  const call = ed ? callAt(ed.document.lineAt(ed.selection.active.line).text, ed.selection.active.character) : undefined;
  return call?.kind === 'source' ? { source: call.source, table: call.table, file: ed!.document.uri.fsPath } : undefined;
}

/** Create `stg_<source>__<table>.sql` selecting the source's columns, plus its YAML entry. */
export async function createStagingModel(deps: EditDeps, target?: unknown, relPathArg?: string): Promise<string | undefined> {
  const src = sourceOf(target);
  if (!src) {
    void vscode.window.showErrorMessage("dbt Commander: pick a source table (sidebar) or put the cursor on a source('…', '…') call.");
    return undefined;
  }
  const t = target as { root?: string } | undefined;
  const root = t?.root ?? (src.file ? deps.language.projectRootOf(src.file) : undefined) ?? (await deps.pickProjectRoot());
  if (!root) {
    return undefined;
  }
  const name = stagingName(src.source, src.table);
  const folder = `${deps.language.pathsOf(root).model[0]}/staging/${name.split('__')[0].replace(/^stg_/, '')}`;
  const rel =
    relPathArg ??
    (await vscode.window.showInputBox({
      title: `Staging model for ${src.source}.${src.table}`,
      prompt: 'Where to create it (relative to the project)',
      value: `${folder}/${name}.sql`,
      validateInput: v =>
        !/\.sql$/i.test(v) ? 'End the path with .sql' : exists(path.join(root, ...v.split('/'))) ? 'That file already exists.' : undefined
    }));
  if (!rel) {
    return undefined;
  }
  const file = path.join(root, ...rel.split('/'));
  if (exists(file)) {
    void vscode.window.showErrorMessage(`dbt Commander: ${rel} already exists.`);
    return undefined;
  }
  const exe = await deps.requireExe();
  if (!exe) {
    return undefined;
  }
  const relation = `source('${src.source.replace(/'/g, "\\'")}', '${src.table.replace(/'/g, "\\'")}')`;
  const { columns } = await deps.fetchRelationColumns(exe, root, relation, `${src.source}.${src.table}`);
  const model = path.basename(file, '.sql');
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(vscode.Uri.file(file), { ignoreIfExists: false });
  // The team's bronze → staging pattern (T-SQL): typed, trimmed, deduped, deletes dropped.
  const staged = bronzeStaging(src.source, src.table, columns, bronzeRules());
  edit.insert(vscode.Uri.file(file), new vscode.Position(0, 0), staged.sql);
  if (!(await vscode.workspace.applyEdit(edit))) {
    return undefined;
  }
  await (await vscode.workspace.openTextDocument(vscode.Uri.file(file))).save();
  if (staged.columns.length) {
    await deps.writeModelYaml(root, file, model, staged.columns); // the staged columns and types, entity_id included
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  if (!columns.length) {
    void vscode.window.showWarningMessage(`dbt Commander: created ${model} with SELECT * — the source's columns couldn't be read from the warehouse.`);
  }
  return file;
}

// ---------- SCD2 change-key model from a staging model ----------

/** Whether any file in the project's macro folders defines `{% macro <name>(` (a manifest can be missing or stale). */
async function definesMacro(deps: EditDeps, root: string, name: string): Promise<boolean> {
  const re = new RegExp(`\\{%-?\\s*macro\\s+${name}\\s*\\(`);
  for (const dir of deps.language.pathsOf(root).macro) {
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(path.join(root, ...dir.split('/')), '**/*.sql'));
    for (const u of found) {
      try {
        if (re.test(await fs.promises.readFile(u.fsPath, 'utf8'))) {
          return true;
        }
      } catch {
        // unreadable: skip
      }
    }
  }
  return false;
}

/**
 * Create `int_<source>__<entity>_changekey.sql` from a staging model (`stg_<source>__<entity>`) in the team's SCD2
 * template, plus its YAML entry — and `macros/hash_columns.sql` when the hash needs it and the project lacks it.
 */
export async function createChangeKeyModel(deps: EditDeps, target?: unknown, relPathArg?: string): Promise<string | undefined> {
  const uri = deps.asUri(target) ?? vscode.window.activeTextEditor?.document.uri;
  const file = uri?.fsPath;
  const rules = scd2Rules();
  const staging = file ? path.basename(file, path.extname(file)) : '';
  const names = changeKeyNames(staging, rules);
  if (!file || !/\.sql$/i.test(file) || !inProjectPaths(deps.language, file, ['model']) || !names) {
    void vscode.window.showErrorMessage('dbt Commander: pick a staging model (a stg_….sql file in your model folders).');
    return undefined;
  }
  const root = deps.language.projectRootOf(file)!;
  const rel =
    relPathArg ??
    (await vscode.window.showInputBox({
      title: `SCD2 change-key model for ${staging}`,
      prompt: 'Where to create it (relative to the project)',
      value: `${rules.changeKeyFolder}/${names.model}.sql`,
      validateInput: v =>
        !/\.sql$/i.test(v) ? 'End the path with .sql' : exists(path.join(root, ...v.split('/'))) ? 'That file already exists.' : undefined
    }));
  if (!rel) {
    return undefined;
  }
  const target2 = path.join(root, ...rel.split('/'));
  if (exists(target2)) {
    void vscode.window.showErrorMessage(`dbt Commander: ${rel} already exists.`);
    return undefined;
  }
  // The staging model's columns: the built table (exact), else its YAML entry (Create staging model writes one).
  const index = await loadManifest(deps.language, root);
  const pkg = deps.language.projectNameOf(root) ?? path.basename(root);
  const exe = await deps.requireExe();
  if (!exe) {
    return undefined;
  }
  let columns: Column[] = (await deps.fetchRelationColumns(exe, root, `ref('${staging.replace(/'/g, "\\'")}')`, staging)).columns;
  const fromYaml = !columns.length;
  if (fromYaml) {
    columns = (index?.models.find(m => m.name === staging && m.package === pkg)?.columns ?? []).map(c => ({ name: c.name, dataType: c.dataType ?? '' }));
  }
  // The staging key copy (bronzeStaging.keyAlias) is the key, not data: keep it out of a computed hash.
  const keyAlias = vscode.workspace.getConfiguration('dbtCommander.bronzeStaging').get<string>('keyAlias', BRONZE_DEFAULTS.keyAlias);
  const { sql, usesMacro } = changeKeySql(staging, columns.map(c => c.name), rules, keyAlias ? [keyAlias] : []);
  const model = path.basename(target2, path.extname(target2)); // as named in the prompt

  const edit = new vscode.WorkspaceEdit();
  edit.createFile(vscode.Uri.file(target2), { ignoreIfExists: false });
  edit.insert(vscode.Uri.file(target2), new vscode.Position(0, 0), sql);
  let macroFile: string | undefined;
  if (usesMacro && !index?.macros.some(m => m.name === 'hash_columns' && m.package === pkg) && !(await definesMacro(deps, root, 'hash_columns'))) {
    macroFile = path.join(root, ...(deps.language.pathsOf(root).macro[0] ?? 'macros').split('/'), 'hash_columns.sql');
    if (exists(macroFile)) {
      macroFile = undefined; // there already (not parsed yet): never overwrite
    } else {
      edit.createFile(vscode.Uri.file(macroFile), { ignoreIfExists: true });
      edit.insert(vscode.Uri.file(macroFile), new vscode.Position(0, 0), HASH_COLUMNS_MACRO);
    }
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    return undefined;
  }
  for (const f of [target2, macroFile]) {
    if (f) {
      await (await vscode.workspace.openTextDocument(vscode.Uri.file(f))).save();
    }
  }
  if (columns.length) {
    await deps.writeModelYaml(root, target2, model, [...columns, { name: 'attribute_hash', dataType: usesMacro ? 'varchar(64)' : '' }]);
  }
  await vscode.window.showTextDocument(vscode.Uri.file(target2), { preview: false });
  const notes = [
    macroFile ? `added the hash_columns macro (${path.relative(root, macroFile).split(path.sep).join('/')})` : '',
    columns.length ? '' : "the staging model's columns couldn't be read (build it first) — fill in attribute_hash",
    fromYaml && columns.length ? "columns taken from the staging model's YAML (it isn't built) — check attribute_hash" : ''
  ].filter(Boolean);
  if (notes.length) {
    void vscode.window.showInformationMessage(`dbt Commander: created ${model}; ${notes.join('; ')}.`);
  }
  return target2;
}

// ---------- seed as source ----------

const SOURCE_NAME_KEY = 'dbtCommander.seedSourceName';

/**
 * Add the selected seed CSVs as tables of a source (default `bronze`) in `_<source>__sources.yml`, pointing at
 * the seeds' built tables, so `source('bronze', '<seed>')` and Create staging model work on sample data.
 * Returns the YAML file written.
 */
export async function addSeedsAsSource(
  deps: EditDeps,
  target?: unknown,
  targets?: unknown[],
  answers?: { source: string; file: string }
): Promise<string | undefined> {
  const uris = [...(targets ?? []), target]
    .map(t => deps.asUri(t))
    .filter((u): u is vscode.Uri => !!u && /\.csv$/i.test(u.fsPath) && inProjectPaths(deps.language, u.fsPath, ['seed']));
  const files = [...new Map(uris.map(u => [u.fsPath.toLowerCase(), u.fsPath])).values()];
  if (!files.length) {
    void vscode.window.showErrorMessage('dbt Commander: pick one or more seed .csv files in your seed folders.');
    return undefined;
  }
  const root = deps.language.projectRootOf(files[0])!;
  if (files.some(f => deps.language.projectRootOf(f) !== root)) {
    void vscode.window.showErrorMessage('dbt Commander: the seeds are in different dbt projects. Add them separately.');
    return undefined;
  }
  // The seeds' schemas come from the manifest: parse first when a seed isn't in it yet.
  const seedOf = async () => {
    const index = await loadManifest(deps.language, root);
    return (f: string) => index?.seeds.find(s => s.file.toLowerCase() === f.toLowerCase());
  };
  let find = await seedOf();
  if (files.some(f => !find(f))) {
    await deps.projectCommand(['parse'], 'parse', root);
    find = await seedOf();
  }
  const missing = files.filter(f => !find(f));
  if (missing.length) {
    void vscode.window.showErrorMessage(`dbt Commander: ${missing.map(f => path.basename(f)).join(', ')} isn't in the manifest — check dbt parse in the terminal.`);
    return undefined;
  }
  const source =
    answers?.source ??
    (await vscode.window.showInputBox({
      title: `Add ${files.length === 1 ? path.basename(files[0]) : `${files.length} seeds`} as a source`,
      prompt: 'Source name',
      value: deps.memento?.get<string>(SOURCE_NAME_KEY) ?? 'bronze',
      validateInput: v => (/^[A-Za-z_][\w]*$/.test(v.trim()) ? undefined : 'Use letters, digits and _ (not starting with a digit).')
    }))?.trim();
  if (!source) {
    return undefined;
  }
  await deps.memento?.update(SOURCE_NAME_KEY, source);
  const rel =
    answers?.file ??
    (await vscode.window.showInputBox({
      title: `Source ${source}`,
      prompt: 'YAML file for the source (relative to the project; created if missing)',
      value: `${deps.language.pathsOf(root).model[0] ?? 'models'}/staging/${source}/_${source}__sources.yml`,
      validateInput: v => (/\.ya?ml$/i.test(v.trim()) ? undefined : 'End the path with .yml')
    }))?.trim();
  if (!rel) {
    return undefined;
  }
  const yml = path.join(root, ...rel.split('/'));
  let text = exists(yml) ? await currentText(vscode.Uri.file(yml)) : '';
  const added: string[] = [];
  const already: string[] = [];
  try {
    for (const f of files) {
      const seed = find(f)!;
      const columns = csvHeader(await fs.promises.readFile(f, 'utf8'));
      const r = addSourceTable(text, {
        source,
        ...(seed.schema ? { schema: seed.schema } : {}),
        ...(seed.database ? { database: seed.database } : {}),
        table: seed.name,
        description: `Loaded from the seed ${seed.name} (dbt seed).`,
        columns
      });
      text = r.text;
      (r.status === 'added' ? added : already).push(seed.name);
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`dbt Commander: can't edit ${rel}: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
  if (added.length) {
    const uri = vscode.Uri.file(yml);
    const edit = new vscode.WorkspaceEdit();
    if (exists(yml)) {
      const doc = await vscode.workspace.openTextDocument(uri);
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    } else {
      edit.createFile(uri, { ignoreIfExists: false });
      edit.insert(uri, new vscode.Position(0, 0), text);
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      return undefined;
    }
    await (await vscode.workspace.openTextDocument(uri)).save();
    await vscode.window.showTextDocument(uri, { preview: false });
    await deps.projectCommand(['parse'], 'parse', root); // the source shows in the sidebar / completion
  }
  const parts = [
    added.length ? `added ${added.join(', ')} to source ${source}` : '',
    already.length ? `${already.join(', ')} already in source ${source}` : ''
  ].filter(Boolean);
  void vscode.window
    .showInformationMessage(`dbt Commander: ${parts.join('; ')}. Run dbt seed so the table${files.length === 1 ? '' : 's'} exist${files.length === 1 ? 's' : ''}.`, 'Run dbt seed')
    .then(pick => pick && vscode.commands.executeCommand('dbtCommander.seedFiles', vscode.Uri.file(files[0]), files.map(f => vscode.Uri.file(f))));
  return yml;
}

// ---------- new model ----------

/** Create `<folder>/<name>.sql` from the template (setting `dbtCommander.newModelTemplate`) plus a YAML entry. */
export async function newModel(deps: EditDeps, target?: unknown, nameArg?: string): Promise<string | undefined> {
  const folder = deps.asUri(target)?.fsPath;
  let isDir = false;
  try {
    isDir = !!folder && fs.statSync(folder).isDirectory();
  } catch {
    isDir = false;
  }
  const root = folder ? deps.language.projectRootOf(path.join(folder, '_')) : undefined;
  if (!folder || !isDir || !root) {
    void vscode.window.showErrorMessage('dbt Commander: right-click a folder in your dbt project to create a model in it.');
    return undefined;
  }
  const name =
    nameArg ??
    (await vscode.window.showInputBox({
      title: `New model in ${path.relative(root, folder) || '.'}`,
      prompt: 'Model name',
      validateInput: v =>
        !isValidModelName(v) ? 'Use letters, digits and _ (not starting with a digit).' : exists(path.join(folder, `${v}.sql`)) ? 'That file already exists.' : undefined
    }));
  if (!name || !isValidModelName(name) || exists(path.join(folder, `${name}.sql`))) {
    return undefined;
  }
  let template: string | undefined;
  const setting = vscode.workspace.getConfiguration('dbtCommander').get<string>('newModelTemplate', '').trim();
  if (setting) {
    try {
      template = fs.readFileSync(path.isAbsolute(setting) ? setting : path.join(root, setting), 'utf8');
    } catch {
      void vscode.window.showWarningMessage(`dbt Commander: template ${setting} not found — using the built-in one.`);
    }
  }
  const file = path.join(folder, `${name}.sql`);
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(vscode.Uri.file(file), { ignoreIfExists: false });
  edit.insert(vscode.Uri.file(file), new vscode.Position(0, 0), newModelSql(name, template));
  if (!(await vscode.workspace.applyEdit(edit))) {
    return undefined;
  }
  await (await vscode.workspace.openTextDocument(vscode.Uri.file(file))).save();
  await deps.writeModelYaml(root, file, name, []);
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  return file;
}

// ---------- open in dbt docs ----------

/** The dbt node a target stands for (tree item, lineage item, or a file), with its project. */
async function nodeOf(deps: EditDeps, target: unknown): Promise<{ root: string; id: string } | undefined> {
  const t = target as { node?: { id?: string }; root?: string; data?: { source?: string; name?: string } } | undefined;
  const file = deps.asUri(target)?.fsPath ?? (target === undefined ? vscode.window.activeTextEditor?.document.uri.fsPath : undefined);
  const root = t?.root ?? (file ? deps.language.projectRootOf(file) : undefined);
  if (!root) {
    return undefined;
  }
  if (t?.node?.id) {
    return { root, id: t.node.id };
  }
  const index = await loadManifest(deps.language, root);
  if (!index) {
    return undefined;
  }
  if (t?.data?.source && t.data.name) {
    const src = index.sources.find(s => s.source === t.data!.source && s.table === t.data!.name);
    return src && { root, id: src.uniqueId };
  }
  const lower = file?.toLowerCase();
  // A YAML file can hold several exposures / semantic models: match the item's name too.
  const wanted = t?.data?.name;
  const candidates = lower ? [...index.nodes.values()].filter(n => n.file?.toLowerCase() === lower && n.type !== 'test' && n.type !== 'source') : [];
  const node = candidates.find(n => !wanted || n.name === wanted) ?? (wanted ? undefined : candidates[0]);
  return node && { root, id: node.id };
}

/**
 * Open a node's page in dbt's static docs (`static_index.html#!/model/<id>`), regenerating the site first when
 * it's missing or older than the manifest. Opens through a small redirect page, because a `#!` fragment does not
 * survive being handed to the browser as a file URI. Returns the docs URL (for tests).
 */
export async function openInDocs(deps: EditDeps, target?: unknown): Promise<string | undefined> {
  const found = await nodeOf(deps, target);
  if (!found) {
    void vscode.window.showErrorMessage('dbt Commander: pick a model, source, seed, snapshot or exposure (and run dbt parse first).');
    return undefined;
  }
  const targetDir = deps.language.targetDirOf(found.root);
  const page = path.join(targetDir, 'static_index.html');
  const manifest = path.join(targetDir, 'manifest.json');
  const mtime = (p: string) => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return -1;
    }
  };
  // Regenerate only when the page is missing or doesn't know this node yet: almost every dbt command rewrites
  // manifest.json, and `docs generate` also queries the warehouse for the catalog.
  let known = false;
  try {
    known = fs.readFileSync(page, 'utf8').includes(found.id);
  } catch {
    known = false;
  }
  if (!known) {
    const result = await deps.projectCommand(['docs', 'generate', '--static'], 'docs generate', found.root);
    if (!result || result.code !== 0 || !exists(page)) {
      void vscode.window.showErrorMessage(
        'dbt Commander: dbt docs generate --static failed (it needs dbt-core 1.7 or later) — see the terminal for details.'
      );
      return undefined;
    }
  }
  const url = `static_index.html#${docsFragment(found.id)}`;
  const redirect = path.join(targetDir, 'dbt_commander_docs.html');
  fs.writeFileSync(redirect, docsRedirectHtml(url));
  if (vscode.workspace.getConfiguration('dbtCommander').get<boolean>('openDocsAfterGenerate', true)) {
    await vscode.env.openExternal(vscode.Uri.file(redirect));
  } else {
    void vscode.window.showInformationMessage(`dbt Commander: docs page is ${page}#${docsFragment(found.id)}`);
  }
  return `${page}#${docsFragment(found.id)}`;
}

// ---------- dbt debug ----------

const debugOutput = vscode.window.createOutputChannel('dbt debug');

/** Run `dbt debug` and report "All checks passed" or what failed. Returns the summary (for tests). */
export async function checkConnection(deps: EditDeps, rootArg?: string): Promise<{ ok: boolean; text: string } | undefined> {
  const root = rootArg ?? (await deps.pickProjectRoot());
  const exe = root ? await deps.requireExe() : undefined;
  if (!root || !exe) {
    return undefined;
  }
  const s = deps.settings();
  const output = await deps.runCaptured(exe, ['debug', ...debugArgs(s.target, s.extraArgs)], root, 'dbt debug: checking the connection');
  debugOutput.clear();
  debugOutput.append(output.replace(/\x1b\[[0-9;]*m/g, ''));
  const summary = debugSummary(output);
  // Don't wait for the notification: it only settles when the user clicks it.
  void (summary.ok
    ? vscode.window.showInformationMessage(`dbt debug: ${summary.text}`, 'Show output')
    : vscode.window.showErrorMessage(`dbt debug: ${summary.text}`, 'Show output')
  ).then(pick => pick && debugOutput.show());
  return summary;
}
