import * as path from 'path';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export interface ShowResult {
  rows?: Record<string, unknown>[];
  error?: string;
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
        return { rows: JSON.parse(ev.data.preview) };
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
