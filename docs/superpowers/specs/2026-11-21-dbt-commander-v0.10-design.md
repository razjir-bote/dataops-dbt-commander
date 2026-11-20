# DataOps dbt Commander v0.10 — design

## Intent
Query data without leaving VS Code (a dbt-aware SQL scratchpad and previewing part of a model), add tests from
YAML with one click, see what a macro does on hover, and stop the stored run state from growing forever.
User picked items 2, 3, 7, 11, 14.

## Goals
2. **SQL scratchpad** — *New dbt SQL scratchpad* (palette, status bar menu, sidebar title) opens an untitled SQL
   editor tied to a dbt project. **Ctrl+Enter** runs the editor's text — or just the selection — through
   `dbt show --inline` (so `ref()`, `source()`, macros and the active target all work) and shows the rows in the
   preview table. Errors show dbt's message.
3. **Preview selected SQL / a CTE in a model** — in a model, `Ctrl+'` then `Q` (also editor context menu
   "dbt Preview selection / CTE"):
   - with a selection: runs the selected SQL;
   - without one, cursor inside a CTE: runs `with <that CTE and the CTEs before it> select * from <that CTE>`;
   - otherwise: the whole model (same as Preview Data).
7. **Quick fixes in YAML** — a lightbulb on a column (`- name: col` under a model's `columns:`):
   *Add not_null test*, *Add unique test*, *Add unique + not_null tests*, *Add accepted_values test…* (asks for the
   values). Tests are added to the column's existing `data_tests:` / `tests:` list, or a new `data_tests:` list,
   without touching other lines. On a model `.sql` file with no YAML entry: lightbulb *Generate YAML for this model*.
11. **Hover on macros** — hovering a macro call shows its signature (`cents_to_dollars(col, scale=2)` from the
    macro file), description and documented arguments (from YAML `macros:` entries), and its package / file.
14. **Prune run state** — when the manifest changes, saved last-run results for nodes no longer in the project are
    dropped.

## Non-goals
Query history, saving scratchpads to files, result export (CSV), tests other than the four above, lint.

## Approaches (where there was a real choice)
**Scratchpad keybinding (2).** VS Code's Ctrl+Enter is "insert line below". Override it **only in scratchpads the
extension opened** (context key `dbtCommander.isScratchpad`), and use the existing chord `Ctrl+'` `Q` everywhere
else. (Alternative: Ctrl+Enter in every SQL file — would break the editor default in models.)

**Scratchpad files (2).** Untitled documents (nothing written into the user's project; VS Code asks to save on
close like any untitled file), each remembering its project. (Alternative: files under `<project>/.scratch/` —
survive restarts but add files to the repo.)

**CTE detection (3).** A small pure parser over the model text: finds the top-level `with` and each
`name as ( … )` block by bracket matching, skipping strings, comments and Jinja. Jinja inside CTEs is passed
through untouched (dbt compiles it).

## Design notes
- `scratch.ts` (pure): `ctesIn(sql)` → `[{name, start, end, bodyStart, bodyEnd}]`; `cteQueryAt(sql, offset)`.
- `yamlfix.ts` (pure): `columnAt(text, line)` → model / column / existing tests key; `addTestsEdit(text, line, tests)`
  → text insertions (indentation-aware, CRLF-preserving).
- Preview panel reused (title = "Query" / model name / CTE name).
- Macro hover: manifest macros gain `description`, `arguments`; signature read from the macro file.
- Prune: `pruneRunState(state, liveIds)` (pure) applied by RunStatusStore on manifest change.

## Claude's calls (correct if wrong)
- Ctrl+Enter only in scratchpads; `Ctrl+'` `Q` for previews in models.
- Untitled scratchpads.
- New tests go under `data_tests:` (dbt ≥ 1.8 name) unless the column already uses `tests:`.
- Commit only; release when asked.
