# dbt Runner v0.8 — design

## Intent
Take over the common, error-prone project edits (renaming a model, adding staging models, starting new models)
and round out navigation (exposures / semantic models, jump to a model's docs page, connection check).
User picked items 4, 5, 6, 7, 12, 13 from the list.

## Goals
4. **dbt debug** — "Check connection (dbt debug)" in the status bar menu and palette: runs `dbt debug` in the
   project's terminal task; a notification says "All checks passed" or lists the failing checks.
5. **Rename model** — right-click a model (Explorer, sidebar, editor) → *dbt Rename model…* → new name:
   renames the `.sql` file, rewrites every `ref('old')` / `ref("old")` / `ref('pkg', 'old')` in the project
   (models, snapshots, analyses, tests, macros), renames its YAML entry (`- name: old` under `models:`), and
   moves compiled problems. Shown as one WorkspaceEdit preview (refactor preview) so the user can untick changes;
   undoable.
6. **Staging model from a source** — right-click a source table (sidebar, or `source()` in SQL) →
   *dbt Create staging model*: creates `stg_<source>__<table>.sql` (`select <columns> from {{ source(...) }}`,
   one column per line) in a configured folder (default `<first model-path>/staging/<source>/`), plus its YAML
   entry with the columns (via Generate YAML's writer). Columns from the warehouse via dbt (as Generate YAML);
   if that fails, `select *` with a TODO comment.
7. **New model** — right-click a folder under model-paths → *dbt New model…* → name: creates `<name>.sql` from a
   template (a `with source as (...) select * from source` skeleton with a `ref()` placeholder, or the user's own
   template file via setting `dbtRunner.newModelTemplate`) and an empty YAML entry; opens it.
12. **Exposures and semantic models** — new sidebar sections "Exposures" and "Semantic models" (click opens
   the YAML at the entry); both appear in Lineage (exposures already downstream; semantic models downstream of
   their model); hover shows them too.
13. **Open in dbt docs** — right-click a model / source / seed / snapshot / exposure → *Open in dbt docs*: opens
   `target/static_index.html#!/model/<unique_id>` (or `source/`, `seed/`, …) in the browser, running
   `dbt docs generate --static` first if the page is missing or older than the manifest.

## Non-goals
Renaming sources / columns / seeds, codegen-package compatibility, editing exposures, dbt Cloud docs URLs.

## Approaches (where there was a real choice)
**Rename (5).**
- **A. WorkspaceEdit with refactor preview (chosen, Claude's call)** — VS Code's own rename preview lists every
  file and line; nothing changes until the user applies; one undo.
- **B. Apply immediately** — faster, but a project-wide regex rewrite with no preview is risky.
- Implemented as a command, not F2 (F2 on `ref('x')` would also work later; command first).

**Where references to rewrite come from:** text search over all project SQL/YAML for `ref(...)` calls whose
parsed name is the model (same parser as find-references), not only manifest children — so macros, tests and
files dbt didn't parse are included.

**Staging columns (6):** warehouse columns via `dbt compile --inline` + `adapter.get_columns_in_relation(source(...))`
(same mechanism as Generate YAML, works on any adapter); fallback `select *`.

## Claude's calls (correct if wrong)
- Staging name `stg_<source>__<table>` (dbt Labs convention) and folder `<model-path>/staging/<source>/`,
  both editable in the input box before creating.
- New model template: built-in skeleton unless `dbtRunner.newModelTemplate` points to a file
  (placeholders `{{name}}`).
- Docs: regenerate the static page automatically when missing/stale (it takes a few seconds).
- Commit only.
