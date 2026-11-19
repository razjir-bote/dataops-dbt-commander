import * as vscode from 'vscode';
import * as fs from 'fs';
import { DbtAction, GraphScope, buildArgs, dbtExecutable, groupByProject, modelName, modelSelector, withGraph } from './dbt';
import { SettingsPanel, detectDbtVersion } from './settingsPanel';

let statusItem: vscode.StatusBarItem;
let context: vscode.ExtensionContext;

const exists = (p: string) => fs.existsSync(p);

function openSettings(): void {
  SettingsPanel.show(context, () => void refreshStatus());
}

async function refreshStatus(): Promise<void> {
  const venv = vscode.workspace.getConfiguration('dbtRunner').get<string>('venvPath', '');
  if (!venv.trim()) {
    statusItem.text = '$(gear) dbt: not configured';
    statusItem.tooltip = 'Click to set the dbt venv';
    statusItem.backgroundColor = undefined;
    return;
  }
  const info = await detectDbtVersion(venv);
  if (info.error) {
    statusItem.text = '$(error) dbt: not found';
    statusItem.tooltip = info.error;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (info.major !== 1) {
    statusItem.text = `$(warning) dbt ${info.version}`;
    statusItem.tooltip = `dbt ${info.version} detected; dbt Runner supports dbt-core 1.x only.`;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusItem.text = `$(database) dbt ${info.version}`;
    statusItem.tooltip = `dbt-core ${info.version}\n${info.exe}\nClick to open dbt Runner settings`;
    statusItem.backgroundColor = undefined;
  }
}

async function runDbt(action: DbtAction, graph: GraphScope, uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const targets = (uris && uris.length ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [])
    .filter(u => u.scheme === 'file' && /\.sql$/i.test(u.fsPath))
    .map(u => u.fsPath);

  if (targets.length === 0) {
    void vscode.window.showErrorMessage('dbt Runner: select one or more .sql model files.');
    return;
  }

  const { projects, orphans } = groupByProject(targets, exists, f => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(f))?.uri.fsPath);
  if (orphans.length) {
    void vscode.window.showErrorMessage(`dbt Runner: no dbt_project.yml found above ${orphans.map(modelName).join(', ')}.`);
    return;
  }
  if (projects.size > 1) {
    void vscode.window.showErrorMessage('dbt Runner: selected models belong to different dbt projects. Run them separately.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('dbtRunner');
  const exe = dbtExecutable(cfg.get<string>('venvPath', ''), exists);
  if (!exe) {
    const choice = await vscode.window.showErrorMessage(
      'dbt Runner: dbt executable not found. Set the venv path in dbt Runner settings.',
      'Open Settings'
    );
    if (choice === 'Open Settings') {
      openSettings();
    }
    return;
  }

  const [root, files] = [...projects.entries()][0];
  const models = files.map(f => withGraph(modelName(f), graph));
  const selectors = files.map(f => withGraph(modelSelector(root, f), graph));
  const args = buildArgs(action, selectors, cfg.get<string>('target', ''), cfg.get<string>('extraArgs', ''));
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));

  const task = new vscode.Task(
    { type: 'dbtRunner', action, models },
    folder ?? vscode.TaskScope.Workspace,
    `${action} ${models.join(' ')}`,
    'dbt',
    new vscode.ProcessExecution(exe, args, { cwd: root })
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true, panel: vscode.TaskPanelKind.Dedicated };
  await vscode.tasks.executeTask(task);
}

export function activate(ctx: vscode.ExtensionContext): void {
  context = ctx;

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'dbtRunner.openSettings';
  statusItem.show();

  const commands: [string, DbtAction, GraphScope][] = [
    ['run', 'run', 'none'],
    ['build', 'build', 'none'],
    ['test', 'test', 'none'],
    ['buildUpstream', 'build', 'upstream'],
    ['buildDownstream', 'build', 'downstream'],
    ['buildUpDownstream', 'build', 'both']
  ];
  for (const [id, action, graph] of commands) {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(`dbtRunner.${id}`, (uri?: vscode.Uri, uris?: vscode.Uri[]) => runDbt(action, graph, uri, uris))
    );
  }

  ctx.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('dbtRunner.openSettings', openSettings),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('dbtRunner.venvPath')) {
        void refreshStatus();
      }
    })
  );

  void refreshStatus();
}

export function deactivate(): void {}
