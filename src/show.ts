import * as path from 'path';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export interface ShowResult {
  rows?: Record<string, unknown>[];
  error?: string;
}

/**
 * JSON.parse that keeps integers outside JavaScript's safe range as their exact source text
 * (e.g. 38-digit warehouse keys), using the reviver's source-text access.
 */
function parsePreservingBigInts(text: string): Record<string, unknown>[] {
  return JSON.parse(text, ((_key: string, value: unknown, ctx?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && ctx?.source && /^-?\d+$/.test(ctx.source) ? ctx.source : value
  ) as (this: unknown, key: string, value: unknown) => unknown);
}

/** Parse `dbt show --output json --log-format json` output (dbt-core 1.x). */
export function parseShowOutput(output: string): ShowResult {
  let error: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('{')) {
      continue;
    }
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.info?.name === 'ShowNode' && typeof ev.data?.preview === 'string') {
      try {
        return { rows: parsePreservingBigInts(ev.data.preview) };
      } catch {
        return { error: 'Could not read the preview returned by dbt.' };
      }
    }
    if (ev?.info?.level === 'error' && !error) {
      error = String(ev.data?.exc ?? ev.info?.msg ?? '').replace(ANSI, '');
    }
  }
  return { error: error ?? (output.replace(ANSI, '').trim() || 'dbt returned no preview.') };
}

/** Location dbt-core 1.x writes a model's compiled SQL to. */
export function compiledPath(root: string, projectName: string, targetPath: string | undefined, modelFile: string): string {
  return path.join(root, targetPath ?? 'target', 'compiled', projectName, path.relative(root, modelFile));
}
