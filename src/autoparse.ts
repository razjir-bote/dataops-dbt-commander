import * as vscode from 'vscode';
import * as path from 'path';
import { ChildProcess, execFile } from 'child_process';
import { killTree } from './runner';
import { ParseResult, ParseScheduler, dbtActivity, firstError, parseTrigger } from './autoparseCore';
import type { ProjectPaths } from './projectconfig';

export interface AutoParseDeps {
  projectRootOf(file: string): string | undefined;
  pathsOf(root: string): ProjectPaths;
  /** dbt, if it can run here now (trusted workspace, venv found); never prompts. */
  exe(): string | undefined;
  /** --target / extra args, as for other dbt commands. */
  flags(): string[];
}

const cfg = () => vscode.workspace.getConfiguration('dbtCommander');

/** A parse taking longer than this is stopped (and reported): it would hold every dbt command in the project. */
const PARSE_TIMEOUT_MS = 5 * 60 * 1000;
/** Before any file-system work: dbt's own output folders (default names) and tooling. */
const QUICK_SKIP = /[\\/](target|logs|dbt_packages|dbt_modules|\.git|node_modules|__pycache__)[\\/]/i;
/** A file dbt reads, or a name without an extension (a folder created / deleted). */
const QUICK_KEEP = /^[^.]+$|\.(sql|ya?ml|csv|md|py|jinja2?)$/i;

/**
 * Runs `dbt parse` in the background when files dbt reads change, so the manifest — and with it the sidebar,
 * Tests view, lineage and completion — keeps up. Never beside another dbt command in the same project.
 */
export class AutoParser implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly scheduler: ParseScheduler;
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  private readonly output = vscode.window.createOutputChannel('dbt Commander: auto-parse');
  private readonly running = new Set<string>();
  private readonly failed = new Map<string, string>();
  private readonly children = new Set<ChildProcess>();
  /** Parses started, for tests. */
  parses = 0;

  constructor(private readonly deps: AutoParseDeps) {
    this.scheduler = new ParseScheduler({
      debounceMs: 1500,
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: id => clearTimeout(id as NodeJS.Timeout),
      activity: dbtActivity,
      run: root => this.parse(root),
      onState: (root, s) => this.show(root, s)
    });
    this.scheduler.setEnabled(this.enabled());
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const on = (uri: vscode.Uri) => this.fileChanged(uri);
    this.item.command = 'dbtCommander.autoParseOutput';
    this.disposables.push(
      watcher,
      watcher.onDidCreate(on),
      watcher.onDidChange(on),
      watcher.onDidDelete(on),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('dbtCommander.autoParse')) {
          this.scheduler.setEnabled(this.enabled());
          if (!this.enabled()) {
            this.failed.clear();
            this.refreshItem();
          }
        }
      }),
      vscode.commands.registerCommand('dbtCommander.autoParseOutput', () => this.output.show(true)),
      this.item,
      this.output,
      { dispose: () => this.scheduler.dispose() },
      { dispose: () => this.children.forEach(c => killTree(c)) }
    );
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  get active(): boolean {
    return this.enabled();
  }

  /** The last auto-parse error for a project, while it stands. */
  failure(root: string): string | undefined {
    return this.scheduler.failure(root);
  }

  private enabled(): boolean {
    return cfg().get<boolean>('autoParse', true);
  }

  private fileChanged(uri: vscode.Uri): void {
    if (uri.scheme !== 'file' || !this.enabled() || !vscode.workspace.isTrusted) {
      return;
    }
    const file = uri.fsPath;
    // Cheap check first: dbt's own writes (target/, logs/, packages) arrive constantly during a run.
    if (QUICK_SKIP.test(file) || !QUICK_KEEP.test(path.basename(file))) {
      return;
    }
    const root = this.deps.projectRootOf(file);
    if (!root) {
      return;
    }
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (parseTrigger(rel, this.deps.pathsOf(root))) {
      this.scheduler.changed(root);
    }
  }

  private parse(root: string): Promise<ParseResult> {
    const exe = this.deps.exe();
    if (!exe) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    this.parses++;
    const args = ['parse', ...this.deps.flags()];
    return new Promise(resolve => {
      let child: ChildProcess | undefined;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child) {
          killTree(child); // a hung parse would hold every other dbt command in this project
        }
      }, PARSE_TIMEOUT_MS);
      const done = (r: ParseResult) => {
        clearTimeout(timer);
        if (child) {
          this.children.delete(child);
        }
        resolve(r);
      };
      try {
        child = execFile(exe, args, { cwd: root, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout, stderr) => {
          if (!err) {
            done({ ok: true });
            return;
          }
          const text = timedOut ? `dbt parse took longer than ${PARSE_TIMEOUT_MS / 1000}s and was stopped.\n${stdout}\n${stderr}` : `${stdout}\n${stderr}`.trim() || err.message;
          this.output.appendLine(`[${new Date().toLocaleTimeString()}] dbt ${args.join(' ')} in ${root} failed:`);
          this.output.appendLine(text);
          this.output.appendLine('');
          done({ ok: false, error: firstError(text) });
        });
        this.children.add(child);
      } catch (e) {
        done({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  private show(root: string, s: { running: boolean; failed?: string }): void {
    if (s.running) {
      this.running.add(root);
    } else {
      this.running.delete(root);
    }
    if (s.failed) {
      this.failed.set(root, s.failed);
    } else {
      this.failed.delete(root);
    }
    this.refreshItem();
  }

  private refreshItem(): void {
    if (this.running.size) {
      this.item.text = '$(sync~spin) dbt parse';
      this.item.tooltip = `Parsing ${[...this.running].map(r => path.basename(r)).join(', ')} in the background (dbtCommander.autoParse)`;
      this.item.backgroundColor = undefined;
      this.item.show();
    } else if (this.failed.size) {
      const [root, error] = [...this.failed][0];
      this.item.text = '$(warning) dbt parse failed';
      this.item.tooltip = `${path.basename(root)}: ${error}\nThe sidebar shows the project as last parsed. Click for dbt's output.`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.show();
    } else {
      this.item.hide();
    }
  }
}

