import { parse } from 'yaml';

export interface ProjectPaths {
  model: string[];
  seed: string[];
  snapshot: string[];
  analysis: string[];
  macro: string[];
  test: string[];
  /** Where `dbt deps` installs packages. */
  packagesInstall: string;
  target: string;
}

/** "./transform/" → "transform"; backslashes → "/". */
const norm = (p: string) =>
  p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');

function list(v: unknown, fallback: string[]): string[] {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  // Jinja (`{{ env_var(...) }}`) can't be resolved here: leave that entry out (default if nothing remains).
  const out = items.filter((x): x is string => typeof x === 'string' && !x.includes('{{')).map(norm).filter(Boolean);
  return out.length ? out : fallback;
}

/**
 * Absolute paths of the configured folders (`dirs`, relative to `root`), all their sub-folders, and the files in
 * them matching `ext` — the set VS Code menus check with `resourcePath in …`. `list` returns a folder's entries
 * (undefined when the folder doesn't exist). Capped so a huge folder can't stall the editor.
 */
export function resourcePaths(
  root: string,
  dirs: string[],
  ext: RegExp,
  list: (dir: string) => { name: string; dir: boolean }[] | undefined,
  max = 20000
): string[] {
  const path = require('path') as typeof import('path');
  const out: string[] = [];
  const queue = dirs.map(d => path.join(root, ...d.split('/')));
  while (queue.length && out.length < max) {
    const dir = queue.shift()!;
    const entries = list(dir);
    if (!entries) {
      continue;
    }
    out.push(dir);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.dir) {
        queue.push(p);
      } else if (ext.test(e.name)) {
        out.push(p);
      }
    }
  }
  return out;
}

/** Resource folders and install/target paths from a dbt_project.yml, with dbt-core 1.x defaults. */
export function projectPaths(dbtProjectYml: string): ProjectPaths {
  let d: any = {};
  try {
    const parsed = parse(dbtProjectYml);
    d = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    d = {};
  }
  const one = (v: unknown, fallback: string) => (typeof v === 'string' && norm(v) ? norm(v) : fallback);
  return {
    model: list(d['model-paths'], ['models']),
    seed: list(d['seed-paths'], ['seeds']),
    snapshot: list(d['snapshot-paths'], ['snapshots']),
    analysis: list(d['analysis-paths'], ['analyses']),
    macro: list(d['macro-paths'], ['macros']),
    test: list(d['test-paths'], ['tests']),
    packagesInstall: one(d['packages-install-path'], 'dbt_packages'),
    target: one(d['target-path'], 'target')
  };
}
