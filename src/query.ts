import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { cteQueryAt, inlineSql } from './scratch';
import { ShowResult, parseShowOutput } from './show';
import { PreviewOptions, PreviewPanel } from './previewPanel';
import { ColumnOwner, isMinMaxError, profileRows, profileSql, relationSql, yamlColumnSql } from './profile';
import { columnRef } from './scaffold';
import { scalar } from './yamlgen';
import { killTree } from './runner';
import { TestSpec, addTestsEdit, columnAt, columnOwnerAt, legacyTestArguments, parseValueList } from './yamlfix';
import { sourceTableAt } from './yamlcontext';

export interface QueryDeps {
  requireExe(): Promise<string | undefined>;
  pickProjectRoot(): Promise<string | undefined>;
  projectRootOf(file: string): string | undefined;
  isModelFile(file: string): boolean;
  /** `show` + target / extra flags + the given selection args. */
  showArgs(select: string[]): string[];
  previewLimit(): number;
  previewModel(uri: vscode.Uri): Promise<void>;
  /** dbt-core version from the configured venv, if known. */
  dbtVersion(): string | undefined;
  /** A YAML file of the project itself (not under its packages or target folder). */
  isProjectYaml(file: string): boolean;
  /** The model has no YAML entry yet (from the manifest). */
  lacksYaml(file: string): Promise<boolean>;
  /** A package's macros are in the project's manifest (it is installed). */
  hasPackage(root: string, pkg: string): Promise<boolean>;
  /** The project's models and sources, for picking a relationships parent. */
  relations(root: string): Promise<{ label: string; description?: string; to: string; uniqueId: string }[]>;
  /** Known column names of a node (documented in YAML, or from catalog.json). */
  columnNames(root: string, uniqueId: string): Promise<string[]>;
}

export interface ShowOptions extends PreviewOptions {
  /** Reshape the rows before they're shown (e.g. a profile). */
  transform?: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
  /** Row limit instead of dbtCommander.previewLimit. */
  limit?: number;
}

let previewSeq = 0;

/** Run `dbt show … --output json` and show the rows in the preview panel (Refresh re-runs it). */
export async function runShow(
  exe: string,
  cwd: string,
  title: string,
  select: string[],
  deps: QueryDeps,
  options: ShowOptions = {}
): Promise<ShowResult | undefined> {
  const limit = options.limit ?? deps.previewLimit();
  const args = [...deps.showArgs(select), '--limit', String(limit), '--output', 'json', '--log-format', 'json'];
  const run = async (): Promise<ShowResult | undefined> => {
    const seq = ++previewSeq;
    const panel = PreviewPanel.loading(title, () => void run(), options);
    const started = Date.now();
    const output = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `dbt show ${title}`, cancellable: true },
      (_progress, token) =>
        new Promise<string>(resolve => {
          const child = execFile(
            exe,
            args,
            { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
            (err, stdout, stderr) => resolve(`${stdout}\n${stderr}${err && !stdout && !stderr ? err.message : ''}`)
          );
          token.onCancellationRequested(() => killTree(child));
        })
    );
    const parsed = parseShowOutput(output);
    const result = parsed.rows && options.transform ? { rows: options.transform(parsed.rows) } : parsed;
    if (seq !== previewSeq) {
      return undefined; // a newer preview replaced this one: drop the stale result
    }
    panel.showResult(title, result, Date.now() - started, limit);
    return result;
  };
  return run();
}

const SCRATCH = /^dbt-scratch-\d+\.sql$/i;

/** An untitled scratchpad opened by the extension (its name survives a window reload / hot exit). */
export function isScratchpad(doc: vscode.TextDocument | undefined): boolean {
  return !!doc && doc.isUntitled && SCRATCH.test(path.basename(doc.uri.fsPath));
}

/** Open a new untitled `dbt-scratch-N.sql` in a dbt project's folder. */
export async function newScratchpad(deps: QueryDeps, forRoot?: string): Promise<vscode.TextEditor | undefined> {
  const root = forRoot ?? (await deps.pickProjectRoot());
  if (!root) {
    void vscode.window.showErrorMessage('dbt Commander: no dbt project (dbt_project.yml) found in this workspace.');
    return undefined;
  }
  const taken = new Set(vscode.workspace.textDocuments.map(d => path.basename(d.uri.fsPath).toLowerCase()));
  let n = 1;
  while (taken.has(`dbt-scratch-${n}.sql`) || fs.existsSync(path.join(root, `dbt-scratch-${n}.sql`))) {
    n++;
  }
  const uri = vscode.Uri.file(path.join(root, `dbt-scratch-${n}.sql`)).with({ scheme: 'untitled' });
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (!doc.getText()) {
    const body = [
      `-- dbt scratchpad (${path.basename(root)}): Ctrl+Enter runs the query, or just the selection, with dbt show.`,
      '-- ref(), source() and macros work; the active target is used.',
      'select *',
      "from {{ ref('') }}",
      ''
    ].join('\n');
    await editor.edit(e => e.insert(new vscode.Position(0, 0), body));
    const pos = new vscode.Position(3, 13);
    editor.selection = new vscode.Selection(pos, pos);
  }
  return editor;
}

