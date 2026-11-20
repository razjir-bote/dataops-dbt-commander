import { parseCall } from './jinja';

/** A text replacement by absolute offsets into the original text. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Model names already used in the project (lower-cased). Manifest entries whose file no longer exists don't
 * count: right after a rename the manifest is stale and still lists the old name until dbt parses again.
 */
export function takenModelNames(models: { name: string; package: string; file: string }[], pkg: string, exists: (f: string) => boolean): Set<string> {
  return new Set(models.filter(m => m.package === pkg && exists(m.file)).map(m => m.name.toLowerCase()));
}

export function isValidModelName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Edits that turn `ref('old')` into `ref('new')` — any quote style, with or without a package argument or a
 * version keyword. Only calls whose model name is exactly `oldName` change; quotes and other arguments stay.
 */
export function renameRefEdits(text: string, oldName: string, newName: string, pkg?: string): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const m of text.matchAll(/\bref\s*\(([^()]*)\)/g)) {
    const call = parseCall('ref', m[1]);
    // ref('other_pkg', 'orders') is another package's model: leave it alone.
    if (call?.kind !== 'ref' || call.name !== oldName || (pkg && call.package && call.package !== pkg)) {
      continue;
    }
    const argsStart = (m.index ?? 0) + m[0].indexOf('(') + 1;
    // The model name is the last positional string literal (not a `v=` / `version=` keyword value).
    const literals = [...m[1].matchAll(/(['"])([^'"]*)\1/g)].filter(l => !/=\s*$/.test(m[1].slice(0, l.index)));
    const name = literals[literals.length - 1];
    if (!name || name[2] !== oldName) {
      continue;
    }
    const start = argsStart + (name.index ?? 0) + 1;
    edits.push({ start, end: start + oldName.length, text: newName });
  }
  return edits;
}

/** Edits renaming `- name: old` entries that sit directly under a `models:` list (not columns / sources). */
export function renameYamlEdits(text: string, oldName: string, newName: string): TextEdit[] {
  const edits: TextEdit[] = [];
  const lines: { text: string; offset: number }[] = [];
  for (let offset = 0; offset <= text.length; ) {
    const nl = text.indexOf('\n', offset);
    const end = nl < 0 ? text.length : nl;
    lines.push({ text: text.slice(offset, end).replace(/\r$/, ''), offset });
    if (nl < 0) {
      break;
    }
    offset = nl + 1;
  }
  // The key owning a list item: its indent is lower — or equal, for indentless lists (`models:\n- name: x`).
  const parentKey = (i: number, indent: number) => {
    for (let k = i - 1; k >= 0; k--) {
      const key = /^(\s*)([\w-]+):\s*(#.*)?$/.exec(lines[k].text);
      if (key && key[1].length <= indent) {
        return key[2];
      }
    }
    return undefined;
  };
  const topLevelKey = (i: number) => {
    for (let k = i - 1; k >= 0; k--) {
      const key = /^([\w-]+):/.exec(lines[k].text);
      if (key) {
        return key[1];
      }
    }
    return undefined;
  };
  const replaceValue = (line: { text: string; offset: number }, quote: string, keyword: string) => {
    const at = line.text.indexOf(quote + oldName, line.text.indexOf(keyword)) + quote.length;
    edits.push({ start: line.offset + at, end: line.offset + at + oldName.length, text: newName });
  };
  lines.forEach((line, i) => {
    const entry = /^(\s*)-\s*name:\s*(['"]?)([^'"#\s]+)\2\s*(#.*)?$/.exec(line.text);
    if (entry && entry[3] === oldName && parentKey(i, entry[1].length) === 'models') {
      replaceValue(line, entry[2], 'name:');
      return;
    }
    // Unit tests name their model with a bare `model: <name>` key.
    const unit = /^\s+-?\s*model:\s*(['"]?)([^'"#\s]+)\1\s*(#.*)?$/.exec(line.text);
    if (unit && unit[2] === oldName && topLevelKey(i) === 'unit_tests') {
      replaceValue(line, unit[1], 'model:');
    }
  });
  return edits;
}
