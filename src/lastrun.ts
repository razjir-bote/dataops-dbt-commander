import * as vscode from 'vscode';
import { LanguageDeps, loadManifest } from './language';
import { RunStatusStore } from './runstatus';
import { runSummary, slowest } from './runstate';

export class LastRunItem extends vscode.TreeItem {
  constructor(label: string, readonly uniqueId: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

function icon(status: string): vscode.ThemeIcon {
  switch (status) {
    case 'success':
    case 'pass':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'warn':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    case 'skipped':
      return new vscode.ThemeIcon('circle-slash');
    default:
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
  }
}

/** The latest dbt run: summary, then every node, slowest first. */
export class DbtLastRun implements vscode.TreeDataProvider<LastRunItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<LastRunItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sub: vscode.Disposable;
  view: vscode.TreeView<LastRunItem> | undefined;

  constructor(private readonly deps: LanguageDeps, private readonly store: RunStatusStore) {
    this.sub = store.onDidChange(() => this.changed.fire(undefined));
  }

  getTreeItem(item: LastRunItem): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: LastRunItem): Promise<LastRunItem[]> {
    if (item) {
      return [];
    }
    const last = this.store.lastRun;
    const summary = last ? runSummary(last.json) : undefined;
    void vscode.commands.executeCommand('setContext', 'dbtRunner.lastRunFailed', !!summary && summary.errors > 0);
    if (!last || !summary) {
      if (this.view) {
        this.view.message = 'No dbt run yet.';
        this.view.description = undefined;
      }
      return [];
    }
    if (this.view) {
      this.view.message = summary.text;
      this.view.description = `${summary.total} nodes`;
    }
    const index = await loadManifest(this.deps, last.root);
    return slowest(last.json).map(r => {
      const node = index?.nodes.get(r.uniqueId);
      const it = new LastRunItem(node?.name ?? r.uniqueId.split('.').slice(2).join('.'), r.uniqueId);
      it.description = `${r.status} · ${r.seconds.toFixed(1)}s`;
      it.iconPath = icon(r.status);
      it.tooltip = [`${node?.type ?? r.uniqueId.split('.')[0]} · ${r.status} · ${r.seconds.toFixed(2)}s`, r.message].filter(Boolean).join('\n');
      if (node?.file) {
        it.resourceUri = vscode.Uri.file(node.file);
        it.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(node.file), { preview: true }] };
      }
      return it;
    });
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}
