/**
 * Auto-parse, the parts without VS Code: which changes need a `dbt parse`, which dbt processes are running per
 * project, and the per-project debounce / queue.
 */
import * as path from 'path';
import type { ProjectPaths } from './projectconfig';

/** Project files outside the resource folders that dbt reads while parsing. */
const PROJECT_FILES = new Set(['dbt_project.yml', 'packages.yml', 'dependencies.yml', 'selectors.yml']);
const EXTENSIONS = /\.(sql|ya?ml|csv|md|py|jinja2?)$/i;
const TOOLING = /(^|\/)(\.git|node_modules|\.venv|venv|__pycache__)(\/|$)/i;

/** Does a change to this project-relative path (a file, or a folder created / deleted) need a parse? */
export function parseTrigger(rel: string, paths: ProjectPaths): boolean {
  const r = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!r || r.startsWith('../') || TOOLING.test(r)) {
    return false;
  }
  if (PROJECT_FILES.has(r.toLowerCase())) {
    return true;
  }
  const norm = (d: string) => d.replace(/\\/g, '/').replace(/^\.(\/|$)/, '').replace(/\/+$/, '');
  const under = (d: string) => {
    const n = norm(d).toLowerCase();
    const x = r.toLowerCase();
    return n === '' || x === n || x.startsWith(n + '/');
  };
  if ([paths.target, paths.packagesInstall, 'logs'].some(d => norm(d) && under(d))) {
    return false;
  }
  const base = r.split('/').pop()!;
  if (base.includes('.') && !EXTENSIONS.test(base)) {
    return false; // editor swap files, compiled output, images …
  }
  return [...paths.model, ...paths.seed, ...paths.snapshot, ...paths.test, ...paths.macro, ...paths.analysis].some(under);
}

export type DbtUse = 'auto' | 'user';

const keyOf = (root: string) => {
  const r = path.resolve(root).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

interface Running {
  use: DbtUse;
  args: string[];
  started: number;
}

/**
 * dbt processes running per project: auto-parse waits for every one, user commands wait for auto-parse (dbt
 * writes target/ on every command; two at once can corrupt the manifest or partial_parse.msgpack).
 */
export class DbtActivity {
  private readonly running = new Map<string, Map<number, Running>>();
  private readonly waiters: { key: string; use?: DbtUse; resolve: () => void }[] = [];
  private readonly ended: ((root: string, run: Running, code: number | undefined) => void)[] = [];
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Register a dbt process; call the result (any number of times) with its exit code when it ends. */
  begin(root: string, use: DbtUse, args: string[]): (code?: number) => void {
    const key = keyOf(root);
    const id = ++this.seq;
    const run: Running = { use, args, started: this.now() };
    let map = this.running.get(key);
    if (!map) {
      map = new Map();
      this.running.set(key, map);
    }
    map.set(id, run);
    let done = false;
    return code => {
      if (done) {
        return;
      }
      done = true;
      map!.delete(id);
      if (!map!.size) {
        this.running.delete(key);
      }
      for (const w of this.waiters.filter(w => w.key === key && !this.busy(root, w.use))) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve();
      }
      for (const l of this.ended) {
        l(root, run, code);
      }
    };
  }

  /** Any dbt process (of that kind) running for the project. */
  busy(root: string, use?: DbtUse): boolean {
    const map = this.running.get(keyOf(root));
    return !!map && [...map.values()].some(r => !use || r.use === use);
  }

  /** Resolves once no dbt process (of that kind) runs for the project. */
  whenIdle(root: string, use?: DbtUse): Promise<void> {
    if (!this.busy(root, use)) {
      return Promise.resolve();
    }
    return new Promise(resolve => this.waiters.push({ key: keyOf(root), use, resolve }));
  }

  /** whenIdle, unless the token is cancelled first: resolves true when idle, false when cancelled. */
  whenIdleUnless(root: string, use: DbtUse | undefined, token?: { isCancellationRequested: boolean; onCancellationRequested(cb: () => void): unknown }): Promise<boolean> {
    if (!token) {
      return this.whenIdle(root, use).then(() => true);
    }
    return new Promise(resolve => {
      token.onCancellationRequested(() => resolve(false));
      void this.whenIdle(root, use).then(() => resolve(!token.isCancellationRequested));
    });
  }

  onEnded(listener: (root: string, run: Running, code: number | undefined) => void): { dispose(): void } {
    this.ended.push(listener);
    return { dispose: () => void this.ended.splice(this.ended.indexOf(listener), 1) };
  }
}

/** The one registry every dbt process in the extension reports to. */
export const dbtActivity = new DbtActivity();

/** dbt commands that don't parse the project (so don't refresh the manifest). */
const NOT_PARSING = new Set(['deps', 'clean', 'debug', 'init', '--version', '-v', 'retry']);
const parses = (args: string[]) => !!args[0] && !NOT_PARSING.has(args[0]);

