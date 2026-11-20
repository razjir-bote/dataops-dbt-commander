import { cleanLine } from './errors';
import { splitArgs } from './dbt';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

/** dbt Labs' convention: stg_<source>__<table>. */
export function stagingName(source: string, table: string): string {
  return `stg_${slug(source)}__${slug(table)}`;
}

const RESERVED = new Set([
  'all', 'and', 'as', 'asc', 'between', 'by', 'case', 'cast', 'check', 'column', 'create', 'cross', 'current_date',
  'current_time', 'current_timestamp', 'default', 'delete', 'desc', 'distinct', 'drop', 'else', 'end', 'exists', 'false',
  'from', 'full', 'group', 'having', 'in', 'inner', 'insert', 'interval', 'into', 'is', 'join', 'left', 'like', 'limit',
  'natural', 'not', 'null', 'offset', 'on', 'or', 'order', 'outer', 'over', 'partition', 'primary', 'right', 'rows',
  'select', 'set', 'table', 'then', 'to', 'true', 'union', 'unique', 'update', 'user', 'using', 'values', 'when',
  'where', 'window', 'with'
]);

/**
 * A column as written in generated SQL: plain identifiers stay bare; anything else (spaces, mixed case, reserved
 * words) goes through `adapter.quote`, so each warehouse gets its own quoting.
 */
function columnRef(name: string): string {
  const plain = /^[a-z_][a-z0-9_]*$/.test(name) || /^[A-Z_][A-Z0-9_]*$/.test(name);
  return plain && !RESERVED.has(name.toLowerCase()) ? name : `{{ adapter.quote('${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}') }}`;
}

/** A staging model selecting every column of a source table (or `select *` with a TODO when unknown). */
export function stagingSql(source: string, table: string, columns: string[]): string {
  const from = `select * from {{ source('${source.replace(/'/g, "\\'")}', '${table.replace(/'/g, "\\'")}') }}`;
  const body = columns.length
    ? ['    select', columns.map(c => `        ${columnRef(c)}`).join(',\n'), '', '    from source']
    : ['    -- TODO: list the columns (they could not be read from the warehouse)', '    select * from source'];
  return ['with source as (', '', `    ${from}`, '', '),', '', 'renamed as (', '', ...body, '', ')', '', 'select * from renamed', ''].join('\n');
}

const DEFAULT_TEMPLATE = ['with source as (', '', "    select * from {{ ref('replace_me') }}", '', ')', '', 'select * from source', ''].join('\n');

/** A new model's SQL: the user's template (with `{{name}}` filled in) or a small skeleton. */
export function newModelSql(name: string, template?: string): string {
  return (template ?? DEFAULT_TEMPLATE).split('{{name}}').join(name);
}

const DOC_ROUTES = new Set([
  'model', 'seed', 'snapshot', 'source', 'exposure', 'semantic_model', 'test', 'analysis', 'macro', 'metric', 'saved_query', 'unit_test'
]);

/** URL fragment of a node's page in dbt's static docs site (`static_index.html#!/model/model.demo.b`). */
export function docsFragment(uniqueId: string): string {
  const type = uniqueId.split('.')[0];
  return DOC_ROUTES.has(type) ? `!/${type}/${uniqueId}` : '!/overview';
}

/**
 * Arguments for `dbt debug`: the target plus only the extra flags it accepts (it rejects run flags such as
 * --full-refresh, --threads or --select).
 */
export function debugArgs(target: string, extraArgs: string): string[] {
  const allowed = new Set(['--profiles-dir', '--project-dir', '--vars', '--profile', '--target']);
  const args = splitArgs(extraArgs);
  const out: string[] = target.trim() ? ['--target', target.trim()] : [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].split('=')[0];
    if (!allowed.has(flag)) {
      continue;
    }
    if (args[i].includes('=')) {
      out.push(args[i]);
    } else if (i + 1 < args.length) {
      out.push(args[i], args[++i]);
    }
  }
  return out;
}

/** A tiny page that forwards to `url` (a `#!` fragment doesn't survive being opened as a file URI). */
export function docsRedirectHtml(url: string): string {
  const attr = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const js = JSON.stringify(url).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${attr}"><script>location.replace(${js})</script>`;
}

/** "All checks passed!" or the reason after "N check(s) failed:" in `dbt debug` output. */
export function debugSummary(output: string): { ok: boolean; text: string } {
  const lines = output.split(/\r?\n/).map(cleanLine);
  if (lines.some(l => /All checks passed!/.test(l))) {
    return { ok: true, text: 'All checks passed!' };
  }
  const at = lines.findIndex(l => /^\s*\d+ checks? failed:/.test(l));
  const rest = (at >= 0 ? lines.slice(at) : lines.slice(-8)).map(l => l.trim()).filter(Boolean);
  return { ok: false, text: rest.join(' ').slice(0, 500) };
}
