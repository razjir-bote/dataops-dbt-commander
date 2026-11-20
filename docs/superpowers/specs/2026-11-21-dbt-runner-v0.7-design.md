# dbt Runner v0.7 — design

## Intent
Make the extension work in projects that don't use dbt's default folder names, and make the loop after a run
faster: see how each model did, rerun what failed or what you just ran, know when a long run ends, find the slow
models, and write SQL against models' columns with less looking things up.
User picked 1, 2, 3, 4, 8, 9, 10, 14, 15 from the list.

## Goals
1. **Custom folder names** — `model-paths`, `seed-paths`, `snapshot-paths` (and `analysis-paths`,
   `macro-paths`, `test-paths`) are read from `dbt_project.yml`. Menus, CodeLens, shortcuts, go-to-definition
   scope and the sidebar work for e.g. `model-paths: ["transform"]`, not only `models/`.
2. **Custom `packages-install-path`** — installed packages are found wherever dbt installs them.
3. **dbt retry** — `dbt retry` (reruns only the nodes that failed or were skipped last time) from the command
   palette, the dbt status bar menu, a **Retry** button on the failure notification, and the Last run view.
4. **Rerun last command** — `Ctrl+'` then `L`, palette and status bar menu: repeats the last dbt command
   the extension ran (same arguments, project, target).
8. **Notify when a long run finishes** — a notification "dbt build finished: 12 passed, 1 error (2m 10s)" with
   Retry / Show output. Shown when the run took longer than `dbtRunner.notifyAfterSeconds` (default 30; 0 = off).
9. **Last run status on each model** — sidebar items and CodeLens show e.g. `✓ 3m ago · 1.2s` or `✗ error 5m ago`
   for models, seeds, snapshots and tests.
10. **Last run view** — a "Last run" view in the dbt sidebar: the latest run's command, totals and duration;
    nodes sorted slowest first with status icon and time; click to open; Retry when anything failed.
14. **Column autocomplete** — after `from {{ ref('orders') }} o` / `join {{ source('raw','x') }} as x`, typing
    `o.` or `x.` suggests that model's / source's columns (documented + catalog types when present).
15. **Find references** — Shift+F12 on `ref('orders')` (or anywhere in `orders.sql`) lists every model, snapshot
    and analysis that refs it, at the `ref(...)` line.

## Non-goals
Dynamic paths from Jinja in dbt_project.yml, column-level lineage, unit tests in the Testing panel, run history
beyond the latest result per node.

## Approaches (where there was a real choice)
**Menus for custom folders (1).** VS Code menu conditions are static.
- **A. Context keys (chosen, Claude's call)** — the extension computes the set of model / seed folders and files
  from each project's configured paths and publishes them with `setContext`; menus use
  `resourcePath in dbtRunner.modelPaths` alongside the existing default-folder rules. Updates on
  dbt_project.yml / file changes.
- **B. Show the menus everywhere and refuse at run time** — simpler, but the menu appears on every .sql/.csv file.

**Where "last run status" comes from (9, 10).**
- **A. `target/run_results.json`, merged per node over time (chosen)** — every dbt command (from the extension or
  a terminal) updates it; the extension keeps the newest result per node in workspace state, so building model A
  doesn't erase B's status. `dbt retry` / interrupted runs handled by the same freshness rules as the Testing panel.
- **B. Only the extension's own runs** — misses terminal runs.

**Retry (3):** run dbt's own `dbt retry` (dbt ≥ 1.6) in the run's project rather than rebuilding a selector.

## Design notes
- `projectconfig.ts` (pure): `projectPaths(dbt_project.yml text)` → `{ model, seed, snapshot, analysis, macro, test,
  packagesInstall, target }` with dbt defaults.
- Manifest path resolution uses `packagesInstall` instead of `dbt_packages`.
- `runstate.ts` (pure): `mergeResults(prev, runResults, generatedAt)`, `statusBadge(result, now)`,
  `runSummary(results)` → counts; `slowest(results)`.
- `columns.ts` (pure): `aliasesIn(text)` → alias → ref/source call; column list from manifest + catalog.
- References: from `child_map`, plus a text search for the `ref('name')` line in each child file.
- Runner remembers the last command (args, root, title) for Rerun; notifications use the parsed summary.

## Claude's calls (correct if wrong)
- "49" read as items 4 and 9.
- Context keys for custom-folder menus.
- Notify threshold 30 s, setting to change / turn off.
- Status kept per node in workspace state (survives reloads), latest result only.
- Commit only (no release).
