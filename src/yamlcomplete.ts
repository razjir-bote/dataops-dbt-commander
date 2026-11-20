import { YamlContext } from './yamlcontext';
import { ColumnOwner } from './profile';

/** What the project offers for suggestions (from the manifest and catalog). */
export interface YamlData {
  /** The project's models; `documented`: already has a YAML entry. */
  models: { name: string; documented: boolean }[];
  seeds: string[];
  snapshots: string[];
  macros: string[];
  /** Generic tests from the project (`positive_value`) and packages (`dbt_utils.expression_is_true`). */
  genericTests: string[];
  materializations: string[];
  /** Columns of the entry the cursor is in (when completing a column name). */
  columns: { name: string; dataType?: string }[];
  /** dbt before 1.10 (or unknown): test arguments at the top level, not under `arguments:`. */
  legacyArguments: boolean;
}

export interface Suggestion {
  label: string;
  kind: 'key' | 'value' | 'model' | 'column' | 'test' | 'name';
  detail?: string;
  /** VS Code snippet text to insert (default: the label, or `label: ` for keys). */
  snippet?: string;
  /** Sort position (lower first). */
  rank: number;
}

// ---------- keys per place ----------

const TOP = ['version', 'models', 'sources', 'seeds', 'snapshots', 'macros', 'exposures', 'unit_tests', 'semantic_models', 'metrics', 'saved_queries', 'groups', 'analyses', 'data_tests'];
const MODEL = ['name', 'description', 'columns', 'config', 'data_tests', 'tests', 'docs', 'constraints', 'versions', 'latest_version', 'access', 'group', 'deprecation_date', 'meta'];
const COLUMN = ['name', 'description', 'data_type', 'data_tests', 'tests', 'constraints', 'quote', 'meta', 'tags', 'config'];
const SOURCE = ['name', 'description', 'database', 'schema', 'loader', 'loaded_at_field', 'freshness', 'tables', 'config', 'quoting', 'meta', 'tags'];
const TABLE = ['name', 'description', 'identifier', 'loaded_at_field', 'freshness', 'columns', 'data_tests', 'tests', 'config', 'quoting', 'external', 'meta', 'tags'];
const SEED = ['name', 'description', 'columns', 'config', 'data_tests', 'tests', 'docs'];
const SNAPSHOT = ['name', 'description', 'relation', 'columns', 'config', 'data_tests', 'tests', 'docs'];
const MACRO = ['name', 'description', 'arguments', 'docs'];
const ARGUMENT = ['name', 'type', 'description'];
const UNIT_TEST = ['name', 'model', 'description', 'given', 'expect', 'overrides', 'config', 'versions'];
const EXPOSURE = ['name', 'label', 'type', 'maturity', 'url', 'description', 'depends_on', 'owner', 'config', 'meta', 'tags'];
const VERSION = ['v', 'defined_in', 'description', 'columns', 'config', 'data_tests', 'tests', 'docs', 'constraints', 'deprecation_date', 'access'];
const CONFIG = [
  'materialized', 'schema', 'database', 'alias', 'tags', 'enabled', 'unique_key', 'incremental_strategy', 'on_schema_change',
  'contract', 'persist_docs', 'grants', 'meta', 'docs', 'full_refresh', 'pre-hook', 'post-hook', 'sql_header', 'access',
  'group', 'event_time', 'batch_size', 'lookback', 'begin'
];
const SEED_CONFIG = ['column_types', 'quote_columns', 'delimiter', 'schema', 'database', 'alias', 'tags', 'enabled', 'persist_docs', 'grants', 'meta', 'docs', 'full_refresh', 'pre-hook', 'post-hook'];
const SNAPSHOT_CONFIG = ['strategy', 'unique_key', 'updated_at', 'check_cols', 'hard_deletes', 'snapshot_meta_column_names', 'dbt_valid_to_current', 'schema', 'database', 'alias', 'tags', 'enabled', 'persist_docs', 'grants', 'meta', 'docs', 'pre-hook', 'post-hook'];

