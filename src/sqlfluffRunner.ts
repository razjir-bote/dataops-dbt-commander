import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, execFile } from 'child_process';
import {
  CONFIG_FILES,
  LintViolation,
  configHasDialect,
  configSearchDirs,
  dialectFor,
  fixAccepted,
  fixArgs,
  fixedText,
  lintArgs,
  parseLintJson,
  sqlfluffExecutable
} from './sqlfluff';
import { splitArgs } from './dbt';
import { killTree } from './runner';

export interface SqlFluffDeps {
  projectRootOf(file: string): string | undefined;
  /** A dbt SQL file SQLFluff should look at (model / snapshot / analysis / macro / test folders). */
  isLintable(file: string): boolean;
  /** The project's dbt adapter (from the manifest), for the dialect when no SQLFluff config sets one. */
  adapterType(root: string): Promise<string | undefined>;
}

type Mode = 'off' | 'on' | 'auto';
type RunResult = { stdout: string; err?: { code?: number | string | null; killed?: boolean } };

const cfg = () => vscode.workspace.getConfiguration('dbtCommander');
const SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', language: 'sql' },
  { scheme: 'file', language: 'jinja-sql' },
  { scheme: 'file', pattern: '**/*.sql' }
];
/** VS Code drops a will-save participant's edits after 1.5 s (and ignores it after repeated misses). */
const WILL_SAVE_BUDGET_MS = 1200;
const MAX_PARALLEL = 2;
const LATE = Symbol('late');

/** SQLFluff's own user config folder (platformdirs `user_config_dir("sqlfluff", "sqlfluff")`). */
function userConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'sqlfluff', 'sqlfluff');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'sqlfluff');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'sqlfluff');
}

/**
 * Optional SQLFluff support (off by default): problems on open / save, fix on save, Format Document and two
 * commands, using the SQLFluff in the dbt venv. With `dbtCommander.sqlfluff.enabled` = off, no formatter is
 * registered and SQLFluff is never started.
 */
