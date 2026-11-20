# DataOps dbt Commander

_Formerly "dbt Runner". Settings saved as `dbtRunner.*` are migrated to `dbtCommander.*` automatically._

Run dbt-core 1.x from the VS Code Explorer and editor, using dbt from a Python venv you choose.
Supports dbt-core 1.x (tested with 1.12); not dbt 2 / Fusion.

## Features

- **Right-click models or folders** under `models/` → **dbt** → Run / Build / Test.
  Multi-select works; folders run everything inside (`--select path:models/staging`).
- **Right-click any folder** in your dbt project → **dbt** → **Build** or **Seed** runs on everything inside it,
  subfolders included (`--select path:seeds/ref`). Right-clicking the project folder itself builds / seeds the
  whole project. Folders under `models/` also offer Run and Test.
- **Right-click seed CSVs** under `seeds/` (or its subfolders) → **dbt Seed** loads just those seeds
  (`--select path:seeds/ref/countries.csv`). Multi-select works, and open seed CSVs get a ▶ seed button.
- **Build + Upstream / + Downstream / + Upstream & Downstream** for a model (`+model`, `model+`, `+model+`).
- **▶ in the editor title** builds the open model. Unsaved changes are saved first.
- **Keyboard shortcuts** (while a model is open): `Ctrl+'` then
  `B` build · `R` run · `T` test · `C` compile · `P` preview.
- **dbt Compile** opens the compiled SQL beside the model.
- **dbt Preview Data** runs `dbt show` and shows the rows in a table (limit: `dbtCommander.previewLimit`, default 100).
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
- **dbt Generate YAML** — right-click a model (or use the sidebar) to write its `models:` entry with every column
  and its data type, read from the warehouse through dbt (the model must be built; you're offered *Build & retry*).
  It adds only missing columns to an existing entry, otherwise appends to a `.yml` in the model's folder, otherwise
  creates `<model>.yml`. Existing lines are left untouched and the change is left unsaved for you to review.
- **dbt sidebar** — the dbt icon in the Activity Bar shows Models and Seeds (by folder), Sources, Snapshots and
  Tests (by model), with run / build / test / seed / snapshot buttons on items, **folders and whole sections**, and
  Compile / Preview / Generate YAML / Show lineage on right-click. **Ctrl/Shift-click** to select several models,
  seeds, folders, tests or snapshots, then use a button or right-click: they run as one dbt command. Right-click
  also offers **Build + Upstream / + Downstream / + Upstream & Downstream** for the selection (folders included).
- **Lineage** — a view under Project shows the open model's **upstream** (models, seeds, snapshots, sources) and
  **downstream** (models, snapshots, exposures), each expandable level by level; click to open, Build on models.
  It follows the active editor; *Show lineage* pins it to a model until you press *Follow active editor*.

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
- **dbt Rename model…** (right-click a model) — renames the file, every `ref()` to it (models, snapshots,
  analyses, tests, macros, YAML) and its `models:` / `unit_tests:` YAML entries, shown first in VS Code's refactor
  preview. Versioned models and per-model settings in `dbt_project.yml` are not renamed.
- **dbt Create staging model** (right-click a source table, or on a `source()` call) — creates
  `stg_<source>__<table>.sql` selecting the table's columns (read from the warehouse) and its YAML entry.
- **dbt New model…** (right-click a model folder) — creates a model from a template (`dbtCommander.newModelTemplate`,
  `{{name}}` placeholder) with a YAML entry.
- **Open in dbt docs** — jumps to a model's / source's / seed's / exposure's page in the static docs site
  (generated on first use).
- **Exposures and semantic models** in the sidebar and in Lineage.
- **Check connection (dbt debug)** in the status bar menu.

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
npm run test:integration # real VS Code + dbt-core 1.12 + duckdb against test/fixtures/demo
npm run package          # builds dist/ with esbuild and creates the .vsix
```

`test:integration` creates a dbt venv in `.vscode-test/dbt-venv` on first run (set `DBT_PYTHON` to choose the
Python). CI (`.github/workflows/ci.yml`) runs all of this on Windows for every push and pull request, and
publishes a GitHub release with the `.vsix` when a `v*` tag matching `package.json`'s version is pushed.
