# DataOps dbt Commander

Run and develop dbt-core projects from VS Code: run, build and test models from the Explorer, a dbt sidebar or the
editor; preview data and CTEs; see errors and test results where they belong; navigate `ref()` / `source()`; and
generate staging, SCD2 and YAML files in your team's patterns. dbt runs from a Python virtual environment you choose.

- **Works with:** dbt-core 1.x (tested with 1.12) and any adapter installed in that venv (Synapse / SQL Server,
  Databricks, Snowflake, DuckDB, …). Not dbt 2 / dbt Fusion.
- **Needs:** VS Code 1.90 or later. Tested on Windows.

---

## Install

1. **Have a venv with dbt.** If your project doesn't have one yet:

   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\python -m pip install dbt-core dbt-databricks   # or dbt-synapse, dbt-snowflake, …
   ```

2. **Download the extension.** On the [Releases page](https://github.com/razjir-bote/dataops-dbt-commander/releases),
   download `dataops-dbt-commander-<version>.vsix` from the latest release.

3. **Install it** — either:
   - in VS Code: **Extensions** view → **⋯** (top right) → **Install from VSIX…** → pick the file; or
   - from a terminal:

     ```powershell
     code --install-extension dataops-dbt-commander-0.16.0.vsix
     ```

   Then reload the window (**Developer: Reload Window**).

4. **Point it at your venv.** Open your dbt project folder (the one with `dbt_project.yml`; a parent folder works
   too). Click **dbt: not configured** in the status bar → **Settings**, browse to the venv folder (the one that
   contains `Scripts\dbt.exe`), check that the detected version shows dbt-core 1.x, choose a target if you use one,
   and **Save**. Settings are saved for this workspace.

5. **Trust the workspace** if VS Code asks. dbt runs your project's macros and hooks, so the extension only runs dbt
   in trusted workspaces.

6. **Check the connection** (optional): status bar **dbt** menu → **Check Connection (dbt debug)**.

**Updating:** install the newer `.vsix` the same way (it replaces the old one) and reload the window.

**Optional — SQLFluff linting:** `.\.venv\Scripts\python -m pip install sqlfluff`, then set **Linting** to *On* on
the settings page. See [Linting](#linting-sqlfluff-optional).

---

## Getting started

1. Click the **dbt** icon in the Activity Bar. The **Project** view lists your Models (by folder), Sources, Seeds,
   Snapshots and Tests. If it says *No manifest yet*, click it to run `dbt parse`.
2. Hover a model and click **▶ Run** or **Build** — the output appears in the terminal, errors in the Problems panel,
   and a ✓ / ✗ badge next to the model.
3. Open a model. Above it: **Run · Build · Test · Compile · Preview**. Click **Preview** to see its rows in a table.
4. Put the cursor inside a CTE and press `Ctrl+'` then `Q` — that CTE's rows, without saving or building anything.
5. Right-click anything dbt — a model, a folder, a seed CSV, inside the editor — and open **dbt ▸** for everything
   else it can do.

---

## Where things are

