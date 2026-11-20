import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { NodeRun, RUN_COMMANDS, liveNodeIds, mergeResults, pruneRunState, rootKey, statusBadge } from './runstate';
import { RunStatusSource } from './language';

const KEY = 'dbtCommander.runState';

interface StatusDeps {
  projectRootOf(file: string): string | undefined;
  targetDirOf(root: string): string;
  projectRoots(): Promise<string[]>;
}

/**
 * The latest dbt result per node, per project, from every run_results.json dbt writes (runs from the extension
 * and from a terminal alike). Persisted in workspace state, so badges survive reloads.
 */
export class RunStatusStore implements RunStatusSource, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private state: Record<string, Record<string, NodeRun>>;
  private latest: { root: string; json: string; at: number } | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly memento: vscode.Memento, private readonly deps: StatusDeps) {
    this.state = memento.get<Record<string, Record<string, NodeRun>>>(KEY) ?? {};
    const watcher = vscode.workspace.createFileSystemWatcher('**/run_results.json');
    const onFile = (uri: vscode.Uri) => void this.ingest(uri.fsPath, true);
    // "3m ago" ages: refresh badges once a minute.
    const timer = setInterval(() => Object.keys(this.state).length && this.changed.fire(), 60_000);
    // A rewritten manifest (after a rename / delete) drops results of nodes that no longer exist.
    const manifests = vscode.workspace.createFileSystemWatcher('**/manifest.json');
    const pruneTimers = new Map<string, NodeJS.Timeout>();
    const onManifest = (uri: vscode.Uri) => {
      const root = this.deps.projectRootOf(uri.fsPath);
      if (!root || !this.isTargetFile(root, uri.fsPath)) {
        return;
      }
      clearTimeout(pruneTimers.get(root));
      pruneTimers.set(root, setTimeout(() => void this.prune(root), 2000));
    };
    this.disposables.push(
      this.changed,
      watcher,
      watcher.onDidChange(onFile),
      watcher.onDidCreate(onFile),
      manifests,
      manifests.onDidChange(onManifest),
      manifests.onDidCreate(onManifest),
      { dispose: () => (clearInterval(timer), pruneTimers.forEach(t => clearTimeout(t))) }
    );
  }

  /** Read every project's current run_results.json (on activation). */
  async init(): Promise<void> {
    for (const root of await this.deps.projectRoots()) {
      await this.ingest(path.join(this.deps.targetDirOf(root), 'run_results.json'), false);
      await this.prune(root, false);
    }
    this.changed.fire();
  }

  /** Merge one run_results.json; `announce` fires a change when anything is new. */
  async ingest(file: string, announce: boolean): Promise<void> {
    const root = this.deps.projectRootOf(file);
    if (!root || !this.isTargetFile(root, file)) {
      return;
    }
    let json: string;
    try {
      json = await fs.promises.readFile(file, 'utf8');
    } catch {
      return;
    }
    let at = 0;
    let which = '';
    try {
      const doc = JSON.parse(json);
      at = Date.parse(doc?.metadata?.generated_at ?? '') || 0;
      which = String(doc?.args?.which ?? '');
    } catch {
      return; // half-written: the watcher fires again when dbt finishes writing
    }
    // Only real runs become "the last run" (what Retry retries): not show / compile / docs / parse.
    if (RUN_COMMANDS.has(which) && (!this.latest || at >= this.latest.at)) {
      this.latest = { root, json, at };
    }
    const key = rootKey(root);
    const before = this.state[key] ?? {};
    const after = mergeResults(before, json);
    if (after !== before) {
      this.state = { ...this.state, [key]: after };
      await this.memento.update(KEY, this.state);
    }
    if (announce) {
      this.changed.fire();
    }
  }

  private isTargetFile(root: string, file: string): boolean {
    return path.resolve(path.dirname(file)).toLowerCase() === path.resolve(this.deps.targetDirOf(root)).toLowerCase();
  }

  /** Drop saved results for nodes that are no longer in the project's manifest. */
  async prune(root: string, announce = true): Promise<void> {
    const key = rootKey(root);
    const before = this.state[key];
    if (!before) {
      return;
    }
    let live: Set<string> | undefined;
    try {
      live = liveNodeIds(await fs.promises.readFile(path.join(this.deps.targetDirOf(root), 'manifest.json'), 'utf8'));
    } catch {
      return;
    }
    const after = live && pruneRunState(this.state[key] ?? {}, live);
    if (!after || after === this.state[key]) {
      return; // unreadable / half-written manifest, or nothing to drop
    }
    this.state = { ...this.state, [key]: after };
    await this.memento.update(KEY, this.state);
    if (announce) {
      this.changed.fire();
    }
  }

  /** e.g. "✓ 3m ago · 1.2s" for a node's last result, if any. */
  badge(root: string, uniqueId: string): string | undefined {
    const r = this.state[rootKey(root)]?.[uniqueId];
    return r ? statusBadge(r, Date.now()) : undefined;
  }

  result(root: string, uniqueId: string): NodeRun | undefined {
    return this.state[rootKey(root)]?.[uniqueId];
  }

  /** The most recent run_results.json seen, across projects. */
  get lastRun(): { root: string; json: string } | undefined {
    return this.latest;
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
