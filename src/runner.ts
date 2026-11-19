import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile, ChildProcess } from 'child_process';
import { executedNodeNames, parseDbtErrors } from './errors';

/** Kill a process and its children. On Windows dbt.exe is a launcher for python.exe, so kill the tree. */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } else {
    child.kill();
  }
}

/**
 * dbt problems tracked per dbt node, so running model B leaves model A's errors alone,
 * while re-running A (or its test) replaces A's.
 */
export class DbtDiagnostics implements vscode.Disposable {
  private readonly byNode = new Map<string, { file: string; diag: vscode.Diagnostic }[]>();

  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  update(output: string, cwd: string, executedNodes: string[]): void {
    for (const n of executedNodes) {
      this.byNode.delete(n);
    }
    const fresh = new Map<string, { file: string; diag: vscode.Diagnostic }[]>();
    for (const p of parseDbtErrors(output)) {
      const file = path.resolve(cwd, p.relPath.replace(/[\\/]/g, path.sep));
      const diag = new vscode.Diagnostic(
        new vscode.Range(p.line, 0, p.line, Number.MAX_SAFE_INTEGER),
        p.message,
        p.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
      );
      diag.source = 'dbt';
      fresh.set(p.node, [...(fresh.get(p.node) ?? []), { file, diag }]);
    }
    for (const [node, entries] of fresh) {
      this.byNode.set(node, entries);
    }
    this.render();
  }

  private render(): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const entries of this.byNode.values()) {
      for (const { file, diag } of entries) {
        byFile.set(file, [...(byFile.get(file) ?? []), diag]);
      }
    }
    this.collection.clear();
    for (const [file, diags] of byFile) {
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
      if (e.execution.task.definition.type === 'dbtRunner' && e.execution.task.definition.id === id) {
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
      open: () => {
        const started = Date.now();
        write.fire(`\x1b[2m> dbt ${opts.args.join(' ')}\x1b[0m\r\n\r\n`);
        child = spawn(opts.exe, opts.args, {
          cwd: opts.cwd,
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });
        const onData = (text: string) => {
          output += text;
          write.fire(text.replace(/\r?\n/g, '\r\n'));
        };
        child.stdout?.setEncoding('utf8').on('data', onData);
        child.stderr?.setEncoding('utf8').on('data', onData);
        child.on('error', err => settle(undefined, `\r\n\x1b[31mFailed to start dbt: ${err.message}\x1b[0m\r\n`));
        child.on('close', code => {
          if (settled) {
            return;
          }
          let executed: string[] = [];
          try {
            const rr = path.join(opts.targetDir, 'run_results.json');
            if (fs.statSync(rr).mtimeMs >= started - 1000) {
              executed = executedNodeNames(fs.readFileSync(rr, 'utf8'));
            }
          } catch {
            // no run_results.json (e.g. parse failure): only replace problems for nodes reported now
          }
          opts.diagnostics.update(output, opts.cwd, executed);
          settle(code ?? undefined, `\r\n\x1b[${code === 0 ? 32 : 31}m● dbt exited with code ${code}\x1b[0m\r\n`);
        });
      },
      close: () => {
        if (child) {
          killTree(child);
        }
        settled = true;
      }
    };
    return pty;
  });

  const task = new vscode.Task(
    { type: 'dbtRunner', title: opts.title, id },
    opts.folder ?? vscode.TaskScope.Workspace,
    opts.title,
    'dbt',
    execution
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true, panel: vscode.TaskPanelKind.Shared };
  await vscode.tasks.executeTask(task);
  return finished;
}