/**
 * Preview what's selected: in a scratchpad (or other SQL file) the selection or the whole text; in a model the
 * selection, else the CTE under the cursor, else the model itself.
 */
export async function previewSelection(deps: QueryDeps, editor = vscode.window.activeTextEditor): Promise<ShowResult | undefined> {
  if (!editor) {
    return undefined;
  }
  const doc = editor.document;
  const root = deps.projectRootOf(doc.uri.fsPath);
  if (!root || (!doc.isUntitled && doc.uri.scheme !== 'file')) {
    void vscode.window.showWarningMessage('dbt Commander: this file is not in a dbt project.');
    return undefined;
  }
  const selected = editor.selection.isEmpty ? '' : doc.getText(editor.selection); // the primary selection only
  const isModel = doc.uri.scheme === 'file' && deps.isModelFile(doc.uri.fsPath);
  const base = isModel ? path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath)) : 'Query';
  let sql: string;
  let title: string;
  if (selected.trim()) {
    sql = selected;
    title = `${base} (selection)`;
  } else if (isModel) {
    const cte = cteQueryAt(doc.getText(), doc.offsetAt(editor.selection.active));
    if (cte) {
      sql = cte.sql;
      title = `${base} › ${cte.name}`;
    } else if (doc.isDirty) {
      // Like selections and CTEs: preview the editor's text without saving the file.
      sql = doc.getText();
      title = `${base} (unsaved)`;
    } else {
      await deps.previewModel(doc.uri);
      return undefined;
    }
  } else {
    sql = doc.getText();
    title = base;
  }
  sql = inlineSql(sql);
  if (!sql) {
    void vscode.window.showInformationMessage('dbt Commander: nothing to run.');
    return undefined;
  }
  if (process.platform === 'win32' && sql.length > 30000) {
    // Windows command lines are limited to 32,767 characters, and the SQL is passed as an argument.
    void vscode.window.showWarningMessage('dbt Commander: this query is too long to preview inline on Windows; select a smaller part.');
    return undefined;
  }
  const exe = await deps.requireExe();
  return exe ? runShow(exe, root, title, ['--inline', sql], deps) : undefined;
}

/** Profile one column (rows, nulls, distinct, min, max, top values) in the preview panel. */
/**
 * Profile one column of the built table / view (rows, nulls, distinct, min, max, top values) in the preview panel.
 * \`fromYaml\`: the name is as written in YAML (bare unless it needs quoting), not as the warehouse returned it.
 */
export async function profileColumn(
  deps: QueryDeps,
  root: string,
  owner: ColumnOwner,
  column: string,
  fromYaml = false
): Promise<ShowResult | undefined> {
  const exe = await deps.requireExe();
  if (!exe) {
    return undefined;
  }
  const where = owner.kind === 'source' ? `${owner.source}.${owner.name}` : owner.name;
  const sql = fromYaml ? yamlColumnSql(column) : columnRef(column);
  const run = (minMax: boolean) =>
    runShow(exe, root, `${where}.${column} profile`, ['--inline', profileSql(relationSql(owner), sql, { minMax, columnIsSql: true })], deps, {
      transform: profileRows,
      limit: 50
    });
  const result = await run(true);
  // e.g. Postgres uuid / boolean columns have no min() / max(): profile the rest.
  return result && isMinMaxError(result.error) ? run(false) : result;
}

/** Profile the YAML column at `line` of a file. */
export async function profileYamlColumn(deps: QueryDeps, uri: vscode.Uri, line: number): Promise<ShowResult | undefined> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const col = columnOwnerAt(doc.getText(), line);
  const root = deps.projectRootOf(uri.fsPath);
  if (!col || !root) {
    return undefined;
  }
  return profileColumn(deps, root, col, col.column, true);
}

