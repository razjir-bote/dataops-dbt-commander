import * as vscode from 'vscode';
import { ShowResult } from './show';

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cell(v: unknown): string {
  if (v === null || v === undefined) {
    return '<td class="null">NULL</td>';
  }
  const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
  const cls = typeof v === 'number' ? ' class="num"' : '';
  return `<td${cls}>${esc(text)}</td>`;
}

export class PreviewPanel {
  private static current: PreviewPanel | undefined;
  private onRefresh: () => void = () => undefined;

  /** Show (or reuse) the preview panel in a loading state. */
  static loading(model: string, onRefresh: () => void): PreviewPanel {
    if (!PreviewPanel.current) {
      const panel = vscode.window.createWebviewPanel('dbtCommanderPreview', `Preview: ${model}`, vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: []
      });
      PreviewPanel.current = new PreviewPanel(panel);
    }
    const p = PreviewPanel.current;
    p.onRefresh = onRefresh;
    p.panel.title = `Preview: ${model}`;
    p.panel.reveal(undefined, true);
    p.render(model, `<p class="muted">Running dbt show…</p>`, '');
    return p;
  }

  private constructor(private readonly panel: vscode.WebviewPanel) {
    panel.onDidDispose(() => (PreviewPanel.current = undefined));
    panel.webview.onDidReceiveMessage(m => m?.type === 'refresh' && this.onRefresh());
  }

  showResult(model: string, result: ShowResult, elapsedMs: number, limit: number): void {
    const secs = (elapsedMs / 1000).toFixed(1);
    if (result.error || !result.rows) {
      this.render(model, `<pre class="error">${esc(result.error ?? 'No rows returned.')}</pre>`, `failed after ${secs}s`);
      return;
    }
    const rows = result.rows;
    const cols: string[] = [];
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (!cols.includes(k)) {
          cols.push(k);
        }
      }
    }
    const head = `<tr><th class="idx">#</th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`;
    const body = rows.map((r, i) => `<tr><td class="idx">${i + 1}</td>${cols.map(c => cell(r[c])).join('')}</tr>`).join('');
    const capped = rows.length >= limit ? ` (limit ${limit})` : '';
    const table = rows.length
      ? `<div class="wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`
      : '<p class="muted">Query returned no rows.</p>';
    this.render(model, table, `${rows.length} row${rows.length === 1 ? '' : 's'}${capped} · ${secs}s`);
  }

  private render(model: string, content: string, meta: string): void {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 16px 16px; }
  header { position: sticky; top: 0; background: var(--vscode-editor-background); display: flex; align-items: baseline; gap: 12px; padding: 12px 0 8px; z-index: 2; }
  h1 { font-size: 1.15em; margin: 0; font-weight: 600; }
  .muted, .meta { color: var(--vscode-descriptionForeground); }
  .meta { flex: 1; }
  button { padding: 3px 12px; border: none; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font-family: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .wrap { overflow: auto; max-height: calc(100vh - 70px); border: 1px solid var(--vscode-panel-border, transparent); }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { padding: 3px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); text-align: left; white-space: nowrap; max-width: 480px; overflow: hidden; text-overflow: ellipsis; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  .idx { color: var(--vscode-descriptionForeground); text-align: right; }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  pre.error { white-space: pre-wrap; padding: 10px; border-left: 3px solid var(--vscode-editorError-foreground, #f85149); background: var(--vscode-textBlockQuote-background); }
</style></head>
<body>
<header><h1>${esc(model)}</h1><span class="meta">${esc(meta)}</span><button id="refresh">Refresh</button></header>
${content}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
</script>
</body></html>`;
  }
}
