import * as vscode from 'vscode';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { dbtExecutable, parseDbtVersion } from './dbt';

export interface DbtVersionInfo {
  exe?: string;
  version?: string;
  major?: number;
  error?: string;
}

export function detectDbtVersion(venvPath: string): Promise<DbtVersionInfo> {
  const exe = dbtExecutable(venvPath, p => fs.existsSync(p));
  if (!exe) {
    return Promise.resolve({
      error: venvPath.trim() ? 'dbt was not found in this venv (expected Scripts\\dbt.exe).' : 'No venv path set.'
    });
  }
  return new Promise(resolve => {
    execFile(exe, ['--version'], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      const parsed = parseDbtVersion(`${stdout}\n${stderr}`);
      if (parsed) {
        resolve({ exe, ...parsed });
      } else {
        resolve({ exe, error: err ? `Failed to run dbt --version: ${err.message}` : 'Could not read the dbt version.' });
      }
    });
  });
}

function settingsTarget(): vscode.ConfigurationTarget {
  return vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

export class SettingsPanel {
  private static current: SettingsPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, onSaved: () => void, getTargets: () => string[] = () => []): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('dbtRunnerSettings', 'dbt Runner Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: []
    });
    SettingsPanel.current = new SettingsPanel(panel, onSaved, getTargets);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly onSaved: () => void,
    private readonly getTargets: () => string[]
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), null, this.disposables);
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async check(venvPath: string): Promise<void> {
    this.post({ type: 'checking' });
    this.post({ type: 'version', info: await detectDbtVersion(venvPath) });
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        const cfg = vscode.workspace.getConfiguration('dbtRunner');
        const state = {
          venvPath: cfg.get<string>('venvPath', ''),
          target: cfg.get<string>('target', ''),
          extraArgs: cfg.get<string>('extraArgs', '')
        };
        this.post({ type: 'state', state });
        this.post({ type: 'targets', targets: this.getTargets() });
        await this.check(state.venvPath);
        break;
      }
      case 'browse': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Select venv folder',
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
        });
        if (picked?.[0]) {
          this.post({ type: 'venvPicked', venvPath: picked[0].fsPath });
          await this.check(picked[0].fsPath);
        }
        break;
      }
      case 'check':
        await this.check(String(msg.venvPath ?? ''));
        break;
      case 'save': {
        const cfg = vscode.workspace.getConfiguration('dbtRunner');
        const target = settingsTarget();
        await cfg.update('venvPath', String(msg.venvPath ?? '').trim(), target);
        await cfg.update('target', String(msg.target ?? '').trim(), target);
        await cfg.update('extraArgs', String(msg.extraArgs ?? '').trim(), target);
        this.post({ type: 'saved' });
        this.onSaved();
        break;
      }
    }
  }

  private dispose(): void {
    SettingsPanel.current = undefined;
    this.disposables.forEach(d => d.dispose());
  }

  private html(): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const csp = `default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dbt Runner Settings</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px 24px; max-width: 720px; }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 4px; }
  .sub { color: var(--vscode-descriptionForeground); margin: 0 0 24px; }
  .field { margin-bottom: 20px; }
  label { display: block; font-weight: 600; margin-bottom: 4px; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.92em; margin-top: 4px; }
  .row { display: flex; gap: 8px; }
  input { flex: 1; width: 100%; box-sizing: border-box; padding: 4px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; font-size: inherit; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button { padding: 4px 14px; border: none; cursor: pointer; font-family: inherit; font-size: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .version { padding: 8px 10px; border-left: 3px solid var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); }
  .version.ok { border-left-color: var(--vscode-testing-iconPassed, #3fb950); }
  .version.warn { border-left-color: var(--vscode-editorWarning-foreground, #d29922); }
  .version.err { border-left-color: var(--vscode-editorError-foreground, #f85149); }
  .actions { display: flex; align-items: center; gap: 12px; margin-top: 28px; }
  #status { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h1>dbt Runner</h1>
  <p class="sub">Settings are saved to this workspace.</p>

  <div class="field">
    <label for="venv">Virtual environment</label>
    <div class="row">
      <input id="venv" type="text" placeholder="C:\\path\\to\\.venv" spellcheck="false">
      <button id="browse" class="secondary">Browse…</button>
    </div>
    <div class="hint">Folder containing <code>Scripts\\dbt.exe</code>.</div>
  </div>

  <div class="field">
    <label>Detected dbt version</label>
    <div id="version" class="version">Checking…</div>
  </div>

  <div class="field">
    <label for="target">Target</label>
    <input id="target" type="text" placeholder="(profile default)" spellcheck="false" list="targetList">
    <datalist id="targetList"></datalist>
    <div class="hint">Passed as <code>--target</code>. Leave blank to use the profile's default.</div>
  </div>

  <div class="field">
    <label for="extra">Extra flags</label>
    <input id="extra" type="text" placeholder="e.g. --full-refresh --fail-fast" spellcheck="false">
    <div class="hint">Appended to every run / build / test, separated by spaces.</div>
  </div>

  <div class="actions">
    <button id="save">Save</button>
    <span id="status"></span>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const venv = $('venv'), target = $('target'), extra = $('extra'), version = $('version'), status = $('status');
  let timer;

  function setVersion(cls, text) { version.className = 'version ' + cls; version.textContent = text; }

  $('browse').addEventListener('click', () => vscode.postMessage({ type: 'browse' }));
  venv.addEventListener('input', () => {
    status.textContent = '';
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'check', venvPath: venv.value }), 500);
  });
  [target, extra].forEach(el => el.addEventListener('input', () => { status.textContent = ''; }));
  $('save').addEventListener('click', () => vscode.postMessage({
    type: 'save', venvPath: venv.value, target: target.value, extraArgs: extra.value
  }));

  window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
      case 'state':
        venv.value = msg.state.venvPath; target.value = msg.state.target; extra.value = msg.state.extraArgs;
        break;
      case 'venvPicked':
        venv.value = msg.venvPath; status.textContent = '';
        break;
      case 'checking':
        setVersion('', 'Checking…');
        break;
      case 'version': {
        const i = msg.info;
        if (i.error) setVersion('err', i.error);
        else if (i.major !== 1) setVersion('warn', 'dbt ' + i.version + ' — this extension supports dbt-core 1.x only. Commands may not work.');
        else setVersion('ok', 'dbt-core ' + i.version);
        break;
      }
      case 'targets': {
        const list = document.getElementById('targetList');
        list.replaceChildren(...msg.targets.map(t => { const o = document.createElement('option'); o.value = t; return o; }));
        break;
      }
      case 'saved':
        status.textContent = 'Saved.';
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
