import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { callAt, completionContext, macroCallAt } from './jinja';
import { DbtHoverProvider, loadCatalog } from './hover';
import { aliasBefore, aliasesIn, refLines } from './columns';
import { columnsFor } from './runresults';
import { ManifestIndex, macroDefinitionLine, parseManifest, resolveMacro, resolveRef, sourceTableLine } from './manifest';
import { ProjectPaths } from './projectconfig';

export interface LanguageDeps {
  projectRootOf(file: string): string | undefined;
  targetDirOf(root: string): string;
  projectNameOf(root: string): string | undefined;
  /** `<venv>/.../site-packages/dbt/include`, where dbt's own and adapter macros live. */
  dbtIncludeDir(): string | undefined;
  /** Configured resource folders, packages and target path (dbt_project.yml, with dbt defaults). */
  pathsOf(root: string): ProjectPaths;
  /** dbt projects in the workspace (installed packages excluded). */
  projectRoots?(): Promise<string[]>;
}

type PathKind = 'model' | 'seed' | 'snapshot' | 'analysis' | 'macro' | 'test';

/** Whether `file` lies in one of the project's configured folders of these kinds (e.g. model-paths). */
export function inProjectPaths(deps: LanguageDeps, file: string, kinds: PathKind[]): boolean {
  const root = deps.projectRootOf(file);
  if (!root) {
    return false;
  }
  // Windows paths are case-insensitive: `Transform` in dbt_project.yml matches a `transform` folder.
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = fold(path.relative(root, file).split(path.sep).join('/'));
  if (rel.startsWith('..')) {
    return false;
  }
  const paths = deps.pathsOf(root);
  if ([paths.packagesInstall, paths.target].map(fold).some(d => rel === d || rel.startsWith(d + '/'))) {
    return false;
  }
  return kinds.some(k => paths[k].map(fold).some(d => rel.startsWith(d + '/')));
}

// Parsed manifests by file, re-read only when the file's mtime changes. Reads are async so a large
// manifest doesn't block typing; concurrent requests share one in-flight read.
const cache = new Map<string, { mtime: number; index: Promise<ManifestIndex | undefined> }>();

export function clearManifestCache(): void {
  cache.clear();
}

export async function loadManifest(deps: LanguageDeps, root: string): Promise<ManifestIndex | undefined> {
  const file = path.join(deps.targetDirOf(root), 'manifest.json');
  let mtime: number;
  try {
    mtime = (await fs.promises.stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) {
    return hit.index;
  }
  const index = fs.promises
    .readFile(file, 'utf8')
    .then(text =>
      parseManifest(text, root, deps.projectNameOf(root) ?? path.basename(root), deps.dbtIncludeDir(), p => fs.existsSync(p), deps.pathsOf(root).packagesInstall)
    )
    .catch(() => undefined)
    .then(result => {
      // A half-written manifest (dbt still writing) must not stay cached as "no manifest": retry next time.
      if (!result && cache.get(file)?.index === index) {
        cache.delete(file);
      }
      return result;
    });
  cache.set(file, { mtime, index });
  return index;
}

class DbtDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly deps: LanguageDeps) {}

  async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Location | undefined> {
    const lineText = doc.lineAt(pos.line).text;
    const call = callAt(lineText, pos.character);
    if (!call) {
      return this.macroDefinition(doc, lineText, pos.character);
    }
    const root = this.deps.projectRootOf(doc.uri.fsPath);
    if (!root) {
      return undefined;
    }
    const index = await loadManifest(this.deps, root);
    if (call.kind === 'ref') {
      const model = index && resolveRef(index.models, call.name, call.package, call.version);
      if (model && fs.existsSync(model.file)) {
        return new vscode.Location(vscode.Uri.file(model.file), new vscode.Position(0, 0));
      }
      // No manifest (or stale): fall back to a model file with that name in this project's models.
      // A package-qualified ref can't be resolved by file name, so don't guess.
      if (call.package) {
        return undefined;
      }
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, `**/${call.name}.sql`),
        '**/{dbt_packages,target,node_modules}/**',
        20
      );
      const hit = found.find(u => inProjectPaths(this.deps, u.fsPath, ['model']));
      return hit ? new vscode.Location(hit, new vscode.Position(0, 0)) : undefined;
    }
    const src = index?.sources.find(s => s.source === call.source && s.table === call.table);
    if (!src || !fs.existsSync(src.file)) {
      return undefined;
    }
    const line = sourceTableLine(await fs.promises.readFile(src.file, 'utf8'), call.source, call.table);
    return new vscode.Location(vscode.Uri.file(src.file), new vscode.Position(line, 0));
  }

  private async macroDefinition(doc: vscode.TextDocument, lineText: string, col: number): Promise<vscode.Location | undefined> {
    const call = macroCallAt(lineText, col);
    const root = call && this.deps.projectRootOf(doc.uri.fsPath);
    const index = root ? await loadManifest(this.deps, root) : undefined;
    if (!call || !root || !index) {
      return undefined;
    }
    const macro = resolveMacro(index.macros, call.name, call.package, this.deps.projectNameOf(root) ?? path.basename(root));
    if (!macro?.file || !fs.existsSync(macro.file)) {
      return undefined;
    }
    const line = macroDefinitionLine(await fs.promises.readFile(macro.file, 'utf8'), call.name);
    return new vscode.Location(vscode.Uri.file(macro.file), new vscode.Position(line, 0));
  }
}

