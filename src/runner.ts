import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile, ChildProcess } from 'child_process';
import { ProblemStore, executedNodes, parseDbtErrors } from './errors';
import { invocationOf } from './runresults';
import { runSummary } from './runstate';
import { PROCESS_LIST_PS, descendants, parseProcessList } from './proctree';
import { dbtActivity } from './autoparseCore';

/** Kill a process and its children. On Windows dbt.exe is a launcher for python.exe, so kill the tree. */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  if (process.platform !== 'win32') {
    child.kill();
    return;
  }
  // Not `taskkill /T`: it follows parent ids, and Windows reuses ids, so an unrelated older process can look
  // like a child. List processes ourselves, keep only real descendants (created after their parent), and kill
  // exactly those ids.
  const root = child.pid;
  execFile(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', PROCESS_LIST_PS],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout) => {
      const pids = err ? [root] : [root, ...descendants(parseProcessList(stdout), root)];
      execFile('taskkill', ['/F', ...pids.flatMap(p => ['/PID', String(p)])], { windowsHide: true }, () => undefined);
    }
  );
}

/** Where a problem's file is: `pkg` is the node's package when known (from run_results.json). */
export type LocateProblem = (root: string, pkg: string | undefined, relPath: string) => string;

/**
 * dbt problems tracked per dbt node and project, so running model B leaves model A's errors alone,
 * while re-running A (or its test) replaces A's.
 */
export class DbtDiagnostics implements vscode.Disposable {
  private readonly store = new ProblemStore<vscode.Diagnostic>();

  constructor(
    private readonly collection: vscode.DiagnosticCollection,
    private readonly locate: LocateProblem = (root, _pkg, rel) => path.resolve(root, rel.replace(/[\\/]/g, path.sep))
  ) {}

  /**
   * Problems from dbt's console output. `runResultsJson` (this invocation's, if it wrote one) says which nodes ran —
   * their old problems go — and which package each belongs to: errors in an installed package's nodes point into
   * its folder, not the project's.
   */
  update(output: string, cwd: string, runResultsJson?: string): void {
    const nodes = runResultsJson ? executedNodes(runResultsJson) : [];
    const pkgOf = new Map(nodes.map(n => [n.name, n.package]));
    const fresh: { node: string; file: string; item: vscode.Diagnostic }[] = [];
    for (const p of parseDbtErrors(output)) {
      const file = this.locate(cwd, pkgOf.get(p.node), p.relPath);
      const diag = new vscode.Diagnostic(
        new vscode.Range(p.line, 0, p.line, Number.MAX_SAFE_INTEGER),
        p.message,
        p.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
      );
      diag.source = 'dbt';
      fresh.push({ node: p.node, file, item: diag });
    }
    this.store.update(cwd, nodes.map(n => n.name), fresh);
    this.render();
  }

  private render(): void {
    this.collection.clear();
    for (const [file, diags] of this.store.byFile()) {
      this.collection.set(vscode.Uri.file(file), diags);
    }
  }

  dispose(): void {
    this.collection.dispose();
  }
}

export interface RunOptions {
  exe: string;
  args: string[];
  cwd: string;
  title: string;
  diagnostics: DbtDiagnostics;
  /** dbt target directory (absolute), used to read run_results.json after the run. */
  targetDir: string;
  folder?: vscode.WorkspaceFolder;
}

let taskSeq = 0;

/**
 * Run dbt as a VS Code task whose terminal shows dbt's own (coloured) output.
 * Resolves with dbt's exit code once it finishes (undefined if it could not start or was stopped).
 */
