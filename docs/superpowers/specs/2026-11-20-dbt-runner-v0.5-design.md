# dbt Runner v0.5 — design

## Intent
Make dbt tests feel like any other test suite in VS Code, and let you see what a `ref()`/`source()` points at
without leaving the model you're writing. User picked these two from the feature list.

## Goals
1. **dbt tests in the Testing panel** (VS Code Testing API)
   - Tree: dbt project → model (or `source.table`, or "(singular tests)") → test. Same grouping as the sidebar.
   - Run buttons on every level, "Run All", and **Rerun Failed Tests**; pass/fail icons in the panel and in the
     editor gutter next to each test in the YAML (or the singular test `.sql`).
   - A failed test shows dbt's message ("Got 2 results, configured to fail if != 0") at the test's location.
   - Output streams into the Test Results panel (colours kept); Stop cancels the run and kills dbt.
2. **Hover on `ref()` / `source()`**
   - Model: name, description, materialization, file path (clickable), and columns (name · type · description).
   - Source table: `source.table`, source + table description, loader/identifier if set, YAML path, columns.

## Non-goals
Running models from the Testing panel, test coverage, debugging, hover on macros, hover on columns.

## Approaches (where there was a real choice)
**How a test run reports results (1).**
- **A. Run dbt ourselves inside the TestRun, read `target/run_results.json` (chosen, Claude's call)** —
  one `dbt test --select …` per run request; each result's `status` (pass / fail / warn / error / skipped),
  `message` and timing map onto the test items. Exact, adapter-independent.
- **B. Parse the console output** — fragile; we already learned dbt 1.12 changed the failure format.
- **C. Launch through the existing terminal task** — results would need the same parsing, and output would be
  split between terminal and Test Results.

**Selecting tests:** generic tests by name, singular tests by `path:` (as in the sidebar). Running a whole model
group selects its tests by name; "Run All" for a project runs `dbt test` with no selector (no huge command line).

**Status mapping:** pass → passed; fail/error → failed (with message); skipped → skipped; **warn → passed**
with the warning shown in the output and as the test's message (VS Code has no "warned" state).

**Columns in hovers (2):** from the manifest (documented columns, with `data_type` if declared). If
`target/catalog.json` exists (after `dbt docs generate`), it adds the warehouse's actual column types and any
undocumented columns. No warehouse calls on hover.

## Design notes
- `manifest.ts`: tests gain `columnName`, `kind: 'generic' | 'singular'`; models gain `description`, `columns`;
  sources gain `description`, `sourceDescription`, `loader`, `identifier`, `columns`. Pure + unit-tested.
- `runresults.ts` (pure): `parseRunResults(json)` → `{ name, uniqueId, status, message, seconds }[]`;
  `testLocation(yamlText, model, column?)` → line of the column (or model) in the YAML.
- `testing.ts`: `TestController` `dbtRunner.tests`, rebuilt when the manifest changes (shared watcher);
  run profile spawns dbt like the runner (killTree on cancel, Problems panel updated as today).
- `hover.ts`: `HoverProvider` using the shared manifest cache and an mtime-cached `catalog.json`.
- Integration tests: Testing tree contents, run one test (pass), run a failing test (fail + message), run a
  model group, hover text for a model and a source.

## Changes after review (implementation)
- Test runs snapshot their items up front and always end the TestRun; the tree refresh builds new maps and swaps
  them in, so a manifest rewrite mid-run (dbt test does this) can't break a run.
- run_results.json is accepted only from this invocation: new `invocation_id`, `args.which == "test"`,
  `generated_at` after the run started.
- A requested project runs `dbt test --exclude …` for excluded tests; other selections are batched (~20k chars)
  to stay under the Windows command-line limit.
- A manifest read that fails (half-written file) isn't cached.
- Test locations only match entries under `models:` / `tables:`; hovers can't load remote images; names escaped.

## Claude's calls (correct if wrong)
- Results from `run_results.json`; output in Test Results (not the terminal).
- warn shown as passed-with-message.
- Hover columns: manifest + catalog.json when present, no warehouse query.
- Ships as v0.5.0 on top of the unreleased v0.4.0, committed only.
