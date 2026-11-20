# DataOps dbt Commander v0.13 — YAML autocomplete

## Intent
Write dbt property files (schema.yml, sources.yml, …) without looking up names: suggest the project's models,
columns, tests and config keys / values where they fit, from the manifest (and catalog.json for column types).

## Goals
Completions in `.yml` / `.yaml` files inside a dbt project (not `target/` or installed packages), by position:

1. **Resource names** — `- name: |` under `models:` → the project's models, the ones **without a YAML entry yet**
   first (marked "not documented yet"); under `seeds:` → seeds, `snapshots:` → snapshots, `macros:` → macros,
   `exposures:` / `semantic_models:` nothing (they are defined here).
2. **Columns** — `- name: |` under a model's / seed's / snapshot's / source table's `columns:` → its columns from
   `catalog.json` (with data type), then other columns dbt knows from the manifest, leaving out ones already listed
   in that entry. No catalog → an item explaining *Run dbt docs generate (or Generate YAML) for column names*.
3. **Tests** — list items under `data_tests:` / `tests:` (model or column level) → `unique`, `not_null`,
   `accepted_values`, `relationships`, plus every generic test in the project and installed packages
   (`test_*` macros, e.g. `dbt_utils.expression_is_true`). Tests with arguments insert a snippet with tab stops,
   under `arguments:` for dbt ≥ 1.10 (as the v0.10 quick fixes do).
4. **Keys** — the right property keys for where the cursor is: top level (`version`, `models`, `sources`, `seeds`,
   `snapshots`, `macros`, `exposures`, `unit_tests`, `semantic_models`, `groups`, …), a model entry (`description`,
   `columns`, `config`, `data_tests`, `docs`, `meta`, `versions`, `latest_version`, `constraints`, …), a column
   (`description`, `data_type`, `data_tests`, `meta`, `quote`, `constraints`, …), a source / table, `config:`
   (`materialized`, `schema`, `alias`, `tags`, `enabled`, `unique_key`, `incremental_strategy`,
   `on_schema_change`, `contract`, `persist_docs`, `grants`, …). Keys already present in that mapping are left out.
5. **Config values** — `materialized:` → `view`, `table`, `incremental`, `ephemeral`, `materialized_view` and the
   adapter's / project's custom materializations (`materialization_*` macros); `on_schema_change:`,
   `incremental_strategy:`, `enabled:` / booleans.
6. **ref() / source() in YAML** — `to: ref('|` (relationships), unit tests' `model:` and `ref('` / `source('` in
   `depends_on:` → models / sources, reusing the SQL completion.

## Non-goals
Validating YAML (item 18), doc blocks (item 16), JSON-schema-level completion of every dbt property, fetching
columns from the warehouse while typing.

## Approaches (where there was a real choice)
**How to know where the cursor is.** A small pure YAML-path reader over the text (indentation + `key:` / `- `),
like the v0.10 quick fixes — works on half-typed, invalid YAML, which a YAML parser rejects. (Alternative:
parse with the `yaml` library — fails on the incomplete line being typed.)

**Columns source.** `catalog.json` only (fast, typed) plus the manifest; no warehouse query on keystrokes.
Generate YAML (v0.6) remains the way to pull columns from the warehouse.

**Coexisting with the Red Hat YAML extension.** Both providers' items appear; ours are dbt-specific and sorted
first in dbt files. No settings changes to other extensions.

## Design notes
- `yamlcontext.ts` (pure): `yamlContextAt(text, line, col)` → `{ path: string[]; kind: 'key' | 'value' | 'listItem';
  key?: string; owner?: { section, name, source? }; siblings: string[] }` (e.g. path
  `['models', '-', 'columns', '-', 'data_tests', '-']`).
- `yamlcomplete.ts` (pure): which suggestions for a context (`keysFor(path)`, `valuesFor(key)`, test snippets).
- `language.ts`: a completion provider for project YAML files using the manifest / catalog caches.
- Trigger characters: space after `name:` / `materialized:`, `-`, and normal word completion.

## Claude's calls (correct if wrong)
- Undocumented models first in `- name:` suggestions under `models:`.
- Snippets use `data_tests:` / `arguments:` per the dbt version, like the quick fixes.
- Commit only; release when asked.
