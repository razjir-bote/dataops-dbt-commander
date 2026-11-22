# DataOps dbt Commander

_Formerly "dbt Runner". Settings saved as `dbtRunner.*` are migrated to `dbtCommander.*` automatically._

Run dbt-core 1.x from the VS Code Explorer and editor, using dbt from a Python venv you choose.
Supports dbt-core 1.x (tested with 1.12); not dbt 2 / Fusion.

## Features

- **One right-click list.** Everything dbt is under **dbt ▸** when you right-click a model, seed CSV or folder in
  the Explorer, an editor tab, or inside the code editor; the dbt sidebar and Lineage view show the same list
  directly. Same groups, same order everywhere, only what applies: Run · Build · Test · Seed · Snapshot · Run Test |
  Build + Upstream / + Downstream / + Upstream & Downstream | Compile · Preview Data · Preview Selection / CTE ·
  Show Lineage · Open in dbt Docs | Generate YAML · New Model… · Create Staging Model · Create SCD2 Models and Gates
  Test… · Add Seed as Source… | Rename Model… | SQLFluff: Lint File · Fix File | Open Settings.
- **Right-click models or folders** under `models/` → **dbt** → Run / Build / Test.
  Multi-select works; folders run everything inside (`--select path:models/staging`).
- **Right-click any folder** in your dbt project → **dbt** → **Build** or **Seed** runs on everything inside it,
  subfolders included (`--select path:seeds/ref`). Right-clicking the project folder itself builds / seeds the
  whole project. Folders under `models/` also offer Run and Test.
- **Right-click seed CSVs** under `seeds/` (or its subfolders) → **dbt ▸ Seed** loads just those seeds
  (`--select path:seeds/ref/countries.csv`). Multi-select works, and open seed CSVs get a ▶ seed button.
- **Build + Upstream / + Downstream / + Upstream & Downstream** for a model (`+model`, `model+`, `+model+`).
- **▶ in the editor title** builds the open model. Unsaved changes are saved first.
- **Keyboard shortcuts** (while a model is open): `Ctrl+'` then
  `B` build · `R` run · `T` test · `C` compile · `P` preview · `Q` preview selection / CTE.
- **Compile** opens the compiled SQL beside the model.
- **Preview Data** runs `dbt show` and shows the rows in a table (limit: `dbtCommander.previewLimit`, default 100).
  Click a header to sort, type in the filter box to narrow the rows, then **Copy** (tab-separated, pastes into
  Excel / Sheets) or **Save CSV…** — both take the rows as shown (text that a spreadsheet would run as a formula,
  like `=…`, is exported with a leading `'`). **Σ** on a header profiles that column.
- **Errors in the Problems panel**: compilation/runtime/database errors on the model (with the line when dbt
  gives one), test failures and warnings on the YAML file. A model's problems are replaced when it runs again.
- **Target switcher** in the status bar, listing the targets from your `profiles.yml`.
- **Project commands** — `deps`, `seed`, `snapshot`, and `docs generate` (builds the static docs page and opens
  it in your browser; `dbtCommander.openDocsAfterGenerate`) — from the `dbt` status bar menu or the command palette.
- **Run links above each model** — `Run · Build · Test · Compile · Preview` (`dbtCommander.codeLens` to turn off).
- **Go to definition** — Ctrl+click / F12 on `ref('model')`, `ref('package', 'model')`, `ref('model', v=2)` opens
  the model; on `source('src', 'table')` opens the sources YAML at that table.
- **Autocomplete** — model names inside `ref('`, source names inside `source('`, and that source's tables in its
  second argument.

- **Go to definition for macros** — Ctrl+click a macro call inside `{{ }}` / `{% %}` (`{{ cents_to_dollars('x') }}`,
  `{{ dbt_utils.star(...) }}`, `{{ dbt.current_timestamp() }}`) to open it — your project's macros, installed
  packages, and dbt's own / adapter macros inside your venv.
