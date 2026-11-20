/** Preview rows: sort / filter (shared with the webview) and CSV / TSV export. */

export type Row = Record<string, unknown>;

export interface ViewState {
  sort?: { column: string; dir: 'asc' | 'desc' };
  filter?: string;
}

/** Column names in first-seen order across all rows. */
export function columnsOf(rows: Row[]): string[] {
  const cols: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!cols.includes(k)) {
        cols.push(k);
      }
    }
  }
  return cols;
}

/**
 * The rows as shown: filtered (any cell contains the text, case-insensitive; NULL reads as "null") and sorted
 * (numbers and integer strings numerically, text naturally, NULLs last either way; stable).
 * Self-contained — no outside references — because the webview runs this same function's source.
 */
export function viewRows(rows: Row[], view: ViewState): Row[] {
  const text = (v: unknown): string => (v === null || v === undefined ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const isNull = (v: unknown) => v === null || v === undefined;
  const intText = /^-?\d+$/;
  const numText = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
  // Numeric order only when every value in the column is a number (or numeric text); otherwise text order for
  // all of them — mixing the two isn't transitive.
  const compare = (numeric: boolean) => (a: unknown, b: unknown): number => {
    if (!numeric) {
      return text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' });
    }
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b;
    }
    const sa = text(a);
    const sb = text(b);
    if (intText.test(sa) && intText.test(sb)) {
      const x = BigInt(sa);
      const y = BigInt(sb);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    return Number(sa) - Number(sb);
  };
  const needle = (view.filter ?? '').trim().toLowerCase();
  let out = needle ? rows.filter(r => Object.values(r).some(v => text(v).toLowerCase().includes(needle))) : rows.slice();
  const sort = view.sort;
  if (sort) {
    const sign = sort.dir === 'desc' ? -1 : 1;
    const cmp = compare(
      out.every(r => isNull(r[sort.column]) || (typeof r[sort.column] === 'number' && Number.isFinite(r[sort.column])) || numText.test(text(r[sort.column])))
    );
    out = out
      .map((r, i) => ({ r, i }))
      .sort((p, q) => {
        const a = p.r[sort.column];
        const b = q.r[sort.column];
        if (isNull(a) || isNull(b)) {
          return isNull(a) && isNull(b) ? p.i - q.i : isNull(a) ? 1 : -1;
        }
        return sign * cmp(a, b) || p.i - q.i;
      })
      .map(x => x.r);
  }
  return out;
}

function cellText(v: unknown): string {
  return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** RFC 4180 CSV (CRLF line ends); NULL is an empty field. */
export function toCsv(columns: string[], rows: Row[]): string {
  const field = (s: string) => (/[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [columns, ...rows.map(r => columns.map(c => cellText(r[c])))].map(line => line.map(field).join(',')).join('\r\n') + '\r\n';
}

/**
 * Tab-separated text for pasting into a spreadsheet: tabs / line breaks inside cells become spaces, and cells with
 * a double quote are quoted (Excel's paste otherwise treats a leading quote as the start of a quoted field).
 */
export function toTsv(columns: string[], rows: Row[]): string {
  const field = (s: string) => {
    const flat = s.replace(/\r\n|[\t\r\n]/g, ' ');
    return flat.includes('"') ? `"${flat.replace(/"/g, '""')}"` : flat;
  };
  return [columns, ...rows.map(r => columns.map(c => cellText(r[c])))].map(line => line.map(field).join('\t')).join('\n') + '\n';
}