export class DbtCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly deps: LanguageDeps) {}

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    const ctx = completionContext(before);
    if (!ctx) {
      return this.columnCompletions(doc, pos, before);
    }
    const root = this.deps.projectRootOf(doc.uri.fsPath);
    const index = root ? await loadManifest(this.deps, root) : undefined;
    if (!root || !index) {
      return undefined;
    }
    const word = /[\w.-]*$/.exec(before)?.[0] ?? '';
    const range = new vscode.Range(pos.line, pos.character - word.length, pos.line, pos.character);
    const item = (label: string, kind: vscode.CompletionItemKind, detail: string, file: string) => {
      const ci = new vscode.CompletionItem(label, kind);
      ci.detail = detail;
      ci.documentation = path.relative(root, file);
      ci.range = range;
      return ci;
    };
    if (ctx.kind === 'ref') {
      const seen = new Set<string>();
      return index.models
        .filter(m => !seen.has(m.name) && seen.add(m.name))
        .map(m => item(m.name, vscode.CompletionItemKind.Reference, `model · ${m.package}`, m.file));
    }
    if (ctx.kind === 'sourceName') {
      const seen = new Set<string>();
      return index.sources
        .filter(s => !seen.has(s.source) && seen.add(s.source))
        .map(s => item(s.source, vscode.CompletionItemKind.Module, 'source', s.file));
    }
    return index.sources
      .filter(s => s.source === ctx.source)
      .map(s => item(s.table, vscode.CompletionItemKind.Field, `source table · ${s.source}`, s.file));
  }

  /** `o.` after `from {{ ref('orders') }} o`: the model's (or source's) columns. */
  private async columnCompletions(doc: vscode.TextDocument, pos: vscode.Position, before: string): Promise<vscode.CompletionItem[] | undefined> {
    const alias = aliasBefore(before);
    // Not inside a string literal ('a.b'): an odd number of quotes before the cursor on this line.
    const inString = ((before.match(/'/g) ?? []).length % 2) === 1;
    const call = alias && !inString ? aliasesIn(doc.getText()).get(alias.toLowerCase()) : undefined;
    const root = call && this.deps.projectRootOf(doc.uri.fsPath);
    const index = root ? await loadManifest(this.deps, root) : undefined;
    if (!call || !root || !index) {
      return undefined;
    }
    const entity =
      call.kind === 'ref'
        ? resolveRef(index.models, call.name, call.package, call.version)
        : index.sources.find(s => s.source === call.source && s.table === call.table);
    if (!entity) {
      return undefined;
    }
    const catalog = await loadCatalog(this.deps, root);
    const typed = /\w*$/.exec(before)?.[0] ?? '';
    const range = new vscode.Range(pos.line, pos.character - typed.length, pos.line, pos.character);
    const owner = 'name' in entity ? entity.name : `${entity.source}.${entity.table}`;
    return columnsFor(entity.columns, catalog?.get(entity.uniqueId)).map((c, i) => {
      const ci = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Field);
      ci.detail = [c.dataType, owner].filter(Boolean).join(' · ');
      if (c.description) {
        ci.documentation = c.description;
      }
      ci.sortText = String(i).padStart(5, '0'); // table order
      ci.range = range;
      return ci;
    });
  }
}

/** Where the CodeLens gets a model's last run result from (the run-state store). */
export interface RunStatusSource {
  badge(root: string, uniqueId: string): string | undefined;
  readonly onDidChange: vscode.Event<void>;
}

class DbtCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly deps: LanguageDeps, private readonly status?: RunStatusSource) {
    status?.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.changed.fire();
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const p = doc.uri.fsPath;
    if (
      !vscode.workspace.getConfiguration('dbtCommander').get<boolean>('codeLens', true) ||
      doc.uri.scheme !== 'file' ||
      !/\.sql$/i.test(p) ||
      !inProjectPaths(this.deps, p, ['model'])
    ) {
      return [];
    }
    const range = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      ['$(play) Run', 'dbtCommander.run'],
      ['Build', 'dbtCommander.build'],
      ['Test', 'dbtCommander.test'],
      ['Compile', 'dbtCommander.compile'],
      ['Preview', 'dbtCommander.preview']
    ].map(([title, command]) => new vscode.CodeLens(range, { title, command, arguments: [doc.uri], tooltip: `dbt ${title.replace('$(play) ', '').toLowerCase()} this model` }));
    // The model's last result, e.g. "✓ 3m ago · 1.2s", as the first (non-clickable) lens.
    const root = this.deps.projectRootOf(p);
    const model = root ? (await loadManifest(this.deps, root))?.models.find(m => m.file.toLowerCase() === p.toLowerCase()) : undefined;
    const badge = root && model ? this.status?.badge(root, model.uniqueId) : undefined;
    if (badge) {
      lenses.unshift(new vscode.CodeLens(range, { title: badge, command: '', tooltip: 'Last dbt result for this model' }));
    }
    return lenses;
  }
}

