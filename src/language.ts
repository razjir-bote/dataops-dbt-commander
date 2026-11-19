import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { callAt, completionContext } from './jinja';
import { ManifestIndex, parseManifest, resolveRef, sourceTableLine } from './manifest';

export interface LanguageDeps {
  projectRootOf(file: string): string | undefined;
  targetDirOf(root: string): string;
  projectNameOf(root: string): string | undefined;
}

const DBT_SQL_DIRS = /[\\/](models|macros|tests|snapshots|analyses)[\\/]/i;
const MODEL_FILE = /[\\/]models[\\/]/i;
const EXCLUDED = /[\\/](dbt_packages|target)[\\/]/i;

// Parsed manifests by file, re-read only when the file's mtime changes. Reads are async so a large
// manifest doesn't block typing; concurrent requests share one in-flight read.
const cache = new Map<string, { mtime: number; index: Promise<ManifestIndex | undefined> }>();

async function loadManifest(deps: LanguageDeps, root: string): Promise<ManifestIndex | undefined> {
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
    .then(text => parseManifest(text, root, deps.projectNameOf(root) ?? path.basename(root)))
    .catch(() => undefined);
  cache.set(file, { mtime, index });
  return index;
}

class DbtDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly deps: LanguageDeps) {}

  async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Location | undefined> {
    const call = callAt(doc.lineAt(pos.line).text, pos.character);
    const root = call && this.deps.projectRootOf(doc.uri.fsPath);
    if (!call || !root) {
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
      const hit = found.find(u => MODEL_FILE.test(u.fsPath));
      return hit ? new vscode.Location(hit, new vscode.Position(0, 0)) : undefined;
    }
    const src = index?.sources.find(s => s.source === call.source && s.table === call.table);
    if (!src || !fs.existsSync(src.file)) {
      return undefined;
    }
    const line = sourceTableLine(await fs.promises.readFile(src.file, 'utf8'), call.source, call.table);
    return new vscode.Location(vscode.Uri.file(src.file), new vscode.Position(line, 0));
  }
}

class DbtCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly deps: LanguageDeps) {}

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    const ctx = completionContext(before);
    const root = ctx && this.deps.projectRootOf(doc.uri.fsPath);
    const index = root ? await loadManifest(this.deps, root) : undefined;
    if (!ctx || !root || !index) {
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
}

class DbtCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const p = doc.uri.fsPath;
    if (
      !vscode.workspace.getConfiguration('dbtRunner').get<boolean>('codeLens', true) ||
      doc.uri.scheme !== 'file' ||
      !/\.sql$/i.test(p) ||
      !MODEL_FILE.test(p) ||
      EXCLUDED.test(p)
    ) {
      return [];
    }
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      ['$(play) Run', 'dbtRunner.run'],
      ['Build', 'dbtRunner.build'],
      ['Test', 'dbtRunner.test'],
      ['Compile', 'dbtRunner.compile'],
      ['Preview', 'dbtRunner.preview']
    ].map(([title, command]) => new vscode.CodeLens(range, { title, command, arguments: [doc.uri], tooltip: `dbt ${title.replace('$(play) ', '').toLowerCase()} this model` }));
  }
}

export function registerLanguageFeatures(ctx: vscode.ExtensionContext, deps: LanguageDeps): void {
  const selector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'sql' },
    { scheme: 'file', language: 'jinja-sql' },
    { scheme: 'file', pattern: '**/*.sql' }
  ];
  const lenses = new DbtCodeLensProvider();
  ctx.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: (doc, pos) => (DBT_SQL_DIRS.test(doc.uri.fsPath) ? new DbtDefinitionProvider(deps).provideDefinition(doc, pos) : undefined)
    }),
    vscode.languages.registerCompletionItemProvider(selector, new DbtCompletionProvider(deps), "'", '"'),
    vscode.languages.registerCodeLensProvider(selector, lenses),
    vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('dbtRunner.codeLens') && lenses.refresh())
  );
}
