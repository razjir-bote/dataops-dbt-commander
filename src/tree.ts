import * as path from 'path';

/**
 * Which tree items a command acts on. VS Code passes (clicked item, selected items): act on the whole selection
 * when the clicked row is part of it; a button on an unselected row acts on that row only.
 */
export function pickSelection<T>(clicked: T | undefined, selected: readonly T[] | undefined): T[] {
  if (!selected?.length) {
    return clicked ? [clicked] : [];
  }
  return !clicked || selected.includes(clicked) ? [...selected] : [clicked];
}

/**
 * What a Models / Seeds section stands for when you press Build / Seed on it: its single top-level folder
 * (usually `models/` or `seeds/`), else each top-level folder and file that holds them — never the whole
 * project, which would also build seeds, snapshots and tests the user didn't ask for.
 */
export function sectionTargets(root: string, files: string[]): string[] {
  const top = levelOf(root, files, '');
  return [...top.folders.map(f => path.join(root, f)), ...top.files];
}

/**
 * Sub-folders (names) and files directly inside `dir` (relative to `root`, '/'-separated, '' = root),
 * given every file of a kind (models, seeds, ...). Folders and files are sorted.
 */
export function levelOf(root: string, files: string[], dir: string): { folders: string[]; files: string[] } {
  const prefix = dir ? dir + '/' : '';
  const folders = new Set<string>();
  const here: string[] = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (!rel.startsWith(prefix)) {
      continue;
    }
    const rest = rel.slice(prefix.length);
    if (rest.includes('/')) {
      folders.add(rest.split('/')[0]);
    } else {
      here.push(f);
    }
  }
  return { folders: [...folders].sort(), files: here.sort((a, b) => path.basename(a).localeCompare(path.basename(b))) };
}