export class SqlFluff implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('sqlfluff');
  private readonly disposables: vscode.Disposable[] = [this.diagnostics];
  private formatter: vscode.Disposable | undefined;
  /** Monotonic: never reset, so a run from before Off → On can't pass for a current one. */
  private counter = 0;
  private readonly latest = new Map<string, number>();
  /** Per file: one lint running, at most one more waiting. */
  private readonly running = new Set<string>();
  private readonly pending = new Map<string, vscode.TextDocument>();
  private slots = MAX_PARALLEL;
  private readonly waiting: (() => void)[] = [];
  private readonly children = new Set<ChildProcess>();
  private readonly resaving = new Set<string>();
  private readonly configCache = new Map<string, { mtime: number; has: boolean }>();
  private warnedMissing = false;
  private wasActive = false;
  private updateTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: SqlFluffDeps) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(d => this.queueLint(d)),
      vscode.workspace.onDidSaveTextDocument(d => this.queueLint(d)),
      vscode.workspace.onDidCloseTextDocument(d => {
        this.diagnostics.delete(d.uri);
        this.pending.delete(d.uri.toString());
      }),
      vscode.workspace.onWillSaveTextDocument(e => this.onWillSave(e)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('dbtCommander.sqlfluff') || e.affectsConfiguration('dbtCommander.venvPath')) {
          this.warnedMissing = false;
          this.configCache.clear();
          this.scheduleUpdate(); // one Save in the settings page changes several keys at once
        }
      }),
      // SQLFluff pip-installed / removed while VS Code runs: catch up when the window gets focus back.
      vscode.window.onDidChangeWindowState(s => s.focused && this.active !== this.wasActive && this.update()),
      vscode.commands.registerCommand('dbtCommander.sqlfluff.lint', () => this.lintCommand()),
      vscode.commands.registerCommand('dbtCommander.sqlfluff.fix', () => this.fixCommand())
    );
    this.update();
  }

  private mode(): Mode {
    const m = cfg().get<string>('sqlfluff.enabled', 'off');
    return m === 'on' || m === 'auto' ? m : 'off';
  }

  /** The SQLFluff executable when linting is on and SQLFluff is installed in the venv. */
  exe(): string | undefined {
    return this.mode() === 'off' ? undefined : sqlfluffExecutable(cfg().get<string>('venvPath', ''), p => fs.existsSync(p));
  }

  get active(): boolean {
    return !!this.exe();
  }

  private applies(doc: vscode.TextDocument): boolean {
    return this.active && doc.uri.scheme === 'file' && /\.sql$/i.test(doc.fileName) && this.deps.isLintable(doc.uri.fsPath);
  }

  private scheduleUpdate(): void {
    clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => this.update(), 300);
  }

  /** Apply the current settings: register or drop the formatter, lint open files or stop everything. */
  update(): void {
    const exe = this.exe();
    this.wasActive = !!exe;
    void vscode.commands.executeCommand('setContext', 'dbtCommander.sqlfluffActive', !!exe);
    if (!exe) {
      this.formatter?.dispose();
      this.formatter = undefined;
      this.diagnostics.clear();
      this.pending.clear();
      this.children.forEach(c => killTree(c));
      if (this.mode() === 'on' && !this.warnedMissing) {
        this.warnedMissing = true;
        void vscode.window.showWarningMessage(
          'dbt Commander: SQLFluff linting is on, but SQLFluff is not installed in the dbt venv (pip install sqlfluff).'
        );
      }
      return;
    }
    this.formatter ??= vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, {
      provideDocumentFormattingEdits: async doc => (this.applies(doc) ? (await this.fix(doc)).edits : [])
    });
    vscode.workspace.textDocuments.forEach(d => this.queueLint(d));
  }

  // ---------- running SQLFluff ----------

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.slots === 0) {
      await new Promise<void>(resolve => this.waiting.push(resolve));
    } else {
      this.slots--;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next(); // hand the slot straight over
      } else {
        this.slots++;
      }
    }
  }

  /** Whether a config file in `dir` sets the dialect (cached by mtime). */
  private async dirSetsDialect(dir: string): Promise<boolean> {
    for (const name of CONFIG_FILES) {
      const file = path.join(dir, name);
      let mtime: number;
      try {
        mtime = (await fs.promises.stat(file)).mtimeMs;
      } catch {
        continue;
      }
      let hit = this.configCache.get(file);
      if (!hit || hit.mtime !== mtime) {
        let text = '';
        try {
          text = await fs.promises.readFile(file, 'utf8');
        } catch {
          // unreadable: treat as no dialect
        }
        hit = { mtime, has: configHasDialect(name, text) };
        this.configCache.set(file, hit);
      }
      if (hit.has) {
        return true;
      }
    }
    return false;
  }

  /**
   * `--dialect` to pass: the setting; else nothing when any config SQLFluff reads for this file sets one (it would
   * be overridden); else the dbt adapter's dialect.
   */
  private async dialect(file: string, root: string): Promise<string | undefined> {
    const set = cfg().get<string>('sqlfluff.dialect', '').trim();
    if (set) {
      return set;
    }
    for (const dir of configSearchDirs(file, os.homedir(), userConfigDir())) {
      if (await this.dirSetsDialect(dir)) {
        return undefined;
      }
    }
    return dialectFor(await this.deps.adapterType(root));
  }

  /** Run SQLFluff with `text` on stdin, as `file`. */
  private async run(file: string, text: string, args: (file: string, dialect: string | undefined, extra: string[]) => string[]): Promise<RunResult | undefined> {
    const exe = this.exe();
    const root = this.deps.projectRootOf(file);
    if (!exe || !root) {
      return undefined;
    }
    const argv = args(file, await this.dialect(file, root), splitArgs(cfg().get<string>('sqlfluff.extraArgs', '')));
    return this.slot(
      () =>
        new Promise<RunResult>(resolve => {
          const child = execFile(
            exe,
            argv,
            // UTF-8: SQLFluff prints non-ASCII (and emoji) that the Windows code page can't encode.
            { cwd: root, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
            (err, stdout) => {
              this.children.delete(child);
              resolve({ stdout, ...(err ? { err: { code: (err as any).code, killed: err.killed } } : {}) });
            }
          );
          this.children.add(child);
          child.stdin?.on('error', () => undefined); // SQLFluff exited before reading everything
          child.stdin?.end(text, 'utf8');
        })
    );
  }

  // ---------- lint ----------

  /** Lint soon: one run per file at a time; edits made meanwhile get one more run afterwards. */
  queueLint(doc: vscode.TextDocument): void {
    if (!this.applies(doc)) {
      return;
    }
    const key = doc.uri.toString();
    if (this.running.has(key)) {
      this.pending.set(key, doc);
      return;
    }
    this.running.add(key);
    void this.lint(doc).finally(() => {
      this.running.delete(key);
      const next = this.pending.get(key);
      this.pending.delete(key);
      if (next && !next.isClosed) {
        this.queueLint(next);
      }
    });
  }

  /**
   * Lint one document and show its problems. Undefined: SQLFluff gave no usable result; null: superseded by a
   * newer run, the text changed meanwhile, or linting was turned off.
   */
  async lint(doc: vscode.TextDocument): Promise<LintViolation[] | undefined | null> {
    if (!this.applies(doc)) {
      return undefined;
    }
    const key = doc.uri.toString();
    const id = ++this.counter;
    this.latest.set(key, id);
    const version = doc.version;
    const result = await this.run(doc.uri.fsPath, doc.getText(), lintArgs);
    if (this.latest.get(key) !== id || !this.active || doc.isClosed) {
      return null;
    }
    if (doc.version !== version) {
      this.pending.set(key, doc); // positions would be off: lint the new text instead
      return null;
    }
    const violations = result && parseLintJson(result.stdout);
    if (!violations) {
      this.diagnostics.delete(doc.uri); // SQLFluff failed: don't keep stale problems
      return undefined;
    }
    this.diagnostics.set(
      doc.uri,
      violations.map(v => {
        const range = new vscode.Range(v.line, v.col, v.endLine, Math.max(v.endCol, v.endLine === v.line ? v.col + 1 : v.endCol));
        const d = new vscode.Diagnostic(range, v.message, vscode.DiagnosticSeverity.Warning);
        d.source = 'sqlfluff';
        d.code = v.rule ? `${v.code} (${v.rule})` : v.code;
        return d;
      })
    );
    return violations;
  }

  // ---------- fix ----------

  /** SQLFluff's fix of the document as one edit (empty: nothing to change, failed, or the text changed meanwhile). */
  private async fix(doc: vscode.TextDocument): Promise<{ edits: vscode.TextEdit[]; version: number; changedMeanwhile: boolean }> {
    const before = doc.getText();
    const version = doc.version;
    const result = await this.run(doc.uri.fsPath, before, fixArgs);
    const changedMeanwhile = doc.version !== version;
    const after =
      result && fixAccepted(result.err) && !changedMeanwhile
        ? fixedText(result.stdout, before, doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n')
        : undefined;
    return {
      edits: after ? [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)), after)] : [],
      version,
      changedMeanwhile
    };
  }

  /**
   * Fix on save (manual saves only — an auto-save after a delay would rewrite the text while you type). Within
   * VS Code's will-save budget the fix goes into this save; a slower fix (big file, dbt templater) is applied right
   * after the save and saved again, unless you edited the file meanwhile.
   */
  private onWillSave(e: vscode.TextDocumentWillSaveEvent): void {
    const doc = e.document;
    const key = doc.uri.toString();
    if (this.resaving.has(key) || e.reason !== vscode.TextDocumentSaveReason.Manual || !cfg().get<boolean>('sqlfluff.fixOnSave', false) || !this.applies(doc)) {
      return;
    }
    const pending = this.fix(doc);
    const budget = new Promise<typeof LATE>(resolve => setTimeout(() => resolve(LATE), WILL_SAVE_BUDGET_MS));
    e.waitUntil(
      Promise.race([pending, budget]).then(r => {
        if (r !== LATE) {
          return r.edits;
        }
        void this.applyLate(doc, pending);
        return [];
      })
    );
  }

  private async applyLate(doc: vscode.TextDocument, pending: ReturnType<SqlFluff['fix']>): Promise<void> {
    const { edits, version } = await pending;
    if (!edits.length || doc.isClosed || doc.version !== version) {
      return;
    }
    const key = doc.uri.toString();
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, edits);
    if (!(await vscode.workspace.applyEdit(edit)) || doc.version !== version + 1) {
      return;
    }
    this.resaving.add(key);
    try {
      await doc.save();
    } finally {
      this.resaving.delete(key);
    }
  }

  // ---------- commands ----------

  private activeDoc(): vscode.TextDocument | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    if (!this.active) {
      void vscode.window.showInformationMessage('dbt Commander: SQLFluff linting is off (turn it on in dbt Commander settings).');
      return undefined;
    }
    if (!doc || !this.applies(doc)) {
      void vscode.window.showInformationMessage('dbt Commander: open a dbt SQL file (model, snapshot, analysis, macro or test).');
      return undefined;
    }
    return doc;
  }

  private async lintCommand(): Promise<LintViolation[] | undefined | null> {
    const doc = this.activeDoc();
    const result = doc && (await this.lint(doc));
    if (doc && result === undefined) {
      void vscode.window.showWarningMessage('dbt Commander: SQLFluff did not return results for this file. Run it in a terminal to see why.');
    } else if (result) {
      void vscode.window.setStatusBarMessage(`SQLFluff: ${result.length} problem${result.length === 1 ? '' : 's'}`, 4000);
    }
    return result;
  }

  /** Fix the active file now (one undo step). */
  async fixCommand(): Promise<boolean> {
    const doc = this.activeDoc();
    if (!doc) {
      return false;
    }
    const { edits, changedMeanwhile } = await this.fix(doc);
    if (!edits.length) {
      void vscode.window.setStatusBarMessage(changedMeanwhile ? 'SQLFluff: the file changed while fixing — run it again' : 'SQLFluff: nothing to fix', 4000);
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, edits);
    return vscode.workspace.applyEdit(edit);
  }

  dispose(): void {
    clearTimeout(this.updateTimer);
    this.children.forEach(c => killTree(c));
    this.formatter?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
