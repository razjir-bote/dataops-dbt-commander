# DataOps dbt Commander v0.12 — optional SQLFluff linting and fix on save

## Intent
Use the SQLFluff already installed in the dbt venv to show lint problems in dbt SQL files and, if the user turns
it on, fix them on save. **Off by default**: nothing changes until the user turns linting on in the settings page.

## Goals
- **Lint:** when a model / snapshot / analysis / macro / test `.sql` file is opened or saved, run SQLFluff on it
  and show its violations in the Problems panel (source `sqlfluff`, code e.g. `LT09`, with the rule name), at the
  exact range SQLFluff reports. Unsaved text is linted (stdin), so problems match what's on screen.
- **Fix on save** (`dbtCommander.sqlfluff.fixOnSave`, default **off**): before the file is written, run
  `sqlfluff fix` on the editor text and apply the result as one edit (one undo step).
- **Format Document:** SQLFluff is also registered as a formatter for dbt SQL files, so *Format Document* and
  VS Code's own `editor.formatOnSave` work with it.
- **Commands:** *SQLFluff: Lint file*, *SQLFluff: Fix file* (palette + editor context menu).
- **Settings:** `dbtCommander.sqlfluff.enabled` (**`off` by default** / `on` / `auto` = whenever the venv has SQLFluff),
  `dbtCommander.sqlfluff.fixOnSave`, `dbtCommander.sqlfluff.dialect` (empty = auto), `dbtCommander.sqlfluff.extraArgs`.
- **Settings page:** a *SQLFluff linting* section with the detected SQLFluff version and a **Linting: Auto / On /
  Off** choice (Off selected by default), plus *Fix on save*, dialect and extra flags. **Off disables every SQLFluff feature completely**: no
  linting, no fix on save, no formatter registered, the SQLFluff commands hidden, and existing SQLFluff problems
  cleared — SQLFluff is never started. (Same as setting `dbtCommander.sqlfluff.enabled` to `off`.)

## Non-goals
Installing SQLFluff, writing a `.sqlfluff` config, lint-as-you-type, linting whole folders (use the terminal),
quick fixes per violation.

## Approaches (where there was a real choice)
**Which SQLFluff.** `<venv>/Scripts/sqlfluff.exe` (POSIX `bin/sqlfluff`) — the same venv as dbt, so a project's
`templater = dbt` (sqlfluff-templater-dbt) sees the same dbt. Not found → no linting, no messages (unless
`enabled` is `on`, which shows a one-time warning).

**Dialect.** SQLFluff refuses to run without one. If the project's config (`.sqlfluff`, `pyproject.toml`
`[tool.sqlfluff]`, `setup.cfg`, `tox.ini` in the project folder) sets `dialect`, the extension passes nothing.
Otherwise it passes `--dialect` from the setting, else from the dbt adapter in the manifest (`duckdb`, `snowflake`,
`bigquery`, `postgres`, `redshift`, `databricks`/`spark` → `sparksql`, `sqlserver`/`fabric` → `tsql`, `trino`,
`athena`, `clickhouse`, …); unknown adapters → `ansi`.

**Fix on save mechanism.** VS Code's will-save hook (`waitUntil`), so the fixed text is what gets saved — not a
second write after the save (which would leave the file dirty or fight with typing). Saves are not blocked for long:
VS Code gives save participants a time budget, and a fix that fails or times out leaves the text unchanged.

**When it runs.** On open and save (and when settings change), not while typing: each run starts Python (~1 s; with
the dbt templater, longer). Runs per file are serialized; a newer run replaces an older one's results.

## Design notes
- `sqlfluff.ts` (pure): `parseLintJson(stdout)` → violations (handles `start_line_no` / older `line_no` fields),
  `dialectFor(adapterType)`, `configHasDialect(texts)`, `lintArgs` / `fixArgs`.
- `sqlfluffRunner.ts` (VS Code): executable lookup, stdin runs with `--stdin-filename`, DiagnosticCollection,
  will-save fix, formatting provider, commands.
- Problems are cleared when a file closes or SQLFluff is turned off.

## Claude's calls (correct if wrong)
- Everything is **off** by default (user decision); turning linting on doesn't turn on fix on save.
- `on` with no SQLFluff in the venv shows a one-time warning; `auto` stays silent.
- Files linted: `.sql` in the project's model / snapshot / analysis / macro / test paths (not target/, packages).
- Commit only; release when asked.