| Place | What's there |
|---|---|
| **Status bar** | **dbt** (version, menu of project commands: deps, seed, snapshot, docs generate, retry, check connection, settings) · **target** switcher · **dbt parse** while the background parse runs |
| **dbt sidebar** (Activity Bar) | **Project** (models, sources, seeds, snapshots, tests, exposures, semantic models — with run buttons), **Lineage** (upstream / downstream of the open model), **Last run** (the latest run's results, slowest first) |
| **Right-click → dbt ▸** | The one list, the same everywhere (Explorer, editor tab, inside the editor, sidebar, Lineage), showing only what applies: Run · Build · Test · Seed · Snapshot · Run Test — Build + Upstream / + Downstream / + Upstream & Downstream · Build SCD2 Chain — Compile · Copy Compiled SQL · Preview Data · Preview Selection / CTE · Show Lineage · Open in dbt Docs — Generate YAML · New Model… · Create Staging Model · Create SCD2 Models and Gates Test… · Add Seed as Source… — Rename Model… — SQLFluff: Lint File · Fix File — Open Settings |
| **Editor title** | ▶ builds the open model (saves first) / seeds the open seed CSV |
| **Above each model** | Run · Build · Test · Compile · Preview, and the last result (`✓ 3m ago · 1.2s`) |
| **Testing view** | Every dbt test, with run buttons and pass / fail |
| **Command Palette** | Everything, under **dbt Commander:** |

### Keyboard shortcuts

In a model, press `Ctrl+'` (`Cmd+'` on macOS), then:

| Key | Does |
|---|---|
| `B` / `R` / `T` | Build / Run / Test the model |
| `C` | Compile (opens the compiled SQL beside it) |
| `P` | Preview the model's data |
| `Q` | Preview the selection, or the CTE under the cursor |
| `Y` | Copy the compiled SQL (of the selection / CTE / model) |
| `L` | Rerun the last dbt command |

In a SQL scratchpad, `Ctrl+Enter` runs the query (or the selection).

---

## What it can do

### Run dbt

- **Run / Build / Test / Seed / Snapshot** models, folders, seeds, snapshots and tests from the Explorer, the
  sidebar, the editor or the shortcuts. **Multi-select** (Ctrl/Shift-click) runs everything selected as one dbt
  command. A folder runs everything inside it (`--select path:models/staging`); the project folder runs the whole
  project.
- **Build + Upstream / + Downstream / + Upstream & Downstream** (`+model`, `model+`, `+model+`).
- **Project commands** — `deps`, `seed`, `snapshot`, `docs generate` (opens the static docs in your browser) — from
  the status bar menu.
- **Target switcher** in the status bar, listing the targets in your `profiles.yml`.
- **dbt retry** reruns only what failed; **Rerun Last dbt Command** (`Ctrl+'` `L`) repeats the last one.
- A notification with the results when a run takes longer than 30 s (`dbtCommander.notifyAfterSeconds`), with
  **Retry** when something failed.
- **Extra flags** (settings page) are added to every command, e.g. `--vars '{"key": "value"}'`.

### See results and problems

- **Problems panel:** compilation, runtime and database errors on the model (at the line when dbt gives one); test
  failures and warnings on the YAML. A model's problems are replaced when it runs again.
- **Last results everywhere:** `✓ 3m ago · 1.2s` / `✗ error 5m ago` next to every model, seed, snapshot and test in
  the sidebar and above each model — from every dbt run, including ones you start in your own terminal.
- **Last run view:** the latest run's nodes, slowest first.
- **Testing view:** every dbt test grouped by model / source, with Run, Run All and Rerun Failed, pass / fail icons
  next to each test in your YAML, and dbt's failure message ("Got 2 results, configured to fail if != 0").

### Preview data and SQL

- **Preview Data** runs `dbt show` and opens the rows in a table (100 rows by default,
  `dbtCommander.previewLimit`). Sort by clicking a header, filter with the box, **Copy** (pastes into Excel /
  Sheets) or **Save CSV…**; **Σ** on a header profiles that column.
- **Preview Selection / CTE** (`Ctrl+'` `Q`) previews:
  - the selected SQL;
  - **whole CTEs selected** (`b as (…)`, with or without the comma after it, or several) — the last one, with the
    model's other CTEs included so the ones it reads from are there;
  - with no selection, **the CTE under the cursor**;
  - elsewhere, the whole model. It uses the editor's text, unsaved edits included.
- **Copy Compiled SQL** (`Ctrl+'` `Y`) puts the compiled SQL of the same thing on the clipboard — `ref()` /
  `source()` resolved for your target — ready to paste into the Synapse / Databricks SQL editor. For a saved
  model it's exactly what dbt runs. **Open** in the notification shows it in a tab.
- **Compile** (`Ctrl+'` `C`) opens the compiled SQL beside the model.
- **SQL scratchpad** (status bar menu or sidebar title → **New SQL Scratchpad**): an unsaved `dbt-scratch-N.sql`
  where `ref()`, `source()`, macros and the active target work; `Ctrl+Enter` runs it.
- **Column profile:** row count, nulls, distinct values, min, max and the 10 most common values — from **Σ** in a
  preview, or the lightbulb on a column in YAML.

### Write SQL and YAML faster

- **Go to definition** (Ctrl+click / F12) on `ref()`, `source()` and macro calls — your macros, packages' and dbt's
  own. **Find references** (Shift+F12) on a model lists everything that refs it.
- **Hovers** on `ref()` / `source()` (description, materialization, columns and types) and on macros (signature,
  arguments).
- **Autocomplete:** model names in `ref('`, sources and tables in `source('`, a model's columns after its alias
  (`o.`), and in YAML: model / seed / macro names, column names, tests (built-in and from packages such as
  `dbt_utils`), keys and config values that fit where you are.
- **Tests from YAML:** the lightbulb on a column adds `unique`, `not_null`, `accepted_values`, `relationships`, and
  with dbt_utils `not_empty_string`, `not_constant`, `at_least_one`, `accepted_range`.
- **Generate YAML:** writes a model's `models:` entry with every column and its type, read from the warehouse (the
  model must be built). Only missing columns are added to an existing entry.
