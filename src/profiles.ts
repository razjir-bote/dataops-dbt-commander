import * as path from 'path';
import { parse } from 'yaml';
import { splitArgs } from './dbt';

function safeParse(text: string): unknown {
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parseProjectFile(text: string): { name?: string; profile?: string; targetPath?: string } {
  const doc = safeParse(text);
  if (!doc || typeof doc !== 'object') {
    return {};
  }
  const d = doc as Record<string, unknown>;
  return { name: str(d.name), profile: str(d.profile), targetPath: str(d['target-path']) };
}

/** Where dbt-core 1.x looks for profiles.yml, most specific first. */
export function profilesDirCandidates(root: string, extraArgs: string, env: NodeJS.ProcessEnv, home: string): string[] {
  const dirs: string[] = [];
  const args = splitArgs(extraArgs);
  const i = args.indexOf('--profiles-dir');
  const eq = args.find(a => a.startsWith('--profiles-dir='));
  const flagDir = eq ? eq.slice('--profiles-dir='.length) : i >= 0 ? args[i + 1] : undefined;
  if (flagDir) {
    dirs.push(path.resolve(root, flagDir));
  }
  if (env.DBT_PROFILES_DIR) {
    dirs.push(path.resolve(root, env.DBT_PROFILES_DIR));
  }
  dirs.push(root, path.join(home, '.dbt'));
  return dirs;
}

export function listTargets(profilesText: string, profile: string): { targets: string[]; defaultTarget?: string } | undefined {
  const doc = safeParse(profilesText);
  const entry = doc && typeof doc === 'object' ? (doc as Record<string, unknown>)[profile] : undefined;
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const e = entry as Record<string, unknown>;
  const outputs = e.outputs && typeof e.outputs === 'object' ? Object.keys(e.outputs as object) : [];
  return { targets: outputs, defaultTarget: str(e.target) };
}
