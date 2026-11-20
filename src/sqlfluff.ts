import * as path from 'path';

/** One SQLFluff violation, 0-based positions. */
export interface LintViolation {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** e.g. LT01; TMP (templating) and PRS (parsing) for files SQLFluff couldn't read. */
  code: string;
  message: string;
  /** e.g. layout.spacing (empty for TMP / PRS). */
  rule?: string;
  warning: boolean;
}

/** `<venv>/Scripts/sqlfluff.exe` (Windows) or `<venv>/bin/sqlfluff`. */
export function sqlfluffExecutable(venvPath: string, exists: (p: string) => boolean): string | undefined {
  if (!venvPath.trim()) {
    return undefined;
  }
  return [path.join(venvPath, 'Scripts', 'sqlfluff.exe'), path.join(venvPath, 'bin', 'sqlfluff')].find(c => exists(c));
}

/** "4.5.0" from `sqlfluff --version` ("sqlfluff, version 4.5.0"). */
export function parseSqlfluffVersion(output: string): string | undefined {
  return /version\s+(\d+\.\d+\.\d+\S*)/.exec(output)?.[1];
}

/** Violations from `sqlfluff lint --format json` for one file; undefined when the output isn't SQLFluff's JSON. */
export function parseLintJson(stdout: string): LintViolation[] | undefined {
  let doc: any;
  try {
    doc = JSON.parse(stdout.trim());
  } catch {
    const start = stdout.indexOf('[');
    const end = stdout.lastIndexOf(']');
    try {
      doc = start >= 0 && end > start ? JSON.parse(stdout.slice(start, end + 1)) : undefined;
    } catch {
      doc = undefined;
    }
  }
  if (!Array.isArray(doc)) {
    return undefined;
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const out: LintViolation[] = [];
  for (const file of doc) {
    for (const v of Array.isArray(file?.violations) ? file.violations : []) {
      const line = (num(v.start_line_no) ?? num(v.line_no) ?? 1) - 1;
      const col = (num(v.start_line_pos) ?? num(v.line_pos) ?? 1) - 1;
      const endLine = num(v.end_line_no) !== undefined ? num(v.end_line_no)! - 1 : line;
      const endCol = num(v.end_line_pos) !== undefined ? num(v.end_line_pos)! - 1 : col + 1;
      out.push({
        line: Math.max(0, line),
        col: Math.max(0, col),
        endLine: Math.max(0, endLine),
        endCol: Math.max(0, endCol),
        code: String(v.code ?? ''),
        message: String(v.description ?? ''),
        rule: typeof v.name === 'string' && v.name ? v.name : undefined,
        warning: v.warning === true
      });
    }
  }
  return out;
}

const DIALECTS: Record<string, string> = {
  synapse: 'tsql',
  sqlserver: 'tsql',
  fabric: 'tsql',
  spark: 'sparksql',
  databricks: 'databricks',
  duckdb: 'duckdb',
  snowflake: 'snowflake',
  bigquery: 'bigquery',
  postgres: 'postgres',
  redshift: 'redshift',
  trino: 'trino',
  athena: 'athena',
  clickhouse: 'clickhouse',
  mysql: 'mysql',
  mariadb: 'mariadb',
  oracle: 'oracle',
  sqlite: 'sqlite',
  teradata: 'teradata',
  exasol: 'exasol',
  vertica: 'vertica',
  materialize: 'materialize',
  greenplum: 'greenplum',
  hive: 'hive',
  impala: 'impala',
  db2: 'db2',
  starrocks: 'starrocks',
  doris: 'doris'
};

/** The SQLFluff dialect for a dbt adapter type (manifest `metadata.adapter_type`); `ansi` when unknown. */
export function dialectFor(adapterType: string | undefined): string {
  return DIALECTS[(adapterType ?? '').toLowerCase()] ?? 'ansi';
}

/**
 * Whether a SQLFluff config file sets `dialect` in its core section: `[sqlfluff]` in .sqlfluff / setup.cfg /
 * tox.ini, `[tool.sqlfluff.core]` (or `[tool.sqlfluff]`) in pyproject.toml.
 */
export function configHasDialect(fileName: string, text: string): boolean {
  const core = /pyproject\.toml$/i.test(fileName) ? /^\[tool\.sqlfluff(\.core)?\]$/ : /^\[sqlfluff\]$/;
  let inCore = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inCore = core.test(line);
    } else if (inCore && /^dialect\s*[=:]\s*\S/.test(line)) {
      return true;
    }
  }
  return false;
}

/** Config files SQLFluff reads (in each folder from the file up). */
export const CONFIG_FILES = ['.sqlfluff', 'setup.cfg', 'tox.ini', 'pyproject.toml'];

const dialectArgs = (dialect: string | undefined) => (dialect ? ['--dialect', dialect] : []);

/** `sqlfluff lint` of the text on stdin, as `file` (config and .sqlfluffignore are found from its folder). */
export function lintArgs(file: string, dialect: string | undefined, extra: string[]): string[] {
  return ['lint', '-', '--stdin-filename', file, '--format', 'json', '--disable-progress-bar', ...dialectArgs(dialect), ...extra];
}

/** `sqlfluff fix` of the text on stdin; the fixed text comes back on stdout. */
export function fixArgs(file: string, dialect: string | undefined, extra: string[]): string[] {
  return ['fix', '-', '--stdin-filename', file, '--disable-progress-bar', ...dialectArgs(dialect), ...extra];
}

/**
 * The fixed text to put in the editor, or undefined when there is nothing to change. On Windows SQLFluff writes
 * CRLF to stdout whatever the input was: line endings are mapped back to the file's own (`eol`).
 */
export function fixedText(stdout: string, original: string, eol: '\n' | '\r\n'): string | undefined {
  if (!stdout) {
    return undefined;
  }
  const text = stdout.replace(/\r\n/g, '\n').split('\n').join(eol);
  return text === original ? undefined : text;
}

/**
 * Folders SQLFluff reads config from for `file`: the file's folder up to the drive root, the home folder and the
 * user config folder (as SQLFluff does), nearest first, each once.
 */
export function configSearchDirs(file: string, home: string, userConfigDir: string): string[] {
  const dirs: string[] = [];
  for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (path.dirname(dir) === dir) {
      break;
    }
  }
  const key = (d: string) => path.resolve(d).toLowerCase();
  for (const d of [home, userConfigDir]) {
    if (d && !dirs.some(x => key(x) === key(d))) {
      dirs.push(path.resolve(d));
    }
  }
  return dirs;
}

/**
 * Whether a `sqlfluff fix` run's stdout can replace the file: exit 0, or 1 (fixed what it could, violations left).
 * Never a run that was killed (timeout, output too large) or failed — its stdout may be partial or not SQL.
 */
export function fixAccepted(err: { code?: number | string | null; killed?: boolean } | undefined | null): boolean {
  return !err || (err.code === 1 && !err.killed);
}