/** Keys holding a list: insert `key:` and a first `- ` item. */
const LISTS: Record<string, string> = {
  columns: 'columns:\n  - name: ${0}',
  tables: 'tables:\n  - name: ${0}',
  data_tests: 'data_tests:\n  - ${0}',
  tests: 'tests:\n  - ${0}',
  models: 'models:\n  - name: ${0}',
  sources: 'sources:\n  - name: ${0}',
  seeds: 'seeds:\n  - name: ${0}',
  snapshots: 'snapshots:\n  - name: ${0}',
  macros: 'macros:\n  - name: ${0}',
  exposures: 'exposures:\n  - name: ${0}',
  unit_tests: 'unit_tests:\n  - name: ${0}',
  arguments: 'arguments:\n  - name: ${0}',
  versions: 'versions:\n  - v: ${0}',
  constraints: 'constraints:\n  - type: ${0}'
};
/** Keys holding a mapping: insert `key:` and an indented line. */
const MAPS = new Set(['config', 'meta', 'docs', 'freshness', 'quoting', 'persist_docs', 'grants', 'contract', 'owner', 'depends_on', 'given', 'expect', 'overrides', 'external', 'column_types']);

const PLACES: [RegExp, string[]][] = [
  [/^models\/-$/, MODEL],
  [/^models\/-\/columns\/-$/, COLUMN],
  [/^models\/-\/config$/, CONFIG],
  [/^models\/-\/versions\/-$/, VERSION],
  [/^models\/-\/versions\/-\/columns\/-$/, COLUMN],
  [/^models\/-\/versions\/-\/config$/, CONFIG],
  [/^sources\/-$/, SOURCE],
  [/^sources\/-\/tables\/-$/, TABLE],
  [/^sources\/-\/tables\/-\/columns\/-$/, COLUMN],
  [/^seeds\/-$/, SEED],
  [/^seeds\/-\/columns\/-$/, COLUMN],
  [/^seeds\/-\/config$/, SEED_CONFIG],
  [/^snapshots\/-$/, SNAPSHOT],
  [/^snapshots\/-\/columns\/-$/, COLUMN],
  [/^snapshots\/-\/config$/, SNAPSHOT_CONFIG],
  [/^macros\/-$/, MACRO],
  [/^macros\/-\/arguments\/-$/, ARGUMENT],
  [/^unit_tests\/-$/, UNIT_TEST],
  [/^exposures\/-$/, EXPOSURE],
  [/^$/, TOP]
];

// ---------- values ----------

const BOOL = ['true', 'false'];
const VALUES: Record<string, string[]> = {
  on_schema_change: ['ignore', 'append_new_columns', 'sync_all_columns', 'fail'],
  incremental_strategy: ['append', 'merge', 'delete+insert', 'insert_overwrite', 'microbatch'],
  access: ['private', 'protected', 'public'],
  strategy: ['timestamp', 'check'],
  hard_deletes: ['ignore', 'invalidate', 'new_record'],
  maturity: ['high', 'medium', 'low'],
  enabled: BOOL,
  full_refresh: BOOL,
  quote: BOOL,
  quote_columns: BOOL
};
const EXPOSURE_TYPES = ['dashboard', 'notebook', 'analysis', 'ml', 'application'];

const BUILT_IN_MATERIALIZATIONS = ['view', 'table', 'incremental', 'ephemeral', 'materialized_view'];
/** Materialization macros that aren't model materializations. */
const NOT_MODEL = new Set(['test', 'seed', 'snapshot', 'unit', 'clone']);

/**
 * Model materializations: dbt's own plus custom ones — `materialization_<name>_default` or
 * `materialization_<name>_<adapter>` macros (adapter types may contain `_`, e.g. sql_server).
 */
export function materializationsFrom(macroNames: string[], adapterType?: string): string[] {
  const out = [...BUILT_IN_MATERIALIZATIONS];
  const suffixes = ['default', ...(adapterType ? [adapterType] : [])].map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`^materialization_(.+)_(${suffixes.join('|')})$`);
  for (const n of macroNames) {
    const m = re.exec(n);
    if (m && !NOT_MODEL.has(m[1]) && !out.includes(m[1])) {
      out.push(m[1]);
    }
  }
  return out;
}

// ---------- tests ----------

function testSnippets(legacy: boolean): Suggestion[] {
  const args = (lines: string[]) => (legacy ? lines.map(l => `\n    ${l}`).join('') : `\n    arguments:${lines.map(l => `\n      ${l}`).join('')}`);
  return [
    { label: 'not_null', kind: 'test', rank: 0 },
    { label: 'unique', kind: 'test', rank: 1 },
    { label: 'accepted_values', kind: 'test', rank: 2, snippet: `accepted_values:${args(['values: [${1}]'])}` },
    { label: 'relationships', kind: 'test', rank: 3, snippet: `relationships:${args(["to: ref('${1}')", 'field: ${2}'])}` }
  ];
}

// ---------- entry points ----------

