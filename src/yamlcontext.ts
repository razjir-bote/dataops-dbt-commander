/**
 * Where the cursor is in a dbt YAML file, read from indentation, `key:` and `- ` alone — so it works on the
 * half-typed, invalid YAML that is being written.
 */
export interface YamlContext {
  /** Mapping keys and `-` (list items) from the top level down to the cursor, e.g. models / - / columns / -. */
  path: string[];
  /**
   * key: typing a key · value: after `key:` · item: a list item's first word (a test name, or a key) ·
   * other: nothing to suggest (inside a block scalar such as `description: |`, a flow `[]` / `{}`, …).
   */
  kind: 'key' | 'value' | 'item' | 'other';
  /** For `value`: the key. */
  key?: string;
  /** The word being typed (for a quoted value: after the opening quote). */
  word: string;
  /** The opening quote of a quoted value being typed. */
  quote?: '"' | "'";
  /** Other keys already in the mapping at the cursor. */
  siblings: string[];
  /** The `name:` of each list item in `path`, in order. */
  items: { name?: string }[];
  /** For the cursor's own list item: the `name:` of the other items in that list. */
  listNames: string[];
}

interface Line {
  indent: number;
  dash: boolean;
  /** Where the content after `- ` starts. */
  content: number;
  key?: string;
  /** Text after `key:` (trimmed, comment removed; anchors / tags alone count as empty). */
  value?: string;
  /** Blank, a comment, or text inside a block scalar: not structure. */
  blank: boolean;
  /** `---` / `...`: a document boundary. */
  boundary: boolean;
  /** `key: |` or `key: >` — the following deeper lines are text. */
  blockScalar: boolean;
}

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

function parse(raw: string): Line {
  const text = raw.replace(/\r$/, '');
  const boundary = /^(---|\.\.\.)\s*$/.test(text);
  const blank = boundary || !text.trim() || text.trim().startsWith('#');
  const m = /^(\s*)(-\s+|-$)?(.*)$/.exec(text)!;
  const indent = m[1].length;
  const dash = !!m[2];
  // A bare `-` line: its mapping starts on the next line, two columns in.
  const content = indent + (m[2] === '-' ? 2 : m[2]?.length ?? 0);
  const kv = /^([\w.-]+)\s*:(?:\s+(.*?))?\s*$/.exec(m[3].replace(/\s+#.*$/, ''));
  const rawValue = (kv?.[2] ?? '').trim();
  const value = /^[&!]\S*$/.test(rawValue) ? '' : rawValue; // `config: &base` is still a parent
  return { indent, dash, content, blank, boundary, blockScalar: !!kv && /^[|>][-+0-9]*$/.test(rawValue), ...(kv ? { key: kv[1], value } : {}) };
}

/** Mark the text lines of block scalars as blank; true when `line` itself is inside one. */
function maskBlockScalars(lines: Line[], cursorLine: number, cursorIndent: number): boolean {
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].blockScalar) {
      continue;
    }
    const keyIndent = lines[i].dash ? lines[i].content : lines[i].indent;
    for (let k = i + 1; k < lines.length; k++) {
      const indent = k === cursorLine ? cursorIndent : lines[k].indent;
      const empty = k !== cursorLine && lines[k].blank && !lines[k].boundary;
      if (!empty && indent <= keyIndent) {
        break;
      }
      lines[k].blank = true;
      if (k === cursorLine) {
        inside = true;
      }
    }
  }
  return inside;
}

/** The `name:` of the list item starting at `at`. */
function itemName(lines: Line[], at: number): string | undefined {
  const item = lines[at];
  if (item.key === 'name') {
    return item.value ? unquote(item.value) : undefined;
  }
  for (let k = at + 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.boundary) {
      break;
    }
    if (l.blank) {
      continue;
    }
    if (l.indent < item.content || (l.indent === item.indent && l.dash)) {
      break;
    }
    if (l.indent === item.content && !l.dash && l.key === 'name') {
      return l.value ? unquote(l.value) : undefined;
    }
  }
  return undefined;
}