- **Generate YAML** — right-click a model (or use the sidebar) to write its `models:` entry with every column
  and its data type, read from the warehouse through dbt (the model must be built; you're offered *Build & retry*).
  It adds only missing columns to an existing entry, otherwise appends to a `.yml` in the model's folder, otherwise
  creates `<model>.yml`. Existing lines are left untouched and the change is left unsaved for you to review.
- **dbt sidebar** — the dbt icon in the Activity Bar shows Models and Seeds (by folder), Sources, Snapshots and
  Tests (by model), with run / build / test / seed / snapshot buttons on items, **folders and whole sections**, and
  the rest of the list on right-click. **Ctrl/Shift-click** to select several models,
  seeds, folders, tests or snapshots, then use a button or right-click: they run as one dbt command. Right-click
  also offers **Build + Upstream / + Downstream / + Upstream & Downstream** for the selection (folders included).
- **Auto-parse** — saving, adding or deleting models, YAML, seeds, snapshots, macros or tests (or editing
  `dbt_project.yml`) runs `dbt parse` in the background, so the sidebar, Tests view, lineage and completion keep up
  without a command. It waits 1.5 s for a burst of saves, never runs beside another dbt command in the project
  (those wait for it, and a command that already parsed makes it unnecessary), and shows `dbt parse` / `dbt parse
  failed` in the status bar (click for dbt's output). `dbtCommander.autoParse` (on by default, or the settings page).
- **Lineage** — a view under Project shows the open model's **upstream** (models, seeds, snapshots, sources) and
  **downstream** (models, snapshots, exposures), each expandable level by level; click to open, Build on models.
  It follows the active editor; *Show Lineage* pins it to a node until you press *Follow Active Editor* — on a
  model, seed, snapshot, **source table, exposure or semantic model** in the dbt sidebar (to see what an exposure
  depends on), or on any item in the Lineage panel to re-centre on it.

- **dbt tests in the Testing panel** — every dbt test appears in VS Code's Testing view, grouped by model / source,
  with run buttons, Run All, Rerun Failed, pass/fail icons next to each test in your YAML, and dbt's failure
  message ("Got 2 results, configured to fail if != 0") at the test. Output goes to Test Results; a warn result
  shows as passed with the warning in the output.
- **Hover on `ref()` / `source()`** — description, materialization, file path and columns (types from
  `target/catalog.json` when you've run `dbt docs generate`).

- **After a run** — the last result of every model, seed, snapshot and test (`✓ 3m ago · 1.2s`, `✗ error 5m ago`)
  shows in the sidebar and above each model, from every dbt run including ones in your terminal. The **Last run**
  view lists the latest run's nodes, slowest first. **dbt retry** reruns only what failed (status bar menu, Last
  run view, or the notification). **Rerun last command**: `Ctrl+'` then `L` (not while the terminal has focus).
  Runs longer than `dbtCommander.notifyAfterSeconds` (default 30) end with a notification.
- **Column autocomplete** — after `from {{ ref('orders') }} o`, typing `o.` lists the model's columns.
- **Find references** — Shift+F12 on `ref('orders')` or in `orders.sql` lists everything that refs it.
- **Custom folders** — `model-paths`, `seed-paths`, `snapshot-paths` and `packages-install-path` from
  `dbt_project.yml` are respected by menus, links and navigation.
- **Rename Model…** (right-click a model) — renames the file, every `ref()` to it (models, snapshots,
  analyses, tests, macros, YAML) and its `models:` / `unit_tests:` YAML entries, shown first in VS Code's refactor
  preview. Versioned models and per-model settings in `dbt_project.yml` are not renamed.
- **Create Staging Model** (right-click a source table in the sidebar, on a `source()` call, or in a table's entry
  under `sources:` in YAML — also a lightbulb on that entry) — creates
  `stg_<system>__<entity>.sql` (the table name split at its first underscore: `ace_aus_accounttag_account` →
  `stg_ace__aus_accounttag_account`, in `models/staging/ace/`) in the bronze → staging pattern (T-SQL / Synapse) from the table's columns (read from
  the warehouse), plus its YAML entry: every column trimmed, blank → NULL and typed (`…On` / `_ts` / `_at` →
  DATETIME2, `_date` → DATE, else NVARCHAR(4000)); the `Id` column kept and copied to `entity_id`; the newest load
  kept per `_landing_extract_date` + `entity_id` (no key: per every column not starting with `_`); rows with
  `IsDelete` other than false / 0 dropped. Every rule is a `dbtCommander.bronzeStaging.*` setting.
- **Add Seed as Source…** (right-click seed CSVs in the Explorer or the dbt sidebar) — adds them as tables of a
  source (default `bronze`) in `models/staging/<source>/_<source>__sources.yml`, pointing at the seeds' tables
  (schema from the manifest), with the CSV header as columns — so `source('bronze', '<seed>')` and *Create
  staging model* work on sample data. Existing entries are left alone; run *dbt seed* to load the tables.
- **Create SCD2 Models and Gates Test…** (right-click a `stg_` model in the Explorer, sidebar or editor) — creates the rest of
  the chain in `models/intermediate/scd2/generated/` (`dim_<source>__<entity>__candidate` / `__history` /
  `__published`, each one line calling your project's `scd2_candidate` / `scd2_history` / `scd2_published` macro),
  the singular test `tests/scd2/generated/dim_<source>__<entity>__gates.sql` (calling `scd2_gate_test`) — existing
  files are kept, and a missing macro is reported — the dimension's entry in the `scd2_dimensions:` list of
  `vars.yaml` (`dbtCommander.scd2.varsFile`; appended as text, other lines untouched, an existing entry of that name
  kept) — and `models/intermediate/changekey/int_<source>__<entity>__changekey.sql`: only extracts the history table
  (`int_history.dim_<source>__<entity>__history`) hasn't loaded yet, with `attribute_hash` = `versionnumber`, else
  `_full_row_hash`, else `{{ hash_columns([...]) }}` over the data columns. `hash_columns` is added to
  `macros/hash_columns.sql` when needed (never overwritten): it hashes each column, then groups of 250 column
  hashes, so `HASHBYTES` never gets more than 8000 bytes (Synapse) however wide the table. Settings:
  `dbtCommander.scd2.*`.
- **New Model…** (right-click a model folder) — creates a model from a template (`dbtCommander.newModelTemplate`,
  `{{name}}` placeholder) with a YAML entry.
- **Open in dbt Docs** — jumps to a model's / source's / seed's / exposure's page in the static docs site
  (generated on first use).
- **Exposures and semantic models** in the sidebar and in Lineage.
- **Check connection (dbt debug)** in the status bar menu.
- **SQL scratchpad** — *New SQL Scratchpad* (status bar menu, sidebar title, command palette) opens an unsaved
  `dbt-scratch-N.sql` for a project. **Ctrl+Enter** runs the query, or just the selection, through
  `dbt show --inline`, so `ref()`, `source()`, macros and the active target work; rows open in the preview table.
  Autocomplete and hovers work there too.
- **Preview a selection or a CTE** — in a model, `Ctrl+'` then `Q` (or right-click → *dbt ▸ Preview Selection / CTE*)
  previews the selected SQL; with no selection, the CTE under the cursor; elsewhere, the whole model. A selection of
  CTEs that ends in a comma (`with a as (…), b as (…),` — the `with` may be left out) previews its last CTE
  (`select * from b`). It uses the editor's text, unsaved edits included, without saving the file.
- **Add tests from YAML** — the lightbulb on a model column in YAML (`- name: id` under `columns:`) adds
  `unique`, `not_null`, both, or `accepted_values` (asks for the values) to its `data_tests:` / `tests:` list.
  On the first line of a model with no YAML entry, the lightbulb offers *Generate YAML for this model*.
- **Column profile** — the lightbulb on a model, seed, snapshot or source column in YAML (or Σ in a model preview)
  shows row count, nulls, distinct values, min, max and the 10 most common values, from one `dbt show` query.
- **More tests from YAML** — *Add relationships test…* (pick the parent model / source and its column), and with
  dbt_utils installed: `not_empty_string`, `not_constant`, `at_least_one`, `accepted_range…`.
- **SQLFluff linting (optional, off by default)** — with SQLFluff installed in the dbt venv (`pip install sqlfluff`),
  set *Linting* to On or Auto on the settings page. SQLFluff problems then show for dbt SQL files on open and save,
  *Format Document* uses `sqlfluff fix`, *SQLFluff: Lint file* / *Fix file* are in the editor menu, and **Fix on save**
  (separate opt-in) fixes a file when you save it yourself. Your `.sqlfluff` / `.sqlfluffignore` are used; with no
  dialect configured, the dbt adapter's is passed (`synapse` → `tsql`, `duckdb`, `snowflake`, …). *Off* turns every
  SQLFluff feature off and never starts SQLFluff.
- **YAML autocomplete** — in your project's `.yml` files: model names after `- name:` under `models:` (models without
  a YAML entry first), seeds / snapshots / macros likewise, a model's **column names** (with types, from
  `target/catalog.json` — run *dbt docs generate* first), **tests** under `data_tests:` (built-ins as templates,
  plus generic tests from your project and packages such as `dbt_utils.*`), the **keys** that fit where you are
  (model, column, source, `config:` …) and **config values** (`materialized:`, `on_schema_change:` …), and
  `ref('` / `source('` names.