/** `skipped`: dbt couldn't run (not found / untrusted) — the change stays pending. */
export interface ParseResult {
  ok: boolean;
  error?: string;
  skipped?: boolean;
}

export interface SchedulerDeps {
  debounceMs: number;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  activity: DbtActivity;
  /** Run `dbt parse` for the project. */
  run(root: string): Promise<ParseResult>;
  onState(root: string, state: { running: boolean; failed?: string }): void;
}

interface ProjectState {
  root: string;
  timer?: unknown;
  /** A change not yet parsed (timer pending, waiting for other dbt, or arrived during a parse). */
  pending: boolean;
  lastChange: number;
  running: boolean;
  failed?: string;
}

/** Per project: debounce changes, never run beside other dbt, one parse at a time, one queued after it. */
export class ParseScheduler {
  private readonly projects = new Map<string, ProjectState>();
  private enabled = true;
  private readonly sub: { dispose(): void };

  constructor(private readonly deps: SchedulerDeps) {
    this.sub = deps.activity.onEnded((root, run, code) => this.otherEnded(root, run, code));
  }

  dispose(): void {
    this.sub.dispose();
    for (const p of this.projects.values()) {
      if (p.timer !== undefined) {
        this.deps.clearTimer(p.timer);
      }
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      for (const p of this.projects.values()) {
        if (p.timer !== undefined) {
          this.deps.clearTimer(p.timer);
          p.timer = undefined;
        }
        p.pending = false;
        if (p.failed) {
          p.failed = undefined;
          this.deps.onState(p.root, { running: p.running, failed: undefined });
        }
      }
    }
  }

  /** The last auto-parse's error for the project, while it stands. */
  failure(root: string): string | undefined {
    return this.projects.get(keyOf(root))?.failed;
  }

  /** A file that dbt reads changed in the project. */
  changed(root: string): void {
    if (!this.enabled) {
      return;
    }
    const p = this.state(root);
    p.pending = true;
    p.lastChange = this.deps.now();
    if (p.running) {
      return; // parsed again when this parse ends
    }
    this.schedule(p);
  }

  private state(root: string): ProjectState {
    const key = keyOf(root);
    let p = this.projects.get(key);
    if (!p) {
      p = { root, pending: false, lastChange: 0, running: false };
      this.projects.set(key, p);
    }
    return p;
  }

  private schedule(p: ProjectState): void {
    if (p.timer !== undefined) {
      this.deps.clearTimer(p.timer);
    }
    p.timer = this.deps.setTimer(() => {
      p.timer = undefined;
      this.tryStart(p);
    }, this.deps.debounceMs);
  }

  private tryStart(p: ProjectState): void {
    if (!this.enabled || !p.pending || p.running || p.timer !== undefined || this.deps.activity.busy(p.root)) {
      return; // otherEnded() retries once the other dbt command finishes
    }
    void this.start(p);
  }

  private async start(p: ProjectState): Promise<void> {
    p.pending = false;
    p.running = true;
    this.deps.onState(p.root, { running: true, failed: p.failed });
    const end = this.deps.activity.begin(p.root, 'auto', ['parse']);
    let result: ParseResult;
    try {
      result = await this.deps.run(p.root);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    p.running = false;
    if (result.skipped) {
      p.pending = true; // dbt isn't available right now: parse once it is and something changes again
    } else if (this.enabled) {
      p.failed = result.ok ? undefined : result.error || 'dbt parse failed';
    }
    end(result.ok ? 0 : 1);
    this.deps.onState(p.root, { running: false, failed: p.failed });
    if (p.pending && !result.skipped) {
      this.schedule(p); // changes while it ran
    }
  }

  private otherEnded(root: string, run: Running, code: number | undefined): void {
    if (run.use === 'auto') {
      return;
    }
    const p = this.projects.get(keyOf(root));
    if (!p) {
      return;
    }
    // A command that parsed successfully after the last change left a current manifest. One that failed (maybe at
    // parse time) or was cancelled may not have: the pending parse still runs.
    if (parses(run.args) && code === 0 && run.started > p.lastChange) {
      p.pending = false;
      if (p.timer !== undefined) {
        this.deps.clearTimer(p.timer);
        p.timer = undefined;
      }
      if (p.failed) {
        p.failed = undefined;
        this.deps.onState(p.root, { running: p.running, failed: undefined });
      }
    }
    this.tryStart(p);
  }
}

/** The first line of dbt's error (e.g. "Compilation Error in model a (models/a.sql)"), for the tooltip. */
export function firstError(text: string): string {
  const lines = text.split(/\r?\n/).map(l => l.replace(/^\s*\d\d:\d\d:\d\d\s+/, '').trim()).filter(Boolean);
  return (lines.find(l => /error/i.test(l) && !/^Encountered an error:?$/i.test(l)) ?? lines[lines.length - 1] ?? 'dbt parse failed').slice(0, 300);
}