export function yamlContextAt(text: string, line: number, col: number): YamlContext {
  const raw = text.split('\n');
  const lines = raw.map(parse);
  const before = (raw[line] ?? '').replace(/\r$/, '').slice(0, col);

  // The cursor's own line.
  const m = /^(\s*)(-\s+)?(.*)$/.exec(before)!;
  const curIndent = m[1].length;
  const curDash = !!m[2];
  const curContent = curIndent + (m[2]?.length ?? 0);
  const rest = m[3];
  let kind: YamlContext['kind'];
  let key: string | undefined;
  let word: string;
  let quote: '"' | "'" | undefined;
  const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(rest);
  if (kv) {
    kind = 'value';
    key = kv[1];
    word = kv[2];
    if (/^["']/.test(word)) {
      quote = word[0] as '"' | "'";
      word = word.slice(1);
    }
    if (/^[[{|>&*!]/.test(word)) {
      kind = 'other'; // flow collection, block scalar indicator, anchor / alias / tag
    }
  } else if (/^[\w.-]*$/.test(rest)) {
    kind = curDash ? 'item' : 'key';
    word = rest;
  } else {
    kind = 'other';
    word = rest;
  }
  if (maskBlockScalars(lines, line, curIndent) && !(curDash || kv)) {
    kind = 'other';
  } else if (lines[line] && lines[line].blank && !lines[line].boundary && raw[line].trim() && !raw[line].trim().startsWith('#')) {
    kind = 'other'; // the whole line is block-scalar text
  }

  // Ancestors, walking up (not past a `---`).
  const rev: string[] = [];
  const itemLines: number[] = [];
  let c = curIndent;
  let allowEqual = curDash; // a list item's key may sit at the same indent (indentless list)
  for (let k = line - 1; k >= 0; k--) {
    const l = lines[k];
    if (l.boundary) {
      break;
    }
    if (l.blank || l.indent > c) {
      continue;
    }
    if (l.indent === c) {
      if (allowEqual && !l.dash && l.key !== undefined && !l.value) {
        rev.push(l.key);
        allowEqual = false;
      }
      continue;
    }
    // l.indent < c
    if (l.dash) {
      if (l.key !== undefined && !l.value && c > l.content) {
        rev.push(l.key); // under the item's own key: `- config:` then deeper lines
      }
      rev.push('-');
      itemLines.push(k);
      c = l.indent;
      allowEqual = true;
    } else if (l.key !== undefined && !l.value) {
      rev.push(l.key);
      c = l.indent;
      allowEqual = false;
    } else {
      c = l.indent;
      allowEqual = false;
    }
  }
  const path = rev.reverse();
  const items = itemLines.reverse().map(k => ({ name: itemName(lines, k) }));
  if (curDash) {
    path.push('-');
    items.push({ name: undefined }); // being written
  }

  // Keys already in the cursor's mapping.
  const siblings = new Set<string>();
  const mapIndent = curDash ? curContent : curIndent;
  if (!curDash) {
    for (let k = line - 1; k >= 0; k--) {
      const l = lines[k];
      if (l.boundary) {
        break;
      }
      if (l.blank || l.indent > mapIndent) {
        continue;
      }
      if (l.indent === mapIndent) {
        if (!l.dash && l.key) {
          siblings.add(l.key);
        }
        continue; // a dash here belongs to an indentless list under a sibling key
      }
      if (l.dash && l.content === mapIndent && l.key) {
        siblings.add(l.key); // the item's first key, on the dash line
      }
      break;
    }
  }
  for (let k = line + 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.boundary) {
      break;
    }
    if (l.blank || l.indent > mapIndent) {
      continue;
    }
    if (l.indent < mapIndent) {
      break;
    }
    if (!l.dash && l.key) {
      siblings.add(l.key);
    }
  }
  if (kind === 'value' && key) {
    siblings.delete(key);
  }

  // Names of the other items in the cursor's list.
  const listNames: string[] = [];
  if (curDash) {
    for (const dir of [-1, 1]) {
      for (let k = line + dir; k >= 0 && k < lines.length; k += dir) {
        const l = lines[k];
        if (l.boundary) {
          break;
        }
        if (l.blank || l.indent > curIndent) {
          continue;
        }
        // A shallower line, or a key at the dash's indent (an indentless list's parent / the next key): list ends.
        if (l.indent < curIndent || !l.dash) {
          break;
        }
        const n = itemName(lines, k);
        if (n) {
          listNames.push(n);
        }
      }
    }
  }
  return { path, kind, ...(key ? { key } : {}), word, ...(quote ? { quote } : {}), siblings: [...siblings], items, listNames };
}

/** The source table (`sources:` → `tables:` item) whose entry holds 0-based `line` — its name line, keys or columns. */
export function sourceTableAt(text: string, line: number): { source: string; table: string } | undefined {
  const lines = text.split('\n');
  if (line < 0 || line >= lines.length) {
    return undefined;
  }
  const ctx = yamlContextAt(text, line, lines[line].replace(/\r$/, '').length);
  const p = ctx.path;
  if (p[0] !== 'sources' || p[1] !== '-' || p[2] !== 'tables' || p[3] !== '-') {
    return undefined;
  }
  const source = ctx.items[0]?.name;
  // On the table's own `- name:` line its name is the value being "typed".
  const own = p.length === 4 && ctx.kind === 'value' && ctx.key === 'name' ? unquote((ctx.quote ?? '') + ctx.word) : undefined;
  const table = ctx.items[1]?.name ?? own;
  return source && table ? { source, table } : undefined;
}