- **Rename Model…:** renames the file, every `ref()` to it, and its YAML entries — shown first in VS Code's refactor
  preview.
- **New Model…** in a model folder, from your template (`dbtCommander.newModelTemplate`) with a YAML entry.

### Generate models in the team's patterns

- **Create Staging Model** — right-click a source table (sidebar, a `source()` call, or its entry in a sources YAML)
  → `stg_<system>__<entity>.sql` in `models/staging/<system>/` (the table name split at its first underscore:
  `ace_aus_accounttag_account` → `stg_ace__aus_accounttag_account`), plus its YAML:
  - every column trimmed, blank → NULL, and typed (`…On` / `_ts` / `_at` → DATETIME2, `_date` → DATE, else
    NVARCHAR(4000)); columns already typed in the warehouse are cast directly;
  - `Id` kept and copied to `entity_id`;
  - the newest load kept per `_landing_extract_date` + `entity_id` (no key: per every column not starting with `_`);
  - rows with `IsDelete` other than false / 0 dropped.

  Every rule is a `dbtCommander.bronzeStaging.*` setting. The SQL is T-SQL (Synapse / SQL Server).
- **Create SCD2 Models and Gates Test…** — right-click a `stg_` model:
  - `int_<source>__<entity>__changekey.sql` — only extracts the history table hasn't loaded yet, with
    `attribute_hash` = `versionnumber`, else `_full_row_hash`, else `{{ hash_columns([...]) }}` over the data columns
    (the `hash_columns` macro is added when needed; it never passes more than 8000 bytes to `HASHBYTES`, however wide
    the table);
  - `dim_<source>__<entity>__candidate` / `__history` / `__published` in `models/intermediate/scd2/generated/`,
    calling your `scd2_*` macros;
  - the test `tests/scd2/generated/dim_<source>__<entity>__gates.sql` (`scd2_gate_test`);
  - the dimension's entry in `scd2_dimensions:` in `vars.yaml`.

  Existing files and entries are kept; a missing `scd2_*` macro is reported. Settings: `dbtCommander.scd2.*`.
- **Build SCD2 Chain** — right-click a `stg_` model → `dbt build` of that model, its change-key model, the
  `__candidate` / `__history` / `__published` models and the `__gates` test, and nothing further downstream
  (several `stg_` files selected: all their chains in one build). Names
  follow `dbtCommander.scd2.historyPrefix`, with `__` or `_` before the suffix (`int_ace__stringmap_changekey`
  works too); `--indirect-selection buildable` leaves out tests that also read a
  model past the chain.
- **Add Seed as Source…** — right-click seed CSVs → adds them as tables of a source (default `bronze`) with the CSV
  header as columns, so you can build staging models on sample data. Run *dbt seed* to load them.

### Lineage and docs

- **Lineage view:** the open model's upstream (models, seeds, snapshots, sources) and downstream (models, snapshots,
  exposures), expandable level by level. It follows the active editor; **Show Lineage** on anything in the sidebar —
  including a source table, exposure or semantic model — pins it there.
- **Open in dbt Docs:** jumps to a node's page in the static docs site (generated on first use).

