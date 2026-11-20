import * as path from 'path';

export type DbtAction = 'run' | 'build' | 'test' | 'compile' | 'show' | 'seed';

function insideDbtPackages(dir: string): boolean {
  return dir.split(/[\\/]/).some(seg => seg.toLowerCase() === 'dbt_packages');
}

/**
 * Walk up from a model file to the nearest folder containing dbt_project.yml.
 * Projects inside dbt_packages are skipped, and the walk never goes above `stopAt`.
 */
export function findProjectRoot(filePath: string, exists: (p: string) => boolean, stopAt?: string): string | undefined {
  let dir = path.dirname(path.resolve(filePath));
  const stop = stopAt ? path.resolve(stopAt).toLowerCase() : undefined;
  while (true) {
    if (!insideDbtPackages(dir) && exists(path.join(dir, 'dbt_project.yml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir.toLowerCase() === stop) {
      return undefined;
    }
    dir = parent;
  }
}

export function modelName(filePath: string): string {
  return path.basename(filePath).replace(/\.sql$/i, '');
}

/** Unambiguous dbt selector for one model file: `path:<relative path>` with forward slashes. */
export function modelSelector(projectRoot: string, filePath: string): string {
  return 'path:' + path.relative(projectRoot, filePath).split(path.sep).join('/');
}

export type GraphScope = 'none' | 'upstream' | 'downstream' | 'both';

/** Wrap a selector with dbt graph operators: `+sel` (parents), `sel+` (children), `+sel+` (both). */
export function withGraph(selector: string, scope: GraphScope): string {
  const up = scope === 'upstream' || scope === 'both' ? '+' : '';
  const down = scope === 'downstream' || scope === 'both' ? '+' : '';
  return `${up}${selector}${down}`;
}

/** Split a flag string on whitespace, keeping single- or double-quoted sections together. */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | undefined;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) {
        args.push(current);
        current = '';
        inToken = false;
      }
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (inToken) {
    args.push(current);
  }
  return args;
}

/** `--target` (when set) plus the user's extra flags. */
export function flagArgs(target: string, extraArgs: string): string[] {
  return [...(target.trim() ? ['--target', target.trim()] : []), ...splitArgs(extraArgs)];
}

/** No selectors = the whole project (no `--select`). */
export function buildArgs(action: DbtAction, selectors: string[], target: string, extraArgs: string): string[] {
  return [action, ...(selectors.length ? ['--select', ...selectors] : []), ...flagArgs(target, extraArgs)];
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * `path:` selectors for files/folders in a project. Selecting the project folder itself means everything,
 * which is no selector at all (dbt rejects `path:.`).
 */
export function folderSelectors(root: string, paths: string[]): string[] {
  return paths.some(p => samePath(p, root)) ? [] : paths.map(p => modelSelector(root, p));
}

/** Locate dbt inside a venv: Windows layout first, then POSIX. */
export function dbtExecutable(venvPath: string, exists: (p: string) => boolean): string | undefined {
  if (!venvPath.trim()) {
    return undefined;
  }
  const candidates = [path.join(venvPath, 'Scripts', 'dbt.exe'), path.join(venvPath, 'bin', 'dbt')];
  return candidates.find(c => exists(c));
}

export function parseDbtVersion(output: string): { version: string; major: number } | undefined {
  const m = /installed:\s*(\d+\.\d+\.\d+)/.exec(output) ?? /(\d+\.\d+\.\d+)/.exec(output);
  if (!m) {
    return undefined;
  }
  return { version: m[1], major: parseInt(m[1].split('.')[0], 10) };
}

/** Group model files by their dbt project root; files with no project go to `orphans`. */
export function groupByProject(
  files: string[],
  exists: (p: string) => boolean,
  stopAtFor: (file: string) => string | undefined = () => undefined
): { projects: Map<string, string[]>; orphans: string[] } {
  const projects = new Map<string, string[]>();
  const orphans: string[] = [];
  for (const f of files) {
    const root = findProjectRoot(f, exists, stopAtFor(f));
    if (!root) {
      orphans.push(f);
    } else {
      projects.set(root, [...(projects.get(root) ?? []), f]);
    }
  }
  return { projects, orphans };
}