/** The model / seed / snapshot / source table whose column name is being typed, if that's where the cursor is. */
export function columnOwnerOf(ctx: YamlContext): ColumnOwner | undefined {
  if (ctx.kind !== 'value' || ctx.key !== 'name') {
    return undefined;
  }
  const p = ctx.path.join('/');
  const first = ctx.items[0]?.name;
  if (p === 'models/-/versions/-/columns/-' && first) {
    return { kind: 'model', name: first }; // the model's columns (its latest version's, in the catalog)
  }
  if (/^(models|seeds|snapshots)\/-\/columns\/-$/.test(p) && first) {
    return { kind: ({ models: 'model', seeds: 'seed', snapshots: 'snapshot' } as const)[ctx.path[0] as 'models' | 'seeds' | 'snapshots'], name: first };
  }
  const table = ctx.items[1]?.name;
  if (p === 'sources/-/tables/-/columns/-' && first && table) {
    return { kind: 'source', source: first, name: table };
  }
  return undefined;
}

/** On a `- key` line VS Code indents a snippet's later lines to the dash, not past it: add the dash's width. */
const underItem = (snippet: string) => snippet.replace(/\n/g, '\n  ');

function keySuggestions(keys: string[], siblings: string[], onItemLine: boolean): Suggestion[] {
  const taken = new Set(siblings);
  // data_tests and its older name tests are one property.
  if (taken.has('data_tests') || taken.has('tests')) {
    taken.add('data_tests');
    taken.add('tests');
  }
  return keys
    .filter(k => !taken.has(k))
    .map((k, i) => ({
      label: k,
      kind: 'key' as const,
      rank: i,
      snippet: (onItemLine ? underItem : (x: string) => x)(LISTS[k] ?? (MAPS.has(k) ? `${k}:\n  \${0}` : `${k}: \${0}`))
    }));
}

/** Suggestions for the cursor position. */
export function suggestionsFor(ctx: YamlContext, data: YamlData): Suggestion[] {
  const p = ctx.path.join('/');
  const listItem = ctx.path[ctx.path.length - 1] === '-';
  const inTests = /(^|\/)(data_tests|tests)\/-$/.test(p);

  if ((ctx.kind === 'item' || ctx.kind === 'key') && inTests) {
    return [
      ...testSnippets(data.legacyArguments),
      ...data.genericTests.map((t, i) => ({ label: t, kind: 'test' as const, rank: 10 + i }))
    ];
  }
  if (ctx.kind === 'key' || ctx.kind === 'item') {
    const keys = PLACES.find(([re]) => re.test(p))?.[1];
    if (!keys) {
      return [];
    }
    const out = keySuggestions(keys, ctx.siblings, ctx.kind === 'item');
    // A new list item starts with its name.
    return listItem && ctx.kind === 'item' ? out.sort((a, b) => (a.label === 'name' ? -1 : b.label === 'name' ? 1 : a.rank - b.rank)) : out;
  }
  if (ctx.kind !== 'value') {
    return [];
  }
  const key = ctx.key ?? '';
  const models = (exclude: string[] = []) =>
    data.models
      .filter(m => !exclude.includes(m.name))
      .sort((a, b) => Number(a.documented) - Number(b.documented) || a.name.localeCompare(b.name))
      .map((m, i) => ({ label: m.name, kind: 'model' as const, rank: i, ...(m.documented ? {} : { detail: 'model · no YAML entry yet' }) }));

  if (key === 'name') {
    if (p === 'models/-') {
      return models(ctx.listNames); // not the ones this file already lists
    }
    const names = (list: string[]) => [...list].sort().map((n, i) => ({ label: n, kind: 'name' as const, rank: i }));
    if (p === 'seeds/-') {
      return names(data.seeds);
    }
    if (p === 'snapshots/-') {
      return names(data.snapshots);
    }
    if (p === 'macros/-') {
      return names(data.macros);
    }
    if (/\/columns\/-$/.test(p)) {
      const listed = new Set(ctx.listNames.map(n => n.toLowerCase()));
      return data.columns
        .filter(c => !listed.has(c.name.toLowerCase()))
        .map((c, i) => ({ label: c.name, kind: 'column' as const, rank: i, ...(c.dataType ? { detail: c.dataType } : {}) }));
    }
    return [];
  }
  if (key === 'model' && p === 'unit_tests/-') {
    return models();
  }
  if (key === 'materialized') {
    return data.materializations.map((m, i) => ({ label: m, kind: 'value' as const, rank: i }));
  }
  if (key === 'type' && p === 'exposures/-') {
    return EXPOSURE_TYPES.map((v, i) => ({ label: v, kind: 'value' as const, rank: i }));
  }
  return (VALUES[key] ?? []).map((v, i) => ({ label: v, kind: 'value' as const, rank: i }));
}