### Keeps up by itself (auto-parse)

Saving, adding or deleting models, YAML, seeds, snapshots, macros or tests runs `dbt parse` in the background, so
the sidebar, Tests view, lineage and completion stay current without a command. It waits for a burst of saves to
finish, never runs beside another dbt command in the same project (those wait for it), and shows **dbt parse** —
or **dbt parse failed**, click for dbt's output — in the status bar. Turn it off on the settings page or with
`dbtCommander.autoParse`.

### Linting (SQLFluff, optional)

Off by default. With SQLFluff in the dbt venv, set **Linting** to *On* (or *Auto*: on when the venv has SQLFluff)
on the settings page:

- problems for dbt SQL files on open and save;
- **Format Document** uses `sqlfluff fix`; **SQLFluff: Lint File / Fix File** in the editor's dbt menu;
- **Fix on save** (a separate opt-in) fixes files you save yourself.

Your `.sqlfluff` / `.sqlfluffignore` are used; with no dialect configured, the dbt adapter's is passed (`synapse` →
`tsql`, `databricks`, `snowflake`, `duckdb`, …). *Off* never starts SQLFluff.

**dbt templater** (`templater = dbt`, from `pip install sqlfluff-templater-dbt`): it can't read the editor's text, only
the saved file, so with it SQLFluff checks and fixes the file as saved. Problems update when you save; fix on save
runs just after the save; **Fix File** saves first; **Format Document** on unsaved edits asks you to save first.
Your file is never rewritten by SQLFluff: the fix goes into the editor as one undo step. The jinja templater (the
default) has none of these limits and is much faster.

### Also

- Custom `model-paths`, `seed-paths`, `snapshot-paths` and `packages-install-path` in `dbt_project.yml` are respected
  everywhere.
- Exposures and semantic models show in the sidebar and in Lineage.

---

## Settings

Open them from the status bar **dbt** menu → **Open Settings** (a page with the main ones), or VS Code's Settings
under *DataOps dbt Commander*.

| Setting | Default | What it does |
|---|---|---|
| `dbtCommander.venvPath` | — | The venv with dbt-core (the folder containing `Scripts\dbt.exe`) |
| `dbtCommander.target` | profile default | `--target` for every command |
| `dbtCommander.extraArgs` | — | Flags added to every command except `deps` |
| `dbtCommander.autoParse` | on | Background `dbt parse` when project files change |
| `dbtCommander.previewLimit` | 100 | Rows in Preview Data |
| `dbtCommander.codeLens` | on | Run · Build · Test · Compile · Preview above models |
| `dbtCommander.notifyAfterSeconds` | 30 | Notify when a run takes longer (0 = never) |
| `dbtCommander.openDocsAfterGenerate` | on | Open the static docs after `docs generate` |
| `dbtCommander.newModelTemplate` | — | Template file for New Model… (`{{name}}` placeholder) |
| `dbtCommander.sqlfluff.*` | off | Linting, fix on save, dialect, extra SQLFluff flags |
| `dbtCommander.bronzeStaging.*` | team pattern | Create Staging Model rules (types, key, dedupe, delete flag) |
| `dbtCommander.scd2.*` | team pattern | SCD2 folders, history schema / prefix, hash columns, vars file |

---

## Troubleshooting

- **Nothing runs / "dbt: not configured"** — set the venv path on the settings page, and trust the workspace.
- **The sidebar is empty or out of date** — click **dbt parse** in the sidebar title (auto-parse does this when
  files change). Navigation, completion and lineage read `target/manifest.json`.
- **"dbt parse failed" in the status bar** — click it for dbt's error; the sidebar keeps the last good parse.
- **Column types missing in completion / hovers** — run *docs generate* once (types come from `target/catalog.json`).
- **A preview says the query is too long on Windows** — select a smaller part (Windows limits command lines to
  32,767 characters).
- **Generated staging / change-key SQL fails on Databricks or Snowflake** — those templates are T-SQL (Synapse /
  SQL Server).

---

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
Developer notes: [docs/HANDOVER.md](docs/HANDOVER.md).
