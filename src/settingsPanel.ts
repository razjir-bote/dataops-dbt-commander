import * as vscode from 'vscode';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { dbtExecutable, parseDbtVersion } from './dbt';
import { parseSqlfluffVersion, sqlfluffExecutable } from './sqlfluff';

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

/**
 * SQLFluff in the venv, if any: its version, or why not. With `start` false (linting off) SQLFluff is not run —
 * only its executable is looked for.
 */
export function detectSqlfluff(venvPath: string, start = true): Promise<{ version?: string; found?: boolean; error?: string }> {
  const exe = sqlfluffExecutable(venvPath, p => fs.existsSync(p));
  if (!exe) {
    return Promise.resolve({ error: 'SQLFluff is not installed in this venv (pip install sqlfluff).' });
  }
  if (!start) {
    return Promise.resolve({ found: true });
  }
  return new Promise(resolve => {
    execFile(exe, ['--version'], { timeout: 30000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout, stderr) => {
      const version = parseSqlfluffVersion(`${stdout}\n${stderr}`);
      resolve(version ? { version } : { error: err ? `Failed to run sqlfluff --version: ${err.message}` : 'Could not read the SQLFluff version.' });
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
      // Reopened: show current settings, not whatever the panel loaded first.
      const p = SettingsPanel.current;
      p.onSaved = onSaved;
      p.getTargets = getTargets;
      p.panel.reveal();
      void p.sendState(true);
      return;
    }
    const panel = vscode.window.createWebviewPanel('dbtCommanderSettings', 'dbt Commander Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: []
    });
    SettingsPanel.current = new SettingsPanel(panel, onSaved, getTargets);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private onSaved: () => void,
    private getTargets: () => string[]
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
    // Separately: the dbt line shouldn't wait for SQLFluff. With linting off, SQLFluff is never started.
    const start = vscode.workspace.getConfiguration('dbtCommander').get<string>('sqlfluff.enabled', 'off') !== 'off';
    await Promise.all([
      detectDbtVersion(venvPath).then(info => this.post({ type: 'version', info })),
      detectSqlfluff(venvPath, start).then(info => this.post({ type: 'sqlfluffVersion', info }))
    ]);
  }

  /** `soft`: the panel was reopened; the webview keeps unsaved edits instead of overwriting them. */
  private async sendState(soft = false): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('dbtCommander');
    const state = {
      venvPath: cfg.get<string>('venvPath', ''),
      target: cfg.get<string>('target', ''),
      extraArgs: cfg.get<string>('extraArgs', ''),
      autoParse: cfg.get<boolean>('autoParse', true),
      sqlfluffEnabled: cfg.get<string>('sqlfluff.enabled', 'off'),
      sqlfluffFixOnSave: cfg.get<boolean>('sqlfluff.fixOnSave', false),
      sqlfluffDialect: cfg.get<string>('sqlfluff.dialect', ''),
      sqlfluffExtraArgs: cfg.get<string>('sqlfluff.extraArgs', '')
    };
    this.post({ type: 'state', state, soft });
    this.post({ type: 'targets', targets: this.getTargets() });
    await this.check(state.venvPath);
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.sendState();
        break;
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
        const cfg = vscode.workspace.getConfiguration('dbtCommander');
        const target = settingsTarget();
        // A cleared field removes the setting instead of storing "".
        const value = (v: unknown) => String(v ?? '').trim() || undefined;
        try {
          await cfg.update('venvPath', value(msg.venvPath), target);
          await cfg.update('target', value(msg.target), target);
          await cfg.update('extraArgs', value(msg.extraArgs), target);
          // On is the default: stored as "not set" so a User-level choice still applies.
          // …unless a broader level turns it off: then on must be stored to win.
          const offElsewhere = cfg.inspect<boolean>('autoParse')?.globalValue === false;
          await cfg.update('autoParse', msg.autoParse === false ? false : offElsewhere ? true : undefined, target);
          const mode = ['off', 'on', 'auto'].includes(msg.sqlfluffEnabled) ? msg.sqlfluffEnabled : 'off';
          // Defaults are stored as "not set", so a User-level SQLFluff setting still applies.
          await cfg.update('sqlfluff.enabled', mode === 'off' ? undefined : mode, target);
          await cfg.update('sqlfluff.fixOnSave', msg.sqlfluffFixOnSave === true ? true : undefined, target);
          await cfg.update('sqlfluff.dialect', value(msg.sqlfluffDialect), target);
          await cfg.update('sqlfluff.extraArgs', value(msg.sqlfluffExtraArgs), target);
        } catch (err) {
          this.post({ type: 'saveError', message: err instanceof Error ? err.message : String(err) });
          break;
        }
        // A field cleared here may still be set at a broader level (e.g. User settings) — say so.
        const after = vscode.workspace.getConfiguration('dbtCommander');
        const labels: Record<string, string> = { venvPath: 'venv path', target: 'target', extraArgs: 'extra flags' };
        const inherited = Object.keys(labels).filter(k => !value(msg[k]) && String(after.get(k) ?? '').trim());
        const note = inherited.length
          ? `Still set in your User settings: ${inherited.map(k => `${labels[k]} = "${after.get(k)}"`).join(', ')}.`
          : undefined;
        this.post({ type: 'saved', note });
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
<title>dbt Commander Settings</title>
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
  #status.error { color: var(--vscode-errorForeground); }
  h2 { font-size: 1.1em; font-weight: 600; margin: 32px 0 4px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); }
  select { padding: 4px 6px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); font-family: inherit; font-size: inherit; }
  .check { display: flex; align-items: center; gap: 8px; font-weight: normal; }
  .off { opacity: .5; }
