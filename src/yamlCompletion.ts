import * as vscode from 'vscode';
import * as path from 'path';
import { DbtCompletionProvider, LanguageDeps, inProjectPaths, loadManifest } from './language';
import { loadCatalog } from './hover';
import { completionContext } from './jinja';
import { ManifestIndex, resolveRef } from './manifest';
import { ColumnOwner } from './profile';
import { yamlContextAt } from './yamlcontext';
import { Suggestion, YamlData, columnOwnerOf, materializationsFrom, suggestionsFor } from './yamlcomplete';
import { legacyTestArguments } from './yamlfix';

export interface YamlCompletionDeps extends LanguageDeps {
  /** A YAML file of the project itself (not under its packages or target folder). */
  isProjectYaml(file: string): boolean;
  dbtVersion(): string | undefined;
}

const BUILT_IN_TESTS = new Set(['unique', 'not_null', 'accepted_values', 'relationships']);
/** Keys whose values come from the project (the rest need no manifest). */
const DATA_KEYS = new Set(['name', 'model', 'materialized']);

type BaseData = Omit<YamlData, 'columns' | 'legacyArguments'>;
const baseCache = new WeakMap<ManifestIndex, BaseData>();

const KINDS: Record<Suggestion['kind'], vscode.CompletionItemKind> = {
  key: vscode.CompletionItemKind.Property,
  value: vscode.CompletionItemKind.EnumMember,
  model: vscode.CompletionItemKind.Reference,
  column: vscode.CompletionItemKind.Field,
  test: vscode.CompletionItemKind.Function,
  name: vscode.CompletionItemKind.Value
};

/** Model / column / test / key / config-value suggestions in a dbt project's YAML files. */
export class DbtYamlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly deps: YamlCompletionDeps) {}

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[] | undefined> {
    const file = doc.uri.fsPath;
    const root = this.deps.projectRootOf(file);
    // Property files only: YAML in the resource folders dbt reads them from — not workflows, docker-compose,
    // profiles.yml, packages.yml or dbt_project.yml (whose `models:` is a different structure).
    if (
      !root ||
      !this.deps.isProjectYaml(file) ||
      path.basename(file).toLowerCase() === 'dbt_project.yml' ||
      !inProjectPaths(this.deps, file, ['model', 'seed', 'snapshot', 'macro', 'analysis', 'test'])
    ) {
      return undefined;
    }
    // ref('… / source('… in YAML (relationships `to:`, depends_on, unit tests): the SQL completion handles them.
    if (completionContext(doc.lineAt(pos.line).text.slice(0, pos.character))) {
      return new DbtCompletionProvider(this.deps).provideCompletionItems(doc, pos);
    }
    const ctx = yamlContextAt(doc.getText(), pos.line, pos.character);
    if (ctx.kind === 'other') {
      return undefined;
    }
    const inTests = /(^|\/)(data_tests|tests)\/-$/.test(ctx.path.join('/'));
    const needsData = inTests || (ctx.kind === 'value' && DATA_KEYS.has(ctx.key ?? ''));
    const index = needsData ? await loadManifest(this.deps, root) : undefined;
    const owner = columnOwnerOf(ctx);
    const data = await this.data(root, index, owner);
    const suggestions = suggestionsFor(ctx, data);
    // Insert at the cursor, or replace the whole word when the cursor is inside one (`desc|ription`).
    const lineText = doc.lineAt(pos.line).text;
    const end = pos.character + (/^[\w.-]*/.exec(lineText.slice(pos.character))?.[0].length ?? 0);
    const start = pos.character - ctx.word.length;
    const range = {
      inserting: new vscode.Range(pos.line, start, pos.line, pos.character),
      replacing: new vscode.Range(pos.line, start, pos.line, end)
    };
    const items = suggestions.map(s => {
      const it = new vscode.CompletionItem(s.label, KINDS[s.kind]);
      it.insertText = s.snippet ? new vscode.SnippetString(s.snippet) : s.label;
      it.range = range;
      it.sortText = `0dbt${String(s.rank).padStart(4, '0')}`; // ours first, in our order
      it.detail = s.detail ?? (s.kind === 'test' ? 'dbt test' : s.kind === 'key' ? 'dbt property' : undefined);
      return it;
    });
    return items;
  }

  /** The project's names for suggestions, computed once per parsed manifest. */
  private base(index: ManifestIndex | undefined, pkg: string): BaseData {
    const hit = index && baseCache.get(index);
    if (hit) {
      return hit;
    }
    const own = <T extends { package: string }>(list: T[] | undefined) => (list ?? []).filter(x => x.package === pkg);
    // Generic tests of the project and installed packages (not dbt's / the adapter's own).
    const generic = (index?.macros ?? [])
      .filter(m => m.test && m.package !== 'dbt' && !m.internal)
      .map(m => (m.package === pkg ? m.name.replace(/^test_/, '') : `${m.package}.${m.name.replace(/^test_/, '')}`))
      .filter(n => !BUILT_IN_TESTS.has(n));
    const base: BaseData = {
      models: [...new Set(own(index?.models).map(m => m.name))].map(name => ({ name, documented: !!index?.patches.has(name) })),
      seeds: own(index?.seeds).map(s => s.name),
      snapshots: own(index?.snapshots).map(s => s.name),
      macros: [...new Set(own(index?.macros).filter(m => !m.test).map(m => m.name))],
      genericTests: [...new Set(generic)].sort(),
      materializations: materializationsFrom((index?.macros ?? []).map(m => m.name), index?.adapterType)
    };
    if (index) {
      baseCache.set(index, base);
    }
    return base;
  }

  private async data(root: string, index: ManifestIndex | undefined, owner: ColumnOwner | undefined): Promise<YamlData> {
    const pkg = this.deps.projectNameOf(root) ?? path.basename(root);
    return {
      ...this.base(index, pkg),
      columns: owner && index ? await this.columns(root, index, owner, pkg) : [],
      legacyArguments: legacyTestArguments(this.deps.dbtVersion())
    };
  }

  /** The owner's columns: catalog.json (table order, with types) then any other documented ones. */
  private async columns(root: string, index: ManifestIndex, owner: ColumnOwner, pkg: string): Promise<{ name: string; dataType?: string }[]> {
    let uniqueId: string | undefined;
    let documented: { name: string; dataType?: string }[] = [];
    if (owner.kind === 'source') {
      const src = index.sources.find(s => s.source === owner.source && s.table === owner.name);
      uniqueId = src?.uniqueId;
      documented = src?.columns ?? [];
    } else if (owner.kind === 'model') {
      const model = resolveRef(index.models, owner.name, pkg);
      uniqueId = model?.uniqueId;
      documented = model?.columns ?? [];
    } else {
      uniqueId = (owner.kind === 'seed' ? index.seeds : index.snapshots).find(n => n.name === owner.name && n.package === pkg)?.uniqueId;
    }
    const catalog = uniqueId ? (await loadCatalog(this.deps, root))?.get(uniqueId) ?? [] : [];
    const seen = new Set<string>();
    return [...catalog, ...documented].filter(c => !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase()));
  }
}