/** Shift+F12: the models / snapshots / analyses that ref() a model, at the ref() line. */
class DbtReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly deps: LanguageDeps) {}

  async provideReferences(doc: vscode.TextDocument, pos: vscode.Position, context: vscode.ReferenceContext): Promise<vscode.Location[] | undefined> {
    const root = this.deps.projectRootOf(doc.uri.fsPath);
    const index = root ? await loadManifest(this.deps, root) : undefined;
    if (!root || !index) {
      return undefined;
    }
    // On a ref('x') call: references to x. Elsewhere in a model file: references to that model.
    const call = callAt(doc.lineAt(pos.line).text, pos.character);
    const model =
      call?.kind === 'ref'
        ? resolveRef(index.models, call.name, call.package, call.version)
        : index.models.find(m => m.file.toLowerCase() === doc.uri.fsPath.toLowerCase());
    if (!model) {
      return undefined;
    }
    const out: vscode.Location[] = [];
    if (context.includeDeclaration) {
      out.push(new vscode.Location(vscode.Uri.file(model.file), new vscode.Position(0, 0)));
    }
    for (const id of index.children.get(model.uniqueId) ?? []) {
      const child = index.nodes.get(id);
      // Models (.sql and Python `dbt.ref()`), snapshots, analyses and singular tests; generic tests live in
      // YAML and are reported by the YAML file's own `ref()` lines (e.g. relationships `to: ref('x')`).
      if (!child?.file || !/\.(sql|py)$/i.test(child.file)) {
        continue;
      }
      let text: string;
      try {
        text = await fs.promises.readFile(child.file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (const line of refLines(text, model.name)) {
        out.push(new vscode.Location(vscode.Uri.file(child.file), new vscode.Range(line, 0, line, lines[line].length)));
      }
    }
    return out;
  }
}

export function registerLanguageFeatures(ctx: vscode.ExtensionContext, deps: LanguageDeps, status?: RunStatusSource): void {
  const selector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'sql' },
    { scheme: 'file', language: 'jinja-sql' },
    { scheme: 'file', pattern: '**/*.sql' }
  ];
  const lenses = new DbtCodeLensProvider(deps, status);
  const scratch: vscode.DocumentFilter[] = [{ scheme: 'untitled', language: 'sql' }, { scheme: 'untitled', language: 'jinja-sql' }];
  ctx.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: (doc, pos) =>
        inProjectPaths(deps, doc.uri.fsPath, ['model', 'macro', 'test', 'snapshot', 'analysis'])
          ? new DbtDefinitionProvider(deps).provideDefinition(doc, pos)
          : undefined
    }),
    // Scratchpads (untitled dbt-scratch-N.sql) get completion and hovers too.
    vscode.languages.registerCompletionItemProvider([...selector, ...scratch], new DbtCompletionProvider(deps), "'", '"', '.'),
    vscode.languages.registerCodeLensProvider(selector, lenses),
    vscode.languages.registerHoverProvider([...selector, ...scratch], new DbtHoverProvider(deps)),
    vscode.languages.registerReferenceProvider(selector, new DbtReferenceProvider(deps)),
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('dbtCommander.codeLens') && lenses.refresh())
  );
}