</style>
</head>
<body>
  <h1>DataOps dbt Commander</h1>
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

  <div class="field">
    <label class="check"><input id="autoParse" type="checkbox" style="flex:none;width:auto"> Parse automatically when project files change</label>
    <div class="hint">Runs <code>dbt parse</code> in the background after you save, add or delete models, YAML, seeds, macros or tests, so the sidebar, lineage and completion stay current. Never runs beside another dbt command.</div>
  </div>

  <h2>SQLFluff linting</h2>
  <p class="sub">Lint dbt SQL files with the SQLFluff installed in the venv above. Off by default.</p>

  <div class="field">
    <label>Detected SQLFluff</label>
    <div id="sfVersion" class="version">Checking…</div>
  </div>

  <div class="field">
    <label for="sfEnabled">Linting</label>
    <select id="sfEnabled">
      <option value="off">Off — no SQLFluff features at all</option>
      <option value="on">On</option>
      <option value="auto">Auto — when the venv has SQLFluff</option>
    </select>
    <div class="hint">Problems on open and save, <em>Format Document</em>, and the SQLFluff commands. Off never starts SQLFluff.</div>
  </div>

  <div id="sfOptions">
    <div class="field">
      <label class="check"><input id="sfFix" type="checkbox" style="flex:none;width:auto"> Fix on save</label>
      <div class="hint">Runs <code>sqlfluff fix</code> when you save a file yourself (not on auto-save). One undo step.</div>
    </div>

    <div class="field">
      <label for="sfDialect">Dialect</label>
      <input id="sfDialect" type="text" placeholder="(from .sqlfluff, else the dbt adapter)" spellcheck="false">
      <div class="hint">e.g. <code>tsql</code> for Synapse / SQL Server. Leave blank to use your SQLFluff config or the dbt adapter.</div>
    </div>

    <div class="field">
      <label for="sfExtra">SQLFluff extra flags</label>
      <input id="sfExtra" type="text" placeholder="e.g. --templater dbt" spellcheck="false">
    </div>
  </div>

  <div class="actions">
    <button id="save">Save</button>
    <span id="status"></span>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const autoParse = $('autoParse');
  const venv = $('venv'), target = $('target'), extra = $('extra'), version = $('version'), status = $('status');
  const sfEnabled = $('sfEnabled'), sfFix = $('sfFix'), sfDialect = $('sfDialect'), sfExtra = $('sfExtra'), sfVersion = $('sfVersion');
  // Off: the SQLFluff options don't apply — grey them out.
  function syncSqlfluff() {
    const off = sfEnabled.value === 'off';
    [sfFix, sfDialect, sfExtra].forEach(el => (el.disabled = off));
    $('sfOptions').classList.toggle('off', off);
  }
  let timer;
  let dirty = false; // unsaved edits in the form

  function setVersion(cls, text) { version.className = 'version ' + cls; version.textContent = text; }

  $('browse').addEventListener('click', () => vscode.postMessage({ type: 'browse' }));
  venv.addEventListener('input', () => {
    dirty = true;
    status.textContent = '';
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'check', venvPath: venv.value }), 500);
  });
  [target, extra, sfDialect, sfExtra].forEach(el => el.addEventListener('input', () => { dirty = true; status.textContent = ''; }));
  autoParse.addEventListener('change', () => { dirty = true; status.textContent = ''; });
  [sfEnabled, sfFix].forEach(el => el.addEventListener('change', () => { dirty = true; status.textContent = ''; syncSqlfluff(); }));
  $('save').addEventListener('click', () => vscode.postMessage({
    type: 'save', venvPath: venv.value, target: target.value, extraArgs: extra.value, autoParse: autoParse.checked,
    sqlfluffEnabled: sfEnabled.value, sqlfluffFixOnSave: sfFix.checked, sqlfluffDialect: sfDialect.value, sqlfluffExtraArgs: sfExtra.value
  }));

  window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
      case 'state':
        if (msg.soft && dirty) break; // panel reopened: keep the user's unsaved edits
        venv.value = msg.state.venvPath; target.value = msg.state.target; extra.value = msg.state.extraArgs;
        autoParse.checked = msg.state.autoParse !== false;
        sfEnabled.value = ['off', 'on', 'auto'].includes(msg.state.sqlfluffEnabled) ? msg.state.sqlfluffEnabled : 'off';
        sfFix.checked = !!msg.state.sqlfluffFixOnSave; sfDialect.value = msg.state.sqlfluffDialect; sfExtra.value = msg.state.sqlfluffExtraArgs;
        syncSqlfluff();
        dirty = false;
        break;
      case 'venvPicked':
        venv.value = msg.venvPath; status.textContent = ''; dirty = true;
        break;
      case 'checking':
        setVersion('', 'Checking…');
        sfVersion.className = 'version'; sfVersion.textContent = 'Checking…';
        break;
      case 'sqlfluffVersion':
        sfVersion.className = 'version ' + (msg.info.error ? 'warn' : 'ok');
        sfVersion.textContent = msg.info.error || (msg.info.version ? 'SQLFluff ' + msg.info.version : 'SQLFluff is installed (not started while linting is off).');
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
        dirty = false;
        status.className = '';
        status.textContent = 'Saved.' + (msg.note ? ' ' + msg.note : '');
        break;
      case 'saveError':
        status.className = 'error';
        status.textContent = 'Could not save: ' + msg.message;
        break;
    }
  });

  syncSqlfluff();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
