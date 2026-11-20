# dbt Runner

Run dbt-core 1.x from the VS Code Explorer and editor, using dbt from a Python venv you choose.
Supports dbt-core 1.x (tested with 1.12); not dbt 2 / Fusion.

## Features

- **Right-click models or folders** under `models/` → **dbt** → Run / Build / Test.
  Multi-select works; folders run everything inside (`--select path:models/staging`).
- **Right-click seed CSVs** under `seeds/` (or its subfolders) → **dbt Seed** loads just those seeds
  (`--select path:seeds/ref/countries.csv`). Multi-select works, and open seed CSVs get a ▶ seed button.
- **Build + Upstream / + Downstream / + Upstream & Downstream** for a model (`+model`, `model+`, `+model+`).
- **▶ in the editor title** builds the open model. Unsaved changes are saved first.
- **Keyboard shortcuts** (while a model is open): `Ctrl+'` then
  `B` build · `R` run · `T` test · `C` compile · `P` preview.
- **dbt Compile** opens the compiled SQL beside the model.
- **dbt Preview Data** runs `dbt show` and shows the rows in a table (limit: `dbtRunner.previewLimit`, default 100).
- **Errors in the Problems panel**: compilation/runtime/database errors on the model (with the line when dbt
  gives one), test failures and warnings on the YAML file. A model's problems are replaced when it runs again.
- **Target switcher** in the status bar, listing the targets from your `profiles.yml`.
- **Project commands** — `deps`, `seed`, `snapshot`, and `docs generate` (builds the static docs page and opens
  it in your browser; `dbtRunner.openDocsAfterGenerate`) — from the `dbt` status bar menu or the command palette.
- **Run links above each model** — `Run · Build · Test · Compile · Preview` (`dbtRunner.codeLens` to turn off).
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
- **dbt sidebar** — the dbt icon in the Activity Bar shows Models (by folder), Sources, Seeds, Snapshots and Tests
  (by model), with run / build / test / seed / snapshot buttons, and Compile / Preview / Generate YAML on right-click.

- **dbt tests in the Testing panel** — every dbt test appears in VS Code's Testing view, grouped by model / source,
  with run buttons, Run All, Rerun Failed, pass/fail icons next to each test in your YAML, and dbt's failure
  message ("Got 2 results, configured to fail if != 0") at the test. Output goes to Test Results; a warn result
  shows as passed with the warning in the output.
- **Hover on `ref()` / `source()`** — description, materialization, file path and columns (types from
  `target/catalog.json` when you've run `dbt docs generate`).

Go to definition and autocomplete read `target/manifest.json`, which dbt rewrites on every run, build, compile or
parse — so they reflect your last dbt command. Without a manifest, `ref()` still jumps to a model file of that name.

## Setup

1. Install the `.vsix` from the [Releases](https://github.com/razjir-bote/vscode-dbt-runner/releases) page:
   `code --install-extension dbt-runner-<version>.vsix`
2. Click **dbt: not configured** in the status bar → **Settings**, browse to your venv (the folder containing
   `Scripts\dbt.exe`), check the detected version shows dbt-core 1.x, and Save.

Settings are saved per workspace. Extra flags apply to every command except `deps`
(quotes keep values together, e.g. `--vars '{"key": "value"}'`).

dbt runs your project's macros and hooks, so dbt Runner only runs in **trusted** workspaces, and in untrusted
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
