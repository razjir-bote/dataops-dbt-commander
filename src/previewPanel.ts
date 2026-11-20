import * as vscode from 'vscode';
import * as path from 'path';
import { ShowResult } from './show';
import { Row, ViewState, columnsOf, toCsv, toTsv, viewRows } from './exportrows';

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** JSON safe to embed in a <script> block. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export interface PreviewOptions {
  /** Offer a Σ (profile) button on column headers. */
  onProfile?: (column: string) => void | Promise<void>;
}

export class PreviewPanel {
  private static current: PreviewPanel | undefined;
  private onRefresh: () => void = () => undefined;
  private options: PreviewOptions = {};
  private title = '';
  private rows: Row[] = [];
  private columns: string[] = [];

  /** Show (or reuse) the preview panel in a loading state. */
  static loading(title: string, onRefresh: () => void, options: PreviewOptions = {}): PreviewPanel {
    if (!PreviewPanel.current) {
      const panel = vscode.window.createWebviewPanel('dbtCommanderPreview', `Preview: ${title}`, vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: []
      });
      PreviewPanel.current = new PreviewPanel(panel);
    }
    const p = PreviewPanel.current;
    p.onRefresh = onRefresh;
    p.options = options;
    p.title = title;
    p.rows = [];
    p.columns = [];
    p.panel.title = `Preview: ${title}`;
    p.panel.reveal(undefined, true);
    p.render(title, '<p class="muted">Running dbt show…</p>', '', undefined);
    return p;
  }

  private constructor(private readonly panel: vscode.WebviewPanel) {
    panel.onDidDispose(() => (PreviewPanel.current = undefined));
    panel.webview.onDidReceiveMessage(m => void this.onMessage(m));
  }

  private async onMessage(m: any): Promise<void> {
    if (m?.type === 'refresh') {
      this.onRefresh();
    } else if (m?.type === 'profile' && typeof m.column === 'string') {
      void this.options.onProfile?.(m.column);
    } else if (m?.type === 'copy' || m?.type === 'save') {
      const shown = viewRows(this.rows, sanitize(m.view));
      if (m.type === 'copy') {
        await vscode.env.clipboard.writeText(toTsv(this.columns, shown));
        void vscode.window.setStatusBarMessage(`dbt Commander: copied ${shown.length} row${shown.length === 1 ? '' : 's'}`, 3000);
        return;
      }
      await this.saveCsv(toCsv(this.columns, shown), shown.length);
    }
  }

  private async saveCsv(csv: string, count: number): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const name = `${this.title.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'preview'}.csv`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
      filters: { CSV: ['csv'] },
      saveLabel: 'Save CSV'
    });
    if (!target) {
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from('\ufeff' + csv, 'utf8')); // BOM: Excel reads it as UTF-8
      void vscode.window.showInformationMessage(`dbt Commander: saved ${count} row${count === 1 ? '' : 's'} to ${path.basename(target.fsPath)}.`);
    } catch (e) {
      void vscode.window.showErrorMessage(`dbt Commander: could not save ${target.fsPath}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The rows currently held (for tests). */
  get data(): { columns: string[]; rows: Row[] } {
    return { columns: this.columns, rows: this.rows };
  }

  static get active(): PreviewPanel | undefined {
    return PreviewPanel.current;
  }

  showResult(title: string, result: ShowResult, elapsedMs: number, limit: number): void {
    const secs = (elapsedMs / 1000).toFixed(1);
    if (result.error || !result.rows) {
      this.rows = [];
      this.columns = [];
      this.render(title, `<pre class="error">${esc(result.error ?? 'No rows returned.')}</pre>`, `failed after ${secs}s`, undefined);
      return;
    }
    this.rows = result.rows;
    this.columns = columnsOf(result.rows);
    const capped = result.rows.length >= limit ? ` (limit ${limit})` : '';
    this.render(title, '', `${secs}s`, { columns: this.columns, rows: this.rows, capped });
  }

  private render(title: string, content: string, meta: string, data: { columns: string[]; rows: Row[]; capped: string } | undefined): void {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const tools = data
      ? `<input id="filter" type="search" placeholder="Filter rows" aria-label="Filter rows">
         <button id="copy" title="Copy the shown rows (tab-separated, for spreadsheets)">Copy</button>
         <button id="save" title="Save the shown rows as CSV">Save CSV…</button>`
      : '';
    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 16px 16px; }
  header { position: sticky; top: 0; background: var(--vscode-editor-background); display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 0 8px; z-index: 2; }
  h1 { font-size: 1.15em; margin: 0; font-weight: 600; }
  .muted, .meta { color: var(--vscode-descriptionForeground); }
  .meta { flex: 1; min-width: 120px; }
  button { padding: 3px 12px; border: none; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font-family: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  input { padding: 3px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; width: 180px; }
  .wrap { overflow: auto; max-height: calc(100vh - 80px); border: 1px solid var(--vscode-panel-border, transparent); }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { padding: 3px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); text-align: left; white-space: nowrap; max-width: 480px; overflow: hidden; text-overflow: ellipsis; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); font-weight: 600; cursor: pointer; user-select: none; }
  th .arrow { color: var(--vscode-descriptionForeground); margin-left: 4px; }
  th .prof { margin-left: 6px; padding: 0 4px; font-weight: normal; background: transparent; color: var(--vscode-descriptionForeground); }
  th .prof:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  .idx { color: var(--vscode-descriptionForeground); text-align: right; cursor: default; }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  pre.error { white-space: pre-wrap; padding: 10px; border-left: 3px solid var(--vscode-editorError-foreground, #f85149); background: var(--vscode-textBlockQuote-background); }
</style></head>
<body>
<header><h1>${esc(title)}</h1><span class="meta" id="meta">${esc(meta)}</span>${tools}<button id="refresh">Refresh</button></header>
<div id="content">${content}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  const data = ${scriptJson(data ?? null)};
  const baseMeta = ${scriptJson(meta)};
  const profile = ${this.options.onProfile ? 'true' : 'false'};
  const viewRows = ${viewRows.toString()};
  if (data) {
    const saved = vscode.getState() || {};
    const view = { sort: saved.sort, filter: saved.filter || '' };
    const filterBox = document.getElementById('filter');
    filterBox.value = view.filter;
    const content = document.getElementById('content');
    const meta = document.getElementById('meta');
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const draw = () => {
      if (view.sort && !data.columns.includes(view.sort.column)) view.sort = undefined;
      vscode.setState({ sort: view.sort, filter: view.filter });
      const shown = viewRows(data.rows, view);
      const n = data.rows.length;
      const count = view.filter.trim() ? shown.length + ' of ' + n + ' rows' : n + ' row' + (n === 1 ? '' : 's');
      meta.textContent = count + data.capped + ' · ' + baseMeta;
      if (!n) { content.replaceChildren(el('p', 'muted', 'Query returned no rows.')); return; }
      const table = el('table');
      const head = el('tr');
      head.appendChild(el('th', 'idx', '#'));
      for (const c of data.columns) {
        const th = el('th', '', c);
        th.title = 'Sort by ' + c;
        if (view.sort && view.sort.column === c) th.appendChild(el('span', 'arrow', view.sort.dir === 'asc' ? '▲' : '▼'));
        th.addEventListener('click', () => {
          view.sort = !view.sort || view.sort.column !== c ? { column: c, dir: 'asc' } : view.sort.dir === 'asc' ? { column: c, dir: 'desc' } : undefined;
          draw();
        });
        if (profile) {
          const b = el('button', 'prof', 'Σ');
          b.title = 'Profile ' + c;
          b.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'profile', column: c }); });
          th.appendChild(b);
        }
        head.appendChild(th);
      }
      const thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
      const body = el('tbody');
      shown.forEach((r, i) => {
        const tr = el('tr');
        tr.appendChild(el('td', 'idx', String(i + 1)));
        for (const c of data.columns) {
          const v = r[c];
          if (v === null || v === undefined) tr.appendChild(el('td', 'null', 'NULL'));
          else tr.appendChild(el('td', typeof v === 'number' ? 'num' : '', typeof v === 'object' ? JSON.stringify(v) : String(v)));
        }
        body.appendChild(tr);
      });
      table.appendChild(body);
      const wrap = el('div', 'wrap'); wrap.appendChild(table);
      content.replaceChildren(wrap);
    };
    filterBox.addEventListener('input', e => { view.filter = e.target.value; draw(); });
    document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy', view }));
    document.getElementById('save').addEventListener('click', () => vscode.postMessage({ type: 'save', view }));
    draw();
  }
</script>
</body></html>`;
  }
}

/** The view state the webview sent, checked. */
function sanitize(v: any): ViewState {
  const out: ViewState = {};
  if (typeof v?.filter === 'string') {
    out.filter = v.filter;
  }
  if (typeof v?.sort?.column === 'string' && (v.sort.dir === 'asc' || v.sort.dir === 'desc')) {
    out.sort = { column: v.sort.column, dir: v.sort.dir };
  }
  return out;
}
