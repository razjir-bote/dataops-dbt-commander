# dbt Runner v0.4 — design

## Intent
Less hunting through files: jump to any macro, get a model's YAML written for you, and see the whole
project in one sidebar with run buttons. User picked these three from the feature list.

## Goals
1. **Go to definition for macros** — Ctrl+click / F12 on `{{ my_macro(...) }}`, `{{ dbt_utils.star(...) }}`,
   `{% call my_macro() %}`, `{{ adapter.dispatch(...) }}` is out of scope (see non-goals). Opens the file at the
   `{% macro name(` line. Covers the project's macros, installed packages (`dbt_packages/<pkg>`), and dbt's own
   / adapter macros inside the venv (`site-packages/dbt/include/global_project`, `.../include/<adapter>`).
2. **Generate YAML for a model** — right-click a model → **dbt Generate YAML**: writes a `models:` entry with every
   column (name + `data_type` + empty `description`), then opens the file at the entry.
3. **dbt project sidebar** — a "dbt" icon in the Activity Bar with one tree:
   Models (by folder) · Sources (source → tables) · Seeds · Snapshots · Tests (grouped by the model they test).
   Click opens the file; inline buttons: Run/Build/Test on models & model folders, Seed on seeds, Snapshot on
   snapshots, Test on tests; a refresh button; a "Run dbt parse" prompt when there's no manifest.

## Non-goals
Macro references, macro autocomplete, `adapter.dispatch` resolution, YAML for sources/seeds, lineage view,
editing descriptions from the sidebar.

## Approaches (where there was a real choice)
**Where columns come from (2).**
- **A. Ask the warehouse via dbt (chosen, Claude's call)** — `dbt compile --inline` rendering
  `adapter.get_columns_in_relation(ref('<model>'))`. Works on any adapter with plain dbt-core 1.12 (verified on
  duckdb), current as of the model's last build. Needs the model built; if it isn't, offer **Build & retry**.
- **B. `target/catalog.json`** — no warehouse call, but only exists after `dbt docs generate` and is often stale.
- **C. The `codegen` package** — common, but requires the user to install a package.

**Where the YAML goes (2), Claude's call:**
- Model already has a YAML entry (manifest `patch_path`) → add only the **missing** columns to it, keeping
  existing descriptions/tests.
- Else, a `.yml` in the model's folder that already has `models:` → append the entry there.
- Else create `<model_name>.yml` next to the model.
Edits go through a VS Code edit (undoable, file left unsaved for review) rather than writing to disk directly.

**Sidebar data (3):** from `target/manifest.json` (same cache as go-to-definition), refreshed when the manifest
changes on disk. Running dbt from the sidebar reuses the existing commands, so Problems, targets and flags all
apply.

## Design notes
- `manifest.ts` gains macros `{name, package, file}` (path rules above) and node lists for seeds, snapshots, tests
  (test → `attached_node`/`depends_on` model). Pure + unit-tested.
- `jinja.ts` gains `macroCallAt(line, col)` → `{ package?, name }` for `name(` / `pkg.name(` not in
  `ref|source|config|var|env_var|is_incremental|this|...` (Jinja/dbt built-ins skipped).
- `yamlgen.ts` (pure): `modelYaml(name, columns)`, `mergeColumns(existingYamlText, model, columns)` using the `yaml`
  library's document API so comments and formatting in an existing file survive.
- Sidebar: `TreeDataProvider` in `sidebar.ts`, view container `dbtRunner`, view `dbtRunner.project`.
- Tests: unit tests for the pure parts; integration steps for macro definition (project + dbt core macro),
  YAML generation (new file and merge into existing), and the sidebar tree contents + a run from it.

## Changes after review (implementation)
- YAML edits insert text at the end of the right list instead of re-serialising the file, so existing lines stay
  byte-identical (folded descriptions, flow lists, comments, indentation style, CRLF). Re-serialising is only a
  fallback for `models: []` / flow lists.
- Files with several YAML documents or parse errors are never edited; an existing `<model>.yml` is appended to.
- Versioned and ephemeral models get an explanatory message; "Build & retry" is offered once.
- Scalars PyYAML would misread (`on`, `yes`, `2024`, `null`) are quoted.
- Macro go-to-definition only inside `{{ }}` / `{% %}`; bare calls resolve like dbt (project, then dbt/adapter
  macros; other packages need their prefix).
- Sidebar lists only the project's own sources; source tests are grouped under the source; singular tests run by path.
- Deferred: custom `packages-install-path` (macros/models in installed packages assume `dbt_packages/`).

## Claude's calls (correct if wrong)
- Columns from the warehouse via `dbt compile --inline` (model must be built).
- YAML placement rules above; merges never remove or overwrite existing columns.
- One sidebar tree with five sections; Tests grouped by model.
- Ships as v0.4.0 (committed; release when you ask).
