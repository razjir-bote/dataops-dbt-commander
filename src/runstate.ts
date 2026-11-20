/**
 * One key per project folder however its path was spelled: VS Code reports `c:\…`, Node `C:\…`, and paths may
 * carry a trailing separator. (Windows paths are case-insensitive.)
 */
export function rootKey(root: string): string {
  const path = require('path') as typeof import('path');
  const resolved = path.resolve(root).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** The latest result of one dbt node. */
export interface NodeRun {
  status: string;
  /** When the run that produced it finished (ms since epoch). */
  at: number;
  seconds?: number;
}

/** dbt commands whose results say something about a node's last run. */
export const RUN_COMMANDS = new Set(['run', 'build', 'test', 'seed', 'snapshot', 'retry']);

function parse(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** Merge a run_results.json into the per-node state, keeping the newest result for each node. */
export function mergeResults(prev: Record<string, NodeRun>, runResultsJson: string): Record<string, NodeRun> {
  const doc = parse(runResultsJson);
  const at = Date.parse(doc?.metadata?.generated_at ?? '');
  if (!doc || !Array.isArray(doc.results) || !RUN_COMMANDS.has(doc.args?.which) || !Number.isFinite(at)) {
    return prev;
  }
  const next = { ...prev };
  for (const r of doc.results) {
    if (typeof r?.unique_id !== 'string' || (next[r.unique_id] && next[r.unique_id].at > at)) {
      continue;
    }
    next[r.unique_id] = { status: String(r.status), at, ...(typeof r.execution_time === 'number' ? { seconds: r.execution_time } : {}) };
  }
  return next;
}

function ago(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 60) {
    return 'just now';
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h ago`;
  }
  return `${Math.floor(s / 86400)}d ago`;
}

/** e.g. "✓ 3m ago · 1.2s", "✗ error 2h ago", "⚠ warn 1m ago · 1.0s". */
export function statusBadge(r: NodeRun, now: number): string {
  const when = ago(now - r.at);
  const time = r.seconds !== undefined ? ` · ${r.seconds.toFixed(1)}s` : '';
  switch (r.status) {
    case 'success':
    case 'pass':
      return `✓ ${when}${time}`;
    case 'warn':
      return `⚠ warn ${when}${time}`;
    case 'skipped':
      return `– skipped ${when}`;
    default:
      return `✗ ${r.status} ${when}`;
  }
}

const duration = (s: number) => (s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);

export interface RunSummary {
  which: string;
  ok: number;
  errors: number;
  warnings: number;
  skipped: number;
  total: number;
  seconds: number;
  text: string;
}

/** Counts for a finished run, and a one-line summary for a notification. */
export function runSummary(runResultsJson: string): RunSummary | undefined {
  const doc = parse(runResultsJson);
  if (!doc || !Array.isArray(doc.results)) {
    return undefined;
  }
  const count = (...s: string[]) => doc.results.filter((r: any) => s.includes(r?.status)).length;
  const which = String(doc.args?.which ?? 'dbt');
  const ok = count('success', 'pass');
  const errors = count('error', 'fail', 'runtime error');
  const warnings = count('warn');
  const skipped = count('skipped');
  const seconds = typeof doc.elapsed_time === 'number' ? doc.elapsed_time : 0;
  const parts = [`${ok} passed`, ...(errors ? [`${errors} failed`] : []), ...(warnings ? [`${warnings} warnings`] : []), ...(skipped ? [`${skipped} skipped`] : [])];
  return { which, ok, errors, warnings, skipped, total: doc.results.length, seconds, text: `dbt ${which} finished: ${parts.join(', ')} (${duration(seconds)})` };
}

/** Nodes of a run, slowest first. */
export function slowest(runResultsJson: string): { uniqueId: string; status: string; seconds: number; message?: string }[] {
  const doc = parse(runResultsJson);
  if (!doc || !Array.isArray(doc.results)) {
    return [];
  }
  return doc.results
    .filter((r: any) => typeof r?.unique_id === 'string')
    .map((r: any) => ({
      uniqueId: r.unique_id,
      status: String(r.status),
      seconds: typeof r.execution_time === 'number' ? r.execution_time : 0,
      ...(typeof r.message === 'string' && r.message ? { message: r.message } : {})
    }))
    .sort((a: { seconds: number }, b: { seconds: number }) => b.seconds - a.seconds);
}

/** The state without nodes that are no longer in the project (the same object when nothing was dropped). */
export function pruneRunState(state: Record<string, NodeRun>, liveIds: Set<string>): Record<string, NodeRun> {
  const keep = Object.entries(state).filter(([id]) => liveIds.has(id));
  return keep.length === Object.keys(state).length ? state : Object.fromEntries(keep);
}

/** unique_ids a run_results.json can mention (nodes, sources, unit tests, functions, …); undefined if the manifest is unusable. */
export function liveNodeIds(manifestJson: string): Set<string> | undefined {
  const m = parse(manifestJson);
  if (!m || typeof m.nodes !== 'object' || !m.nodes || !Object.keys(m.nodes).length) {
    return undefined;
  }
  return new Set(['nodes', 'sources', 'unit_tests', 'functions', 'saved_queries', 'exposures', 'semantic_models'].flatMap(k => Object.keys(m[k] ?? {})));
}
