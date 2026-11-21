import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LanguageDeps, RunStatusSource, loadManifest } from './language';
import { ManifestIndex, sourceTableLine } from './manifest';
import { levelOf, sectionTargets } from './tree';

export type ItemKind =
  | 'project'
  | 'section'
  | 'modelFolder'
  | 'model'
  | 'source'
  | 'sourceTable'
  | 'seed'
  | 'seedFolder'
  | 'snapshot'
  | 'testGroup'
  | 'test'
  | 'exposure'
  | 'semanticModel'
  | 'noManifest';

type Section = 'models' | 'sources' | 'seeds' | 'snapshots' | 'tests' | 'exposures' | 'semanticModels';

export class DbtItem extends vscode.TreeItem {
  constructor(
    label: string,
    readonly kind: ItemKind,
    readonly root: string,
    collapsible: vscode.TreeItemCollapsibleState,
    readonly data: { section?: Section; dir?: string; source?: string; model?: string; name?: string; targets?: string[]; uniqueId?: string } = {}
  ) {
    super(label, collapsible);
    this.contextValue = kind;
  }
}

const None = vscode.TreeItemCollapsibleState.None;
const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
const Expanded = vscode.TreeItemCollapsibleState.Expanded;

/** 0-based line of `- name: <name>` in a YAML file (0 if not found). */
function yamlEntryLine(file: string, name: string): number {
  try {
    const re = new RegExp(`^\\s*-\\s*name:\\s*['"]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`);
    return Math.max(0, fs.readFileSync(file, 'utf8').split(/\r?\n/).findIndex(l => re.test(l)));
  } catch {
    return 0;
  }
}

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

  constructor(private readonly deps: LanguageDeps, private readonly status?: RunStatusSource) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/manifest.json');
    const later = () => this.refreshSoon();
    this.disposables.push(watcher, watcher.onDidChange(later), watcher.onDidCreate(later), watcher.onDidDelete(later), this.changed);
    if (status) {
      this.disposables.push(status.onDidChange(later)); // last-run badges
    }
  }

  /** "✓ 3m ago · 1.2s" etc. for a node, if it has run. */
  private badge(root: string, uniqueId: string): string | undefined {
    return this.status?.badge(root, uniqueId);
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
        it.resourceUri = vscode.Uri.file(r); // Build / Seed on the project = whole project
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
        return index ? this.folderLevel(item.root, index, 'model', item.data.dir!) : [];
      case 'seedFolder':
        return index ? this.folderLevel(item.root, index, 'seed', item.data.dir!) : [];
      case 'source':
        return index ? this.sourceTables(item.root, index, item.data.source!) : [];
      case 'testGroup':
        return index ? this.testsFor(item.root, index, item.data.model) : [];
      default:
        return [];
    }
  }

  private async projectRoots(): Promise<string[]> {
    return (await this.deps.projectRoots?.()) ?? [];
  }

  private async sections(root: string): Promise<DbtItem[]> {
    const index = await loadManifest(this.deps, root);
    if (!index) {
      const it = new DbtItem('No manifest yet — click to run dbt parse', 'noManifest', root, None);
      it.iconPath = new vscode.ThemeIcon('info');
      it.command = { command: 'dbtCommander.parse', title: 'dbt parse', arguments: [it] };
      return [it];
    }
    const pkg = this.rootPackage(root);
    const counts: [Section, string, number, string][] = [
      ['models', 'Models', index.models.filter(m => m.package === pkg).length, 'symbol-class'],
      ['sources', 'Sources', new Set(index.sources.filter(s => s.package === pkg).map(s => s.source)).size, 'database'],
      ['seeds', 'Seeds', index.seeds.length, 'table'],
      ['snapshots', 'Snapshots', index.snapshots.length, 'history'],
      ['tests', 'Tests', index.tests.length, 'beaker'],
      ['exposures', 'Exposures', index.exposures.length, 'graph'],
      ['semanticModels', 'Semantic models', index.semanticModels.length, 'symbol-structure']
    ];
    return counts
      .filter(([, , n]) => n > 0)
      .map(([section, label, n, icon]) => {
        const it = new DbtItem(label, 'section', root, section === 'models' ? Expanded : Collapsed, { section });
        it.description = String(n);
        it.iconPath = new vscode.ThemeIcon(icon);
        // Section buttons act on the section's folder (models/, seeds/), or the whole project.
        it.contextValue = `section-${section}`;
        if (section === 'models' || section === 'seeds') {
          // Usually models/ or seeds/; with several top-level folders, each of them (never the whole project).
          const targets = sectionTargets(root, this.entries(root, index, section === 'models' ? 'model' : 'seed').map(e => e.file));
          it.data.targets = targets;
          it.resourceUri = vscode.Uri.file(targets[0] ?? root);
        } else {
          it.resourceUri = vscode.Uri.file(root);
        }
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
        return this.folderLevel(root, index, 'model', '');
      case 'sources':
        return [...new Set(index.sources.filter(s => s.package === pkg).map(s => s.source))].sort().map(source => {
          const it = new DbtItem(source, 'source', root, Collapsed, { source });
          it.iconPath = new vscode.ThemeIcon('database');
          return it;
        });
      case 'seeds':
        return this.folderLevel(root, index, 'seed', '');
      case 'snapshots':
        return this.leaves(root, index.snapshots, 'snapshot', 'history');
      case 'exposures':
        return this.leaves(root, index.exposures, 'exposure', 'graph');
      case 'semanticModels':
        return this.leaves(root, index.semanticModels, 'semanticModel', 'symbol-structure');
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

  /** The project's own models or seeds, as {name, file}. */
  private entries(root: string, index: ManifestIndex, kind: 'model' | 'seed'): { name: string; file: string; uniqueId: string }[] {
    const pkg = this.rootPackage(root);
    return kind === 'model' ? index.models.filter(m => m.package === pkg) : index.seeds;
  }

  /**
   * The folder a section stands for: its single top-level folder (usually `models/` or `seeds/`, which the tree
   * skips straight into), else the project folder itself (= everything).
   */
  private topDir(root: string, files: string[]): string {
    let dir = '';
    for (;;) {
      const level = levelOf(root, files, dir);
      if (level.folders.length !== 1 || level.files.length || dir) {
        return dir;
      }
      dir = level.folders[0];
    }
  }

  /** Folders, then models / seeds, directly inside `dir` (relative to the project root, '' = top). */
  private folderLevel(root: string, index: ManifestIndex, kind: 'model' | 'seed', dir: string): DbtItem[] {
    const entries = this.entries(root, index, kind);
    const start = dir || this.topDir(root, entries.map(e => e.file));
    const level = levelOf(root, entries.map(e => e.file), start);
    const byFile = new Map(entries.map(e => [e.file, e]));
    const folders = level.folders.map(f => {
      const d = start ? `${start}/${f}` : f;
      const it = new DbtItem(f, kind === 'model' ? 'modelFolder' : 'seedFolder', root, dir ? Collapsed : Expanded, { dir: d });
      it.resourceUri = vscode.Uri.file(path.join(root, ...d.split('/')));
      it.iconPath = vscode.ThemeIcon.Folder;
      return it;
    });
    const leaves = level.files
      .map(f => byFile.get(f)!)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => {
        const it = new DbtItem(e.name, kind, root, None, { name: e.name });
        if (kind === 'model' && /^stg_/i.test(e.name)) {
          it.contextValue = 'model-stg'; // staging models also offer "Create SCD2 change-key model"
        }
        it.description = this.badge(root, e.uniqueId);
        it.resourceUri = vscode.Uri.file(e.file);
        it.iconPath = new vscode.ThemeIcon(kind === 'model' ? 'symbol-class' : 'table');
        it.command = openCommand(e.file);
        it.tooltip = path.relative(root, e.file);
        return it;
      });
    return [...folders, ...leaves];
  }

  private sourceTables(root: string, index: ManifestIndex, source: string): DbtItem[] {
    return index.sources
      .filter(s => s.source === source && s.package === this.rootPackage(root))
      .sort((a, b) => a.table.localeCompare(b.table))
      .map(s => {
        const it = new DbtItem(s.table, 'sourceTable', root, None, { source, name: s.table, uniqueId: s.uniqueId });
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

  private leaves(root: string, nodes: { name: string; file: string; uniqueId: string }[], kind: ItemKind, icon: string): DbtItem[] {
    return [...nodes]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(n => {
        const it = new DbtItem(n.name, kind, root, None, { name: n.name, uniqueId: n.uniqueId });
        it.description = this.badge(root, n.uniqueId);
        it.resourceUri = vscode.Uri.file(n.file);
        it.iconPath = new vscode.ThemeIcon(icon);
        // YAML-defined nodes open at their `- name:` entry.
        it.command = openCommand(n.file, /\.ya?ml$/i.test(n.file) ? yamlEntryLine(n.file, n.name) : 0);
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