export async function runDbtTask(opts: RunOptions): Promise<number | undefined> {
  const id = ++taskSeq;
  let exitCode: number | undefined;
  // Resolve only once VS Code itself reports the task ended, so an immediate re-run
  // never collides with a task VS Code still considers active.
  const finished = new Promise<number | undefined>(resolve => {
    const sub = vscode.tasks.onDidEndTask(e => {
      if (e.execution.task.definition.type === 'dbtCommander' && e.execution.task.definition.id === id) {
        sub.dispose();
        resolve(exitCode);
      }
    });
  });

  const execution = new vscode.CustomExecution(async () => {
    const write = new vscode.EventEmitter<string>();
    const close = new vscode.EventEmitter<number>();
    let child: ChildProcess | undefined;
    let output = '';
    let settled = false;
    const settle = (code: number | undefined, message: string) => {
      if (settled) {
        return;
      }
      settled = true;
      exitCode = code;
      write.fire(message);
      close.fire(code ?? 1);
    };

    const pty: vscode.Pseudoterminal = {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: () => void start(),
      close: () => {
        if (child) {
          killTree(child);
        }
        settled = true; // the process's own close event ends its activity (it may take a moment to die)
      }
    };
    let endActivity: ((code?: number) => void) | undefined;
    // A background dbt parse (auto-parse) writes target/ too: wait for it, never run beside it.
    const start = async () => {
        if (dbtActivity.busy(opts.cwd, 'auto')) {
          write.fire('\x1b[2mWaiting for the background dbt parse to finish…\x1b[0m\r\n');
          await dbtActivity.whenIdle(opts.cwd, 'auto');
        }
        if (settled) {
          return; // closed while waiting
        }
        const started = Date.now();
        const rrFile = path.join(opts.targetDir, 'run_results.json');
        const previousInvocation = invocationIn(rrFile);
        write.fire(`\x1b[2m> dbt ${opts.args.join(' ')}\x1b[0m\r\n\r\n`);
        endActivity = dbtActivity.begin(opts.cwd, 'user', opts.args);
        try {
          child = spawn(opts.exe, opts.args, {
            cwd: opts.cwd,
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
          });
        } catch (e) {
          endActivity();
          settle(undefined, `\r\n\x1b[31mFailed to start dbt: ${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`);
          return;
        }
        const onData = (text: string) => {
          output += text;
          write.fire(text.replace(/\r?\n/g, '\r\n'));
        };
        child.stdout?.setEncoding('utf8').on('data', onData);
        child.stderr?.setEncoding('utf8').on('data', onData);
        child.on('error', err => {
          endActivity?.();
          settle(undefined, `\r\n\x1b[31mFailed to start dbt: ${err.message}\x1b[0m\r\n`);
        });
        child.on('close', code => {
          endActivity?.(code ?? undefined);
          if (settled) {
            return;
          }
          // run_results.json from this invocation only (not one left by an earlier or concurrent dbt command);
          // none means dbt failed early (e.g. parse error): only replace problems for nodes reported now.
          let json: string | undefined;
          try {
            const text = fs.readFileSync(rrFile, 'utf8');
            json = invocationOf(text) !== previousInvocation ? text : undefined;
          } catch {
            json = undefined;
          }
          opts.diagnostics.update(output, opts.cwd, json);
          settle(code ?? undefined, `\r\n\x1b[${code === 0 ? 32 : 31}m● dbt exited with code ${code}\x1b[0m\r\n`);
          void notifyIfLong(opts, Date.now() - started, code ?? undefined, json);
        });
    };
    return pty;
  });

  const task = new vscode.Task(
    { type: 'dbtCommander', title: opts.title, id },
    opts.folder ?? vscode.TaskScope.Workspace,
    opts.title,
    'dbt',
    execution
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true, panel: vscode.TaskPanelKind.Shared };
  lastRun = opts;
  await vscode.tasks.executeTask(task);
  return finished;
}

let lastRun: RunOptions | undefined;

/** The last dbt command started through the terminal runner (for "Rerun last command"). */
export function lastRunOptions(): RunOptions | undefined {
  return lastRun;
}

function invocationIn(file: string): string | undefined {
  try {
    return invocationOf(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** A notification for runs longer than `dbtCommander.notifyAfterSeconds`, with Retry when something failed. */
async function notifyIfLong(opts: RunOptions, ms: number, code: number | undefined, json: string | undefined): Promise<void> {
  const threshold = vscode.workspace.getConfiguration('dbtCommander').get<number>('notifyAfterSeconds', 30);
  if (!threshold || ms < threshold * 1000 || code === undefined) {
    return;
  }
  const summary = json ? runSummary(json) : undefined;
  const failed = code !== 0 || (summary?.errors ?? 0) > 0;
  const text = summary?.text ?? `dbt ${opts.args[0]} finished with exit code ${code} (${Math.round(ms / 1000)}s)`;
  const buttons = [...(failed && summary ? ['Retry'] : []), 'Show results'];
  const pick = await (failed ? vscode.window.showWarningMessage(text, ...buttons) : vscode.window.showInformationMessage(text, ...buttons));
  if (pick === 'Retry') {
    await vscode.commands.executeCommand('dbtCommander.retry', opts.cwd); // retry *this* run's project
  } else if (pick === 'Show results') {
    await vscode.commands.executeCommand('dbtCommander.lastRun.focus');
  }
}