- **Hover on macros** — signature, description and documented arguments (from `macros:` YAML) of a macro call.
- Saved last-run results of models / tests that no longer exist are dropped when the manifest changes.

Go to definition and autocomplete read `target/manifest.json`, which dbt rewrites on every run, build, compile or
parse — so they reflect your last dbt command. Without a manifest, `ref()` still jumps to a model file of that name.

## Setup

1. Install the `.vsix` from the [Releases](https://github.com/razjir-bote/dataops-dbt-commander/releases) page:
   `code --install-extension dataops-dbt-commander-<version>.vsix`
2. Click **dbt: not configured** in the status bar → **Settings**, browse to your venv (the folder containing
   `Scripts\dbt.exe`), check the detected version shows dbt-core 1.x, and Save.

Settings are saved per workspace. Extra flags apply to every command except `deps`
(quotes keep values together, e.g. `--vars '{"key": "value"}'`).

dbt runs your project's macros and hooks, so DataOps dbt Commander only runs in **trusted** workspaces, and in untrusted
ones the venv path, target and extra flags are read from your user settings only.

## Development

```bash
npm install
npm run typecheck        # tsc, no output
npm run compile && npm test   # unit tests (node:test)
npm run test:integration # real VS Code + dbt-core 1.12 + duckdb against test/fixtures/demo, groups in parallel
npm run test:integration:serial # the same in one VS Code, step by step (for debugging)
npm run package          # builds dist/ with esbuild and creates the .vsix
```

`test:integration` creates a dbt venv in `.vscode-test/dbt-venv` on first run (set `DBT_PYTHON` to choose the
Python). CI (`.github/workflows/ci.yml`) runs all of this on Windows for every push and pull request, and
publishes a GitHub release with the `.vsix` when a `v*` tag matching `package.json`'s version is pushed.
