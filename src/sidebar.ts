import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LanguageDeps, loadManifest } from './language';
import { ManifestIndex, sourceTableLine } from './manifest';

export type ItemKind =
  | 'project'
  | 'section'
  | 'modelFolder'
  | 'model'
  | 'source'
  | 'sourceTable'
  | 'seed'
  | 'snapshot'
  | 'testGroup'
  | 'test'
  | 'noManifest';

type Section = 'models' | 'sources' | 'seeds' | 'snapshots' | 'tests';

export class DbtItem extends vscode.TreeItem {
  constructor(
    label: string,
    readonly kind: ItemKind,
    readonly root: string,
    collapsible: vscode.TreeItemCollapsibleState,
    readonly data: { section?: Section; dir?: string; source?: string; model?: string; name?: string } = {}
  ) {
    super(label, collapsible);
    this.contextValue = kind;
  }
}

const None = vscode.TreeItemCollapsibleState.None;
const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
const Expanded = vscode.TreeItemCollapsibleState.Expanded;

function openCommand(file: string, line = 0): vscode.Command {
  return {
    command: 'vscode.open',
    title: 'Open',
    arguments: [vscode.Uri.file(file), { selection: new vscode.Range(line, 0, line, 0), preview: true }]
  };
}

/** The dbt project tree: Models (by folder) · Sources · Seeds · Snapshots · Tests (by model). */
export class DbtSidebar implements vscode.TreeDataProvider<DbtItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<DbtItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: LanguageDeps) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/manifest.json');
    const later = () => this.refreshSoon();
    this.disposables.push(watcher, watcher.onDidChange(later), watcher.onDidCreate(later), watcher.onDidDelete(later), this.changed);
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  private refreshSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 300);
  }

  getTreeItem(item: DbtItem): vscode.TreeItem {
    return item;
  }

  async getChildren(item?: DbtItem): Promise<DbtItem[]> {
    if (!item) {
      const roots = await this.projectRoots();
      if (roots.length === 1) {
        return this.sections(roots[0]);
      }
      return roots.map(r => {
        const it = new DbtItem(this.deps.projectNameOf(r) ?? path.basename(r), 'project', r, Expanded);
        it.description = vscode.workspace.asRelativePath(r);
        it.iconPath = new vscode.ThemeIcon('project');
        return it;
      });
    }
    const index = await loadManifest(this.deps, item.root);
    switch (item.kind) {
      case 'project':
        return this.sections(item.root);
      case 'section':
        return index ? this.sectionChildren(item, index) : [];
      case 'modelFolder':
        return index ? this.modelLevel(item.root, index, item.data.dir!) : [];
      case 'source':
        return index ? this.sourceTables(item.root, index, item.data.source!) : [];
      case 'testGroup':
        return index ? this.testsFor(item.root, index, item.data.model) : [];
      default:
        return [];
    }
  }

  private async projectRoots(): Promise<string[]> {
    const found = await vscode.workspace.findFiles('**/dbt_project.yml', '**/{dbt_packages,target,node_modules,.venv,venv,.vscode-test}/**', 50);
    return [...new Set(found.map(u => path.dirname(u.fsPath)))].sort();
  }

  private async sections(root: string): Promise<DbtItem[]> {
    const index = await loadManifest(this.deps, root);
    if (!index) {
      const it = new DbtItem('No manifest yet — click to run dbt parse', 'noManifest', root, None);
      it.iconPath = new vscode.ThemeIcon('info');
      it.command = { command: 'dbtRunner.parse', title: 'dbt parse', arguments: [it] };
      return [it];
    }
    const pkg = this.rootPackage(root);
    const counts: [Section, string, number, string][] = [
      ['models', 'Models', index.models.filter(m => m.package === pkg).length, 'symbol-class'],
      ['sources', 'Sources', new Set(index.sources.filter(s => s.package === pkg).map(s => s.source)).size, 'database'],
      ['seeds', 'Seeds', index.seeds.length, 'table'],
      ['snapshots', 'Snapshots', index.snapshots.length, 'history'],
      ['tests', 'Tests', index.tests.length, 'beaker']
    ];
    return counts
      .filter(([, , n]) => n > 0)
      .map(([section, label, n, icon]) => {
        const it = new DbtItem(label, 'section', root, section === 'models' ? Expanded : Collapsed, { section });
        it.description = String(n);
        it.iconPath = new vscode.ThemeIcon(icon);
        return it;
      });
  }

  private rootPackage(root: string): string {
    return this.deps.projectNameOf(root) ?? path.basename(root);
  }

  private sectionChildren(item: DbtItem, index: ManifestIndex): DbtItem[] {
    const root = item.root;
    const pkg = this.rootPackage(root);
    switch (item.data.section) {
      case 'models':
        return this.modelLevel(root, index, '');
      case 'sources':
        return [...new Set(index.sources.filter(s => s.package === pkg).map(s => s.source))].sort().map(source => {
          const it = new DbtItem(source, 'source', root, Collapsed, { source });
          it.iconPath = new vscode.ThemeIcon('database');
          return it;
        });
      case 'seeds':
        return this.leaves(root, index.seeds, 'seed', 'table');
      case 'snapshots':
        return this.leaves(root, index.snapshots, 'snapshot', 'history');
      case 'tests': {
        const models = [...new Set(index.tests.map(t => t.attachedTo ?? ''))].sort();
        return models.map(model => {
          const n = index.tests.filter(t => (t.attachedTo ?? '') === model).length;
          const it = new DbtItem(model || '(singular tests)', 'testGroup', root, Collapsed, { model: model || undefined });
          it.description = String(n);
          it.iconPath = new vscode.ThemeIcon(model ? 'symbol-class' : 'beaker');
          return it;
        });
      }
      default:
        return [];
    }
  }

  /** Folders, then models, directly inside `dir` (relative to the project root, '' = top). */
  private modelLevel(root: string, index: ManifestIndex, dir: string): DbtItem[] {
    const pkg = this.rootPackage(root);
    const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
    const models = index.models.filter(m => m.package === pkg);
    const prefix = dir ? dir + '/' : '';
    const folders = new Set<string>();
    const here: DbtItem[] = [];
    for (const m of models) {
      const r = rel(m.file);
      if (!r.startsWith(prefix)) {
        continue;
      }
      const rest = r.slice(prefix.length);
      if (rest.includes('/')) {
        folders.add(rest.split('/')[0]);
      } else {
        const it = new DbtItem(m.name, 'model', root, None, { name: m.name });
        it.resourceUri = vscode.Uri.file(m.file);
        it.iconPath = new vscode.ThemeIcon('symbol-class');
        it.command = openCommand(m.file);
        it.tooltip = rel(m.file);
        here.push(it);
      }
    }
    const folderItems = [...folders].sort().map(f => {
      const d = prefix + f;
      const it = new DbtItem(f, 'modelFolder', root, dir ? Collapsed : Expanded, { dir: d });
      it.resourceUri = vscode.Uri.file(path.join(root, ...d.split('/')));
      it.iconPath = vscode.ThemeIcon.Folder;
      return it;
    });
    // At the top level the only folder is usually "models"; skip straight into it.
    if (!dir && folderItems.length === 1 && here.length === 0) {
      return this.modelLevel(root, index, folderItems[0].data.dir!);
    }
    return [...folderItems, ...here.sort((a, b) => String(a.label).localeCompare(String(b.label)))];
  }

  private sourceTables(root: string, index: ManifestIndex, source: string): DbtItem[] {
    return index.sources
      .filter(s => s.source === source && s.package === this.rootPackage(root))
      .sort((a, b) => a.table.localeCompare(b.table))
      .map(s => {
        const it = new DbtItem(s.table, 'sourceTable', root, None, { source, name: s.table });
        it.iconPath = new vscode.ThemeIcon('symbol-field');
        let line = 0;
        try {
          line = sourceTableLine(fs.readFileSync(s.file, 'utf8'), source, s.table);
        } catch {
          // file moved since the last parse
        }
        it.command = openCommand(s.file, line);
        it.tooltip = `source('${source}', '${s.table}')`;
        return it;
      });
  }

  private leaves(root: string, nodes: { name: string; file: string }[], kind: ItemKind, icon: string): DbtItem[] {
    return [...nodes]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(n => {
        const it = new DbtItem(n.name, kind, root, None, { name: n.name });
        it.resourceUri = vscode.Uri.file(n.file);
        it.iconPath = new vscode.ThemeIcon(icon);
        it.command = openCommand(n.file);
        it.tooltip = path.relative(root, n.file);
        return it;
      });
  }

  private testsFor(root: string, index: ManifestIndex, model: string | undefined): DbtItem[] {
    return this.leaves(
      root,
      index.tests.filter(t => t.attachedTo === model),
      'test',
      'beaker'
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach(d => d.dispose());
  }
}
