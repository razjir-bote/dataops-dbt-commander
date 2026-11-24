import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, execFile } from 'child_process';
import {
  CONFIG_FILES_BY_PRIORITY,
  LintViolation,
  configCore,
  configSearchDirs,
  dialectFor,
  fixAccepted,
  fixArgs,
  fixCopy,
  fixPathArgs,
  fixedText,
  lintArgs,
  lintPathArgs,
  parseLintJson,
  parseSqlfluffVersion,
  refusesStdin,
  sqlfluffExecutable,
  templaterArg
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
type RunResult = { stdout: string; stderr: string; err?: { code?: number | string | null; killed?: boolean } };
type Core = ReturnType<typeof configCore>;
type FixResult = {
  edits: vscode.TextEdit[];
  version: number;
  changedMeanwhile: boolean;
  /** Path mode (dbt templater) with unsaved edits: SQLFluff reads the saved file, so save first. */
  needsSave?: boolean;
};
const SAVE_FIRST = 'dbt Commander: save the file first. With the dbt templater, SQLFluff reads the saved file.';

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
  /** Saves whose fix runs once the save is on disk (path mode): document → its version at will-save. */
  private readonly fixAfterSave = new Map<string, number>();
  /**
   * Path mode Format Document on unsaved edits: a save right after it was Format on Save (fix once the save is on
   * disk); with no save, the "save first" message shows after a moment.
   */
  private readonly formatPending = new Map<string, NodeJS.Timeout>();
  /** SQLFluff's major version per executable (2.x's `fix <path>` asks before fixing unless -f). */
  private readonly majors = new Map<string, Promise<number | undefined>>();
  /** Files whose SQLFluff refused stdin (dbt templater set somewhere we don't read): path mode from then on. */
  private readonly refusedStdin = new Set<string>();
  private readonly configCache = new Map<string, { mtime: number; core: Core }>();
  private warnedMissing = false;
  private wasActive = false;
  private updateTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: SqlFluffDeps) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(d => this.queueLint(d)),
      vscode.workspace.onDidSaveTextDocument(d => this.onDidSave(d)),
      vscode.workspace.onDidCloseTextDocument(d => {
        this.diagnostics.delete(d.uri);
        this.pending.delete(d.uri.toString());
        this.fixAfterSave.delete(d.uri.toString());
      }),
      vscode.workspace.onWillSaveTextDocument(e => this.onWillSave(e)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('dbtCommander.sqlfluff') || e.affectsConfiguration('dbtCommander.venvPath')) {
          this.warnedMissing = false;
          this.configCache.clear();
          this.refusedStdin.clear();
          this.majors.clear(); // a venv change, or SQLFluff upgraded and the setting saved again
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
      provideDocumentFormattingEdits: async doc => {
        if (!this.applies(doc) || this.resaving.has(doc.uri.toString())) {
          return []; // the re-save after a fix: Format on Save would only fix the fix again
        }
        const r = await this.fix(doc);
        if (r.needsSave) {
          const key = doc.uri.toString();
          clearTimeout(this.formatPending.get(key));
          this.formatPending.set(
            key,
            setTimeout(() => {
              this.formatPending.delete(key);
              void vscode.window.showInformationMessage(SAVE_FIRST);
            }, 2000)
          );
        }
        return r.edits;
      }
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

  /** The core-section settings of one config file (cached by mtime); undefined when there is no such file. */
  private async configFile(file: string, name: string): Promise<Core | undefined> {
    let mtime: number;
    try {
      mtime = (await fs.promises.stat(file)).mtimeMs;
    } catch {
      return undefined;
    }
    let hit = this.configCache.get(file);
    if (!hit || hit.mtime !== mtime) {
      let text = '';
      try {
        text = await fs.promises.readFile(file, 'utf8');
      } catch {
        // unreadable: treat as setting nothing
      }
      hit = { mtime, core: configCore(name, text) };
      this.configCache.set(file, hit);
    }
    return hit.core;
  }

  /** The config files SQLFluff reads for `file`, the one whose settings win first. */
  private async configs(file: string): Promise<Core[]> {
    const out: Core[] = [];
    for (const dir of configSearchDirs(file, os.homedir(), userConfigDir())) {
      for (const name of CONFIG_FILES_BY_PRIORITY) {
        const core = await this.configFile(path.join(dir, name), name);
        if (core) {
          out.push(core);
        }
      }
    }
    return out;
  }

  private extraArgs(): string[] {
    return splitArgs(cfg().get<string>('sqlfluff.extraArgs', ''));
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
    if ((await this.configs(file)).some(c => c.dialect)) {
      return undefined;
    }
    return dialectFor(await this.deps.adapterType(root));
  }

  /**
   * Path mode: SQLFluff reads the saved file instead of the editor text on stdin, because the dbt templater
   * refuses stdin. On when `--templater` in the extra flags, else the nearest config setting `templater`, is dbt,
   * or when SQLFluff already refused stdin for this file.
   */
  async pathMode(file: string): Promise<boolean> {
    if (this.refusedStdin.has(file.toLowerCase())) {
      return true;
    }
    const templater = templaterArg(this.extraArgs()) ?? (await this.configs(file)).find(c => c.templater)?.templater;
    return templater === 'dbt';
  }

  /** Run SQLFluff for `file`; `input` goes to stdin (none in path mode). */
  private async run(file: string, build: (dialect: string | undefined, extra: string[]) => string[], input?: string): Promise<RunResult | undefined> {
    const exe = this.exe();
    const root = this.deps.projectRootOf(file);
    if (!exe || !root) {
      return undefined;
    }
    const argv = build(await this.dialect(file, root), this.extraArgs());
    return this.slot(
      () =>
        new Promise<RunResult>(resolve => {
          const child = execFile(
            exe,
            argv,
            // UTF-8: SQLFluff prints non-ASCII (and emoji) that the Windows code page can't encode.
            { cwd: root, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
            (err, stdout, stderr) => {
              this.children.delete(child);
              resolve({ stdout, stderr: String(stderr ?? ''), ...(err ? { err: { code: (err as any).code, killed: err.killed } } : {}) });
            }
          );
          this.children.add(child);
          child.stdin?.on('error', () => undefined); // SQLFluff exited before reading everything
          child.stdin?.end(input ?? '', 'utf8');
        })
    );
  }

  /** SQLFluff's major version (`sqlfluff --version`, once per executable); undefined when it can't be read. */
  private major(): Promise<number | undefined> {
    const exe = this.exe();
    if (!exe) {
      return Promise.resolve(undefined);
    }
    let hit = this.majors.get(exe);
    if (!hit) {
      hit = new Promise(resolve =>
        execFile(exe, ['--version'], { timeout: 30_000, windowsHide: true }, (err, stdout) => {
          const v = err ? undefined : parseSqlfluffVersion(String(stdout));
          resolve(v ? Number(v.split('.')[0]) : undefined);
        })
      );
      this.majors.set(exe, hit);
    }
    return hit;
  }

  /** A stdin run SQLFluff refused (dbt templater): remember it, so this file uses path mode from now on. */
  private refused(file: string, result: RunResult | undefined): boolean {
    // stderr only, and only a failed run: `fix -` prints the user's SQL on stdout, which could hold the phrase.
    if (result?.err && refusesStdin(result.stderr)) {
      this.refusedStdin.add(file.toLowerCase());
      return true;
    }
    return false;
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
    const file = doc.uri.fsPath;
    let result: RunResult | undefined;
    if (!(await this.pathMode(file))) {
      result = await this.run(file, (d, x) => lintArgs(file, d, x), doc.getText());
    }
    if (!result || this.refused(file, result)) {
      if (doc.isDirty) {
        return null; // path mode lints the saved file: the next save lints these edits
      }
      result = await this.run(file, (d, x) => lintPathArgs(file, d, x));
    }
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
  private async fix(doc: vscode.TextDocument): Promise<FixResult> {
    const before = doc.getText();
    const version = doc.version;
    const file = doc.uri.fsPath;
    if (await this.pathMode(file)) {
      return this.fixPath(doc);
    }
    const result = await this.run(file, (d, x) => fixArgs(file, d, x), before);
    if (this.refused(file, result)) {
      return this.fixPath(doc);
    }
    const changedMeanwhile = doc.version !== version;
    const after = result && fixAccepted(result.err) && !changedMeanwhile ? fixedText(result.stdout, before, this.eol(doc)) : undefined;
    return { edits: this.replaceAll(doc, before, after), version, changedMeanwhile };
  }

  private eol(doc: vscode.TextDocument): '\n' | '\r\n' {
    return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  }

  private replaceAll(doc: vscode.TextDocument, before: string, after: string | undefined): vscode.TextEdit[] {
    return after ? [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)), after)] : [];
  }

  /**
   * Path mode fix: SQLFluff fixes the saved file and writes the result to a copy beside it (the file itself is
   * left alone); the copy's text comes back as one edit and the copy is deleted.
   */
  private async fixPath(doc: vscode.TextDocument): Promise<FixResult> {
    const before = doc.getText();
    const version = doc.version;
    if (doc.isDirty) {
      return { edits: [], version, changedMeanwhile: false, needsSave: true };
    }
    const file = doc.uri.fsPath;
    const { suffix, copy } = fixCopy(file, `${process.pid}-${++this.counter}`);
    let fixed: string | undefined;
    let result: RunResult | undefined;
    try {
      const major = await this.major();
      result = await this.run(file, (d, x) => fixPathArgs(file, suffix, d, x, major !== undefined && major < 3));
      try {
        fixed = (await fs.promises.readFile(copy, 'utf8')).replace(/^﻿/, ''); // no copy: nothing to fix
      } catch {
        fixed = undefined;
      }
    } finally {
      await fs.promises.rm(copy, { force: true }).catch(() => undefined);
    }
    const changedMeanwhile = doc.version !== version || doc.isDirty;
    const after = result && fixAccepted(result.err) && fixed !== undefined && !changedMeanwhile ? fixedText(fixed, before, this.eol(doc)) : undefined;
    return { edits: this.replaceAll(doc, before, after), version, changedMeanwhile };
  }

  /**
   * Fix on save (manual saves only — an auto-save after a delay would rewrite the text while you type). Within
   * VS Code's will-save budget the fix goes into this save; a slower fix (big file, dbt templater) is applied right
   * after the save and saved again, unless you edited the file meanwhile.
   */
  private onWillSave(e: vscode.TextDocumentWillSaveEvent): void {
    const doc = e.document;
    const key = doc.uri.toString();
    if (this.resaving.has(key)) {
      return;
    }
    this.fixAfterSave.delete(key); // left from a save that never completed
    if (e.reason !== vscode.TextDocumentSaveReason.Manual || !cfg().get<boolean>('sqlfluff.fixOnSave', false) || !this.applies(doc)) {
      return;
    }
    const pending = this.fix(doc);
    const budget = new Promise<typeof LATE>(resolve => setTimeout(() => resolve(LATE), WILL_SAVE_BUDGET_MS));
    e.waitUntil(
      Promise.race([pending, budget]).then(r => {
        if (r === LATE) {
          void this.applyLate(doc, pending);
          return [];
        }
        if (r.needsSave) {
          this.fixAfterSave.set(key, r.version); // path mode: fix the file once this save is on disk
        }
        return r.edits;
      })
    );
  }

  private onDidSave(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    if (this.resaving.has(key)) {
      return;
    }
    const formatOnSave = this.formatPending.get(key);
    if (formatOnSave) {
      clearTimeout(formatOnSave);
      this.formatPending.delete(key);
    }
    const marked = this.fixAfterSave.get(key);
    this.fixAfterSave.delete(key);
    if ((formatOnSave || marked === doc.version) && this.applies(doc)) {
      // Lint after the fix: its re-save lints, or (nothing to fix) lint now. Two dbt templater runs at once are slow.
      void this.applyLate(doc, this.fix(doc)).then(saved => saved || this.queueLint(doc));
      return;
    }
    this.queueLint(doc);
  }

  /** Apply a fix that missed the will-save budget and save again. True when it did. */
  private async applyLate(doc: vscode.TextDocument, pending: Promise<FixResult>): Promise<boolean> {
    let r = await pending;
    if (r.needsSave) {
      // Path mode found out late (SQLFluff refused stdin): fix the saved file once the save is done.
      if (doc.isClosed || doc.version !== r.version) {
        return false;
      }
      if (doc.isDirty) {
        this.fixAfterSave.set(doc.uri.toString(), r.version); // the save is still writing: onDidSave fixes
        return false;
      }
      r = await this.fix(doc);
    }
    const { edits, version } = r;
    if (!edits.length || doc.isClosed || doc.version !== version) {
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, edits);
    if (!(await vscode.workspace.applyEdit(edit)) || doc.version !== version + 1) {
      return false;
    }
    await this.saveQuietly(doc);
    this.queueLint(doc);
    return true;
  }

  /** Save without fix on save or the lint a save starts (the caller runs what it needs). */
  private async saveQuietly(doc: vscode.TextDocument): Promise<boolean> {
    const key = doc.uri.toString();
    this.resaving.add(key);
    try {
      return await doc.save();
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

  /** Path mode reads the saved file: the commands save unsaved edits first. False when that save failed. */
  private async savedForPathMode(doc: vscode.TextDocument): Promise<boolean> {
    if (!doc.isDirty || !(await this.pathMode(doc.uri.fsPath))) {
      return true;
    }
    if (await this.saveQuietly(doc)) {
      return true;
    }
    void vscode.window.showWarningMessage(SAVE_FIRST);
    return false;
  }

  private async lintCommand(): Promise<LintViolation[] | undefined | null> {
    const doc = this.activeDoc();
    if (doc && !(await this.savedForPathMode(doc))) {
      return null;
    }
    let result = doc && (await this.lint(doc));
    if (doc && result === null && doc.isDirty && (await this.pathMode(doc.uri.fsPath))) {
      // SQLFluff refused stdin just now: path mode from here on, so save and lint the saved file.
      if (!(await this.savedForPathMode(doc))) {
        return null;
      }
      result = await this.lint(doc);
    }
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
    if (!doc || !(await this.savedForPathMode(doc))) {
      return false;
    }
    let r = await this.fix(doc);
    if (r.needsSave) {
      // SQLFluff refused stdin just now: path mode from here on, so save and fix the saved file.
      if (!(await this.savedForPathMode(doc))) {
        return false;
      }
      r = await this.fix(doc);
    }
    const { edits, changedMeanwhile } = r;
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
    this.formatPending.forEach(t => clearTimeout(t));
    this.children.forEach(c => killTree(c));
    this.formatter?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
