import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { LanguageDeps, loadManifest } from './language';
import { NodeEntry } from './manifest';
import { executedNodeNames } from './errors';
import { DbtDiagnostics, killTree } from './runner';
import { RunResult, acceptResults, batchSelectors, invocationOf, testLine } from './runresults';
import { modelSelector } from './dbt';

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export interface TestingDeps {
  language: LanguageDeps;
  projectRoots(): Promise<string[]>;
  requireExe(): Promise<string | undefined>;
  /** `--target` and extra flags. */
  flags(): string[];
  diagnostics: DbtDiagnostics;
}

export type Outcome = { state: 'passed' | 'failed' | 'skipped' | 'errored'; message?: string };

interface TestData {
  root: string;
  test: NodeEntry;
}

/** dbt tests in VS Code's Testing panel: project → model / source / singular group → test. */
export class DbtTests implements vscode.Disposable {
  readonly controller = vscode.tests.createTestController('dbtCommander.tests', 'dbt');
  private data = new Map<string, TestData>(); // test item id → test
  private projects = new Map<string, string>(); // project item id → root
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: TestingDeps) {
    this.controller.resolveHandler = async item => {
      if (!item) {
        await this.refresh();
      }
    };
    this.controller.refreshHandler = () => this.refresh();
    this.controller.createRunProfile('Run dbt tests', vscode.TestRunProfileKind.Run, (req, token) => this.run(req, token).then(() => undefined), true);
    const watcher = vscode.workspace.createFileSystemWatcher('**/manifest.json');
    const later = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.refresh(), 300);
    };
    this.disposables.push(this.controller, watcher, watcher.onDidChange(later), watcher.onDidCreate(later), watcher.onDidDelete(later));
  }

  /** Rebuild the test tree from each project's manifest; the new maps replace the old ones only when complete. */
  async refresh(): Promise<void> {
    const data = new Map<string, TestData>();
    const projectMap = new Map<string, string>();
    const items: vscode.TestItem[] = [];
    for (const root of await this.deps.projectRoots()) {
      const index = await loadManifest(this.deps.language, root);
      if (!index || !index.tests.length) {
        continue;
      }
      const projectId = `project:${root}`;
      const project = this.controller.createTestItem(projectId, this.deps.language.projectNameOf(root) ?? path.basename(root), vscode.Uri.file(root));
      projectMap.set(projectId, root);
      const texts = new Map<string, string>();
      const textOf = (f: string) => {
        if (!texts.has(f)) {
          try {
            texts.set(f, fs.readFileSync(f, 'utf8'));
          } catch {
            texts.set(f, '');
          }
        }
        return texts.get(f)!;
      };
      const groups = new Map<string, vscode.TestItem>();
      for (const t of [...index.tests].sort((a, b) => a.name.localeCompare(b.name))) {
        const groupKey = t.attachedTo ?? '(singular tests)';
        let group = groups.get(groupKey);
        if (!group) {
          group = this.controller.createTestItem(`${projectId}::${groupKey}`, groupKey);
          groups.set(groupKey, group);
        }
        const item = this.controller.createTestItem(`${root}::${t.uniqueId}`, t.name, vscode.Uri.file(t.file));
        // Generic tests point at their column (or model) in the YAML; source tests at the table name.
        const owner = t.attachedTo?.split('.').pop();
        const line = t.singular || !owner ? 0 : testLine(textOf(t.file), owner, t.columnName);
        item.range = new vscode.Range(line, 0, line, 0);
        if (t.columnName) {
          item.description = t.columnName;
        }
        data.set(item.id, { root, test: t });
        group.children.add(item);
      }
      [...groups.keys()].sort().forEach(k => project.children.add(groups.get(k)!));
      items.push(project);
    }
    this.data = data;
    this.projects = projectMap;
    this.controller.items.replace(items);
  }

  /** All test leaves under `items`, minus excluded ones. */
  private leaves(items: readonly vscode.TestItem[], exclude: readonly vscode.TestItem[] = []): vscode.TestItem[] {
    const skip = new Set(exclude.map(e => e.id));
    const out: vscode.TestItem[] = [];
    const walk = (i: vscode.TestItem) => {
      if (skip.has(i.id)) {
        return;
      }
      if (this.data.has(i.id)) {
        out.push(i);
      }
      i.children.forEach(walk);
    };
    items.forEach(walk);
    return [...new Map(out.map(i => [i.id, i])).values()];
  }

  /** Run the requested tests; returns each test's outcome (also used by the integration suite). */
  async run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<Map<string, Outcome>> {
    const outcomes = new Map<string, Outcome>();
    const run = this.controller.createTestRun(request);
    try {
      const top: vscode.TestItem[] = [];
      this.controller.items.forEach(i => top.push(i));
      const requested = request.include ?? top;
      // Snapshot what each item is now: dbt rewrites the manifest during the run, which refreshes the tree.
      const leaves = this.leaves(requested, request.exclude).map(item => ({ item, ...this.data.get(item.id)! }));
      const excluded = this.leaves(request.exclude ?? []).map(item => this.data.get(item.id)!);
      const projects = new Map(this.projects);
      const exe = leaves.length ? await this.deps.requireExe() : undefined;
      if (!exe) {
        leaves.forEach(l => run.skipped(l.item));
        return outcomes;
      }
      const byRoot = new Map<string, typeof leaves>();
      for (const l of leaves) {
        byRoot.set(l.root, [...(byRoot.get(l.root) ?? []), l]);
      }
      const selectorOf = (root: string, t: NodeEntry) => (t.singular ? modelSelector(root, t.file) : t.name);
      for (const [root, items] of byRoot) {
        if (token.isCancellationRequested) {
          items.forEach(l => (run.skipped(l.item), outcomes.set(l.item.id, { state: 'skipped' })));
          continue;
        }
        // A requested project runs plain `dbt test` (with --exclude for anything excluded) instead of
        // listing every test; other selections are split so no command line passes Windows' limit.
        const whole = requested.some(r => projects.get(r.id) === root);
        const commands = whole
          ? [['test', ...(() => {
              const ex = excluded.filter(e => e.root === root).map(e => selectorOf(root, e.test));
              return ex.length ? ['--exclude', ...ex] : [];
            })()]]
          : batchSelectors(items.map(l => selectorOf(root, l.test)), 20000).map(b => ['test', '--select', ...b]);
        items.forEach(l => run.started(l.item));
        const byId = new Map<string, RunResult>();
        let failedCode: number | undefined;
        let tail = '';
        for (const base of commands) {
          if (token.isCancellationRequested) {
            break;
          }
          const args = [...base, ...this.deps.flags()];
          run.appendOutput(`\x1b[2m> dbt ${args.join(' ')}\x1b[0m\r\n\r\n`);
          const rrFile = path.join(this.deps.language.targetDirOf(root), 'run_results.json');
          const before = readIfExists(rrFile);
          const previous = before ? invocationOf(before) : undefined;
          const started = Date.now();
          const { code, output } = await this.spawnDbt(exe, args, root, run, token);
          const json = readIfExists(rrFile);
          // Only results this very invocation wrote — not a concurrent terminal run's or an older file.
          const accepted = json ? acceptResults(json, previous, started) : undefined;
          this.deps.diagnostics.update(output, root, accepted && json ? executedNodeNames(json) : []);
          accepted?.forEach(r => byId.set(r.uniqueId, r));
          if (code !== 0) {
            failedCode = code;
            tail = output.replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/).slice(-12).join('\n');
          }
        }
        for (const l of items) {
          outcomes.set(l.item.id, this.report(run, l.item, byId.get(l.test.uniqueId), token.isCancellationRequested, failedCode ?? 0, tail));
        }
      }
      return outcomes;
    } finally {
      run.end();
    }
  }

  private report(run: vscode.TestRun, item: vscode.TestItem, r: RunResult | undefined, cancelled: boolean, code: number | undefined, tail: string): Outcome {
    const ms = r?.seconds !== undefined ? r.seconds * 1000 : undefined;
    const at = item.uri && item.range ? new vscode.Location(item.uri, item.range) : undefined;
    const msg = (text: string) => {
      const m = new vscode.TestMessage(text);
      m.location = at;
      return m;
    };
    if (!r) {
      if (cancelled || code === 0) {
        run.skipped(item);
        return { state: 'skipped' };
      }
      run.errored(item, msg(`dbt did not run this test.\n\n${tail}`));
      return { state: 'errored', message: tail };
    }
    switch (r.status) {
      case 'pass':
        run.passed(item, ms);
        return { state: 'passed' };
      case 'warn':
        // VS Code has no "warned" state: passed, with the warning in the output next to the test.
        run.appendOutput(`\x1b[33mWARN ${item.label}: ${r.message ?? 'warning'}\x1b[0m\r\n`, at, item);
        run.passed(item, ms);
        return { state: 'passed', message: r.message };
      case 'skipped':
        run.skipped(item);
        return { state: 'skipped' };
      default: {
        const text = r.message ?? r.status;
        run.failed(item, msg(text), ms);
        return { state: 'failed', message: text };
      }
    }
  }

  private spawnDbt(
    exe: string,
    args: string[],
    cwd: string,
    run: vscode.TestRun,
    token: vscode.CancellationToken
  ): Promise<{ code: number | undefined; output: string }> {
    return new Promise(resolve => {
      let output = '';
      const child = spawn(exe, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      const onData = (text: string) => {
        output += text;
        run.appendOutput(text.replace(/\r?\n/g, '\r\n'));
      };
      child.stdout?.setEncoding('utf8').on('data', onData);
      child.stderr?.setEncoding('utf8').on('data', onData);
      const sub = token.onCancellationRequested(() => killTree(child));
      let done = false;
      const finish = (code: number | undefined) => {
        if (!done) {
          done = true;
          sub.dispose();
          resolve({ code, output });
        }
      };
      child.on('error', err => {
        onData(`Failed to start dbt: ${err.message}\n`);
        finish(undefined);
      });
      child.on('close', code => finish(code ?? undefined));
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}
