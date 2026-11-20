import * as vscode from 'vscode';
import * as fs from 'fs';
import { LanguageDeps, loadManifest } from './language';
import { ManifestIndex, NodeInfo, relatives, sourceTableLine } from './manifest';

type Dir = 'up' | 'down';

export class LineageItem extends vscode.TreeItem {
  constructor(
    label: string,
    readonly kind: 'focus' | 'branch' | 'node',
    readonly root: string,
    readonly node: NodeInfo,
    collapsible: vscode.TreeItemCollapsibleState,
    readonly dir?: Dir
  ) {
    super(label, collapsible);
  }
}

const ICONS: Record<string, string> = {
  model: 'symbol-class',
  seed: 'table',
  snapshot: 'history',
  source: 'database',
  exposure: 'graph',
  semantic_model: 'symbol-structure',
  other: 'circle-small'
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Line to open a node at. Only sources and exposures (entries in a YAML file) need reading; texts are cached per call. */
function lineOf(node: NodeInfo, texts: Map<string, string>): number {
  if (!node.file || (node.type !== 'source' && node.type !== 'exposure')) {
    return 0;
  }
  let text = texts.get(node.file);
  if (text === undefined) {
    try {
      text = fs.readFileSync(node.file, 'utf8');
    } catch {
      text = ''; // file moved since the last parse
    }
    texts.set(node.file, text);
  }
  if (node.type === 'source' && node.source && node.table) {
    return sourceTableLine(text, node.source, node.table);
  }
  const re = new RegExp(`^\\s*-\\s*name:\\s*['"]?${escapeRe(node.name)}['"]?\\s*$`);
  return Math.max(0, text.split(/\r?\n/).findIndex(l => re.test(l)));
}

// file (lower case) → node id, per parsed manifest.
const byFileCache = new WeakMap<ManifestIndex, Map<string, string>>();
function nodeIdForFile(index: ManifestIndex, file: string): string | undefined {
  let map = byFileCache.get(index);
  if (!map) {
    map = new Map();
    for (const n of index.nodes.values()) {
      if ((n.type === 'model' || n.type === 'seed' || n.type === 'snapshot') && n.file) {
        map.set(n.file.toLowerCase(), n.id);
      }
    }
    byFileCache.set(index, map);
  }
  return map.get(file.toLowerCase());
}

/** Upstream / downstream of the open model, or of a pinned node (any type), expandable level by level. */
export class DbtLineage implements vscode.TreeDataProvider<LineageItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<LineageItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private focus: { root: string; id: string } | undefined;
  private pinned = false;
  private timer: NodeJS.Timeout | undefined;
  view: vscode.TreeView<LineageItem> | undefined;

  constructor(private readonly deps: LanguageDeps) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/manifest.json');
    const later = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        // e.g. the first `dbt parse` after opening a model: pick up the open file now.
        if (!this.focus && !this.pinned) {
          void this.follow(vscode.window.activeTextEditor?.document.uri);
        }
        this.refresh();
      }, 300);
    };
    this.disposables.push(
      this.changed,
      watcher,
      watcher.onDidChange(later),
      watcher.onDidCreate(later),
      watcher.onDidDelete(later),
      vscode.window.onDidChangeActiveTextEditor(e => e && void this.follow(e.document.uri))
    );
  }

  /** The node lineage is shown for, if any. */
  get current(): { root: string; id: string; pinned: boolean } | undefined {
    return this.focus && { ...this.focus, pinned: this.pinned };
  }

  private async nodeForFile(file: string): Promise<{ root: string; id: string } | undefined> {
    const root = this.deps.projectRootOf(file);
    const index = root ? await loadManifest(this.deps, root) : undefined;
    if (!root || !index) {
      return undefined;
    }
    const id = nodeIdForFile(index, file);
    return id ? { root, id } : undefined;
  }

  /** Follow the active editor (ignored while pinned, or when the file isn't a model / seed / snapshot). */
  async follow(uri: vscode.Uri | undefined): Promise<void> {
    if (this.pinned || !uri || uri.scheme !== 'file') {
      return;
    }
    const found = await this.nodeForFile(uri.fsPath);
    // Re-check: the user may have pinned another model while this lookup was running.
    if (!this.pinned && found && (found.id !== this.focus?.id || found.root !== this.focus?.root)) {
      this.focus = found;
      this.refresh();
    }
  }

  /** Show lineage for this file and keep it, whatever editor is active. */
  async pin(uri: vscode.Uri): Promise<boolean> {
    const found = await this.nodeForFile(uri.fsPath);
    if (!found) {
      return false;
    }
    this.focus = found;
    this.pinned = true;
    this.refresh();
    return true;
  }

  /**
   * Show lineage for any node in the manifest — a source, an exposure, a semantic model, or a node listed in this
   * panel — and keep it. False when the node isn't in the project's manifest.
   */
  async pinNode(root: string, id: string): Promise<boolean> {
    const index = await loadManifest(this.deps, root);
    if (!index?.nodes.has(id)) {
      return false;
    }
    this.focus = { root, id };
    this.pinned = true;
    this.refresh();
    return true;
  }

  async unpin(): Promise<void> {
    this.pinned = false;
    this.refresh();
    await this.follow(vscode.window.activeTextEditor?.document.uri);
  }

  refresh(): void {
    void vscode.commands.executeCommand('setContext', 'dbtCommander.lineagePinned', this.pinned);
    this.changed.fire(undefined);
  }

  getTreeItem(item: LineageItem): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: LineageItem): Promise<LineageItem[]> {
    const focus = item ? { root: item.root } : this.focus;
    const index = focus ? await loadManifest(this.deps, focus.root) : undefined;
    if (!item) {
      const node = this.focus && index?.nodes.get(this.focus.id);
      let message = node ? undefined : 'Open a dbt model to see its upstream and downstream.';
      if (!node && this.pinned && index) {
        // The pinned node left the manifest (renamed / deleted): stop pinning so the editor is followed again.
        message = `${this.focus?.id.split('.').slice(2).join('.')} is no longer in the manifest. Open a dbt model to see its lineage.`;
        this.pinned = false;
        this.focus = undefined;
        void vscode.commands.executeCommand('setContext', 'dbtCommander.lineagePinned', false);
      }
      if (this.view) {
        this.view.message = message;
        this.view.description = node ? `${node.name}${this.pinned ? ' (pinned)' : ''}` : undefined;
      }
      return node ? [this.nodeItem(this.focus!.root, node, 'focus', index!, new Map())] : [];
    }
    if (!index) {
      return [];
    }
    if (item.kind === 'focus') {
      return (['up', 'down'] as Dir[]).map(dir => {
        const n = relatives(index, item.node.id, dir).length;
        const branch = new LineageItem(
          dir === 'up' ? 'Upstream' : 'Downstream',
          'branch',
          item.root,
          item.node,
          n ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
          dir
        );
        branch.description = n ? String(n) : 'none';
        branch.iconPath = new vscode.ThemeIcon(dir === 'up' ? 'arrow-up' : 'arrow-down');
        return branch;
      });
    }
    const texts = new Map<string, string>();
    return relatives(index, item.node.id, item.dir!).map(n => this.nodeItem(item.root, n, 'node', index, texts, item.dir));
  }

  private nodeItem(root: string, node: NodeInfo, kind: 'focus' | 'node', index: ManifestIndex, texts: Map<string, string>, dir?: Dir): LineageItem {
    const more = kind === 'focus' || (dir ? relatives(index, node.id, dir).length > 0 : false);
    const it = new LineageItem(
      node.name,
      kind,
      root,
      node,
      more ? (kind === 'focus' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None,
      dir
    );
    it.description = node.type === 'model' ? undefined : node.type;
    it.iconPath = new vscode.ThemeIcon(ICONS[node.type] ?? ICONS.other);
    // Build / Seed buttons only on the project's own .sql models and seeds: package nodes and Python models
    // can't be selected by the extension's path selectors.
    const own = node.package === (this.deps.projectNameOf(root) ?? '');
    const runnable = own && ((node.type === 'model' && /\.sql$/i.test(node.file ?? '')) || node.type === 'seed');
    it.contextValue = runnable ? `lineage-${node.type}` : `lineage-${node.type}-readonly`;
    if (node.file) {
      it.resourceUri = vscode.Uri.file(node.file);
      const line = lineOf(node, texts);
      it.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [vscode.Uri.file(node.file), { selection: new vscode.Range(line, 0, line, 0), preview: true }]
      };
      it.tooltip = `${node.type} · ${vscode.workspace.asRelativePath(node.file)}`;
    }
    return it;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}