/** Keeps `dbtCommander.isScratchpad` in step with the active editor (for the Ctrl+Enter keybinding). */
export function trackScratchpads(): vscode.Disposable {
  const update = (e: vscode.TextEditor | undefined) => vscode.commands.executeCommand('setContext', 'dbtCommander.isScratchpad', isScratchpad(e?.document));
  void update(vscode.window.activeTextEditor);
  return vscode.window.onDidChangeActiveTextEditor(update);
}

function testsEdit(doc: vscode.TextDocument, line: number, tests: TestSpec[], deps: QueryDeps): vscode.WorkspaceEdit | undefined {
  const e = addTestsEdit(doc.getText(), line, tests, { legacyArguments: legacyTestArguments(deps.dbtVersion()) });
  if (!e) {
    return undefined;
  }
  const edit = new vscode.WorkspaceEdit();
  if (e.line < doc.lineCount) {
    edit.insert(doc.uri, new vscode.Position(e.line, 0), e.text);
  } else {
    // After the last line of a file without a final newline: start a new line first.
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    edit.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, eol + e.text.slice(0, -eol.length));
  }
  return edit;
}

export type AskedTest = 'accepted_values' | 'relationships' | 'accepted_range';

/** relationships: pick the parent model / source, then its column. */
async function askRelationships(deps: QueryDeps, root: string, column: string): Promise<TestSpec | undefined> {
  const parents = await deps.relations(root);
  if (!parents.length) {
    void vscode.window.showWarningMessage('dbt Commander: no models or sources found — run dbt parse first.');
    return undefined;
  }
  const parent = await vscode.window.showQuickPick(parents, { title: `relationships: ${column} references…`, placeHolder: 'Parent model or source', matchOnDescription: true });
  if (!parent) {
    return undefined;
  }
  const known = await deps.columnNames(root, parent.uniqueId);
  const other = '$(edit) Another column…';
  let field: string | undefined;
  if (known.length) {
    const pick = await vscode.window.showQuickPick([...known, other], { title: `relationships: ${column} → ${parent.label}.?`, placeHolder: 'Column in the parent' });
    if (!pick) {
      return undefined;
    }
    field = pick === other ? undefined : pick;
  }
  field ??= await vscode.window.showInputBox({
    title: `relationships: ${column} → ${parent.label}.?`,
    prompt: 'Column in the parent',
    value: column,
    validateInput: v => (v.trim() ? undefined : 'Enter a column name')
  });
  return field?.trim() ? { test: 'relationships', args: { to: parent.to, field: scalar(field.trim()) } } : undefined;
}

/** dbt_utils.accepted_range: min and / or max (numbers). */
async function askRange(column: string): Promise<TestSpec | undefined> {
  const NUM = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
  const num = (v: string) => (!v.trim() || NUM.test(v.trim()) ? undefined : 'Enter a number, or leave empty');
  const min = await vscode.window.showInputBox({ title: `dbt_utils.accepted_range for ${column}`, prompt: 'Minimum (empty for none)', validateInput: num });
  if (min === undefined) {
    return undefined;
  }
  const max = await vscode.window.showInputBox({
    title: `dbt_utils.accepted_range for ${column}`,
    prompt: 'Maximum (empty for none)',
    validateInput: v =>
      num(v) ??
      (!v.trim() && !min.trim()
        ? 'Enter a minimum or a maximum'
        : v.trim() && min.trim() && Number(v.trim()) < Number(min.trim())
          ? 'The maximum is below the minimum'
          : undefined)
  });
  if (max === undefined) {
    return undefined;
  }
  const args: Record<string, string> = {};
  if (min.trim()) {
    args.min_value = min.trim(); // as typed: no rounding of big or precise numbers
  }
  if (max.trim()) {
    args.max_value = max.trim();
  }
  return { test: 'dbt_utils.accepted_range', args };
}

/** Add tests to the YAML column at `line`; accepted_values / relationships / accepted_range ask for their arguments. */
export async function addColumnTests(deps: QueryDeps, uri: vscode.Uri, line: number, tests: TestSpec[] | AskedTest): Promise<boolean> {
  const doc = await vscode.workspace.openTextDocument(uri);
  let specs: TestSpec[];
  if (tests === 'relationships' || tests === 'accepted_range') {
    const col = columnAt(doc.getText(), line);
    const root = deps.projectRootOf(uri.fsPath);
    if (!col || !root) {
      return false;
    }
    const spec = tests === 'relationships' ? await askRelationships(deps, root, col.column) : await askRange(col.column);
    if (!spec) {
      return false;
    }
    specs = [spec];
  } else if (tests === 'accepted_values') {
    const col = columnAt(doc.getText(), line);
    const input = await vscode.window.showInputBox({
      title: `accepted_values for ${col?.model}.${col?.column}`,
      prompt: 'Accepted values, separated by commas. Put a value in quotes to keep commas or spaces in it.',
      placeHolder: 'placed, shipped, "returned, partially"',
      validateInput: v => (parseValueList(v).length ? undefined : 'Enter at least one value')
    });
    if (!input) {
      return false;
    }
    specs = [{ accepted_values: parseValueList(input) }];
  } else {
    specs = tests;
  }
  const edit = testsEdit(doc, line, specs, deps);
  return !!edit && vscode.workspace.applyEdit(edit);
}

/** Lightbulb actions: add tests on a model column in YAML; Generate YAML on the first line of a model without one. */
export class DbtCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly deps: QueryDeps) {}

  async provideCodeActions(doc: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[] | undefined> {
    if (doc.uri.scheme !== 'file') {
      return undefined;
    }
    if (/\.ya?ml$/i.test(doc.fileName)) {
      return this.yamlActions(doc, range.start.line);
    }
    if (/\.sql$/i.test(doc.fileName) && range.start.line === 0 && this.deps.isModelFile(doc.uri.fsPath) && (await this.deps.lacksYaml(doc.uri.fsPath))) {
      const a = new vscode.CodeAction('Generate YAML for this model', vscode.CodeActionKind.QuickFix);
      a.command = { command: 'dbtCommander.generateYaml', title: a.title, arguments: [doc.uri] };
      return [a];
    }
    return undefined;
  }

  private async yamlActions(doc: vscode.TextDocument, line: number): Promise<vscode.CodeAction[] | undefined> {
    const root = this.deps.projectRootOf(doc.uri.fsPath);
    if (!root || !this.deps.isProjectYaml(doc.uri.fsPath)) {
      return undefined;
    }
    const owner = columnOwnerAt(doc.getText(), line);
    if (!owner) {
      // A source table's own lines (not its columns): create its staging model.
      const st = sourceTableAt(doc.getText(), line);
      if (!st) {
        return undefined;
      }
      const a = new vscode.CodeAction(`Create staging model for ${st.source}.${st.table}`, vscode.CodeActionKind.QuickFix);
      a.command = { command: 'dbtCommander.createStaging', title: a.title, arguments: [{ data: { source: st.source, name: st.table }, root }] };
      return [a];
    }
    const out: vscode.CodeAction[] = [];
    const ask = (title: string, command: string, arg: unknown) => {
      const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      a.command = { command, title, arguments: [doc.uri, line, arg] };
      out.push(a);
    };
    const col = columnAt(doc.getText(), line);
    if (!col) {
      ask(`Profile column ${owner.column}`, 'dbtCommander.profileColumn', undefined);
      return out; // seeds / snapshots / sources: profile only
    }
    const add = (title: string, tests: TestSpec[]) => {
      const edit = testsEdit(doc, line, tests, this.deps);
      if (edit) {
        const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        a.edit = edit;
        out.push(a);
      }
    };
    if (testsEdit(doc, line, ['unique'], this.deps) && testsEdit(doc, line, ['not_null'], this.deps)) {
      add(`Add unique + not_null tests to ${col.column}`, ['unique', 'not_null']);
    }
    add(`Add not_null test to ${col.column}`, ['not_null']);
    add(`Add unique test to ${col.column}`, ['unique']);
    if (testsEdit(doc, line, [{ accepted_values: ['x'] }], this.deps)) {
      ask(`Add accepted_values test to ${col.column}…`, 'dbtCommander.addColumnTests', 'accepted_values');
    }
    if (testsEdit(doc, line, [{ test: 'relationships', args: {} }], this.deps)) {
      ask(`Add relationships test to ${col.column}…`, 'dbtCommander.addColumnTests', 'relationships');
    }
    if (await this.deps.hasPackage(root, 'dbt_utils')) {
      for (const t of ['dbt_utils.not_empty_string', 'dbt_utils.not_constant', 'dbt_utils.at_least_one']) {
        add(`Add ${t} test to ${col.column}`, [t]);
      }
      if (testsEdit(doc, line, [{ test: 'dbt_utils.accepted_range', args: {} }], this.deps)) {
        ask(`Add dbt_utils.accepted_range test to ${col.column}…`, 'dbtCommander.addColumnTests', 'accepted_range');
      }
    }
    ask(`Profile column ${col.column}`, 'dbtCommander.profileColumn', undefined);
    return out;
  }
}
