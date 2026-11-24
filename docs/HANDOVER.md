# DataOps dbt Commander — developer handover

Keep this file current: update it in the same commit as any change to features, architecture, build/release
process, or known issues. Last updated: 2026-11-24 (v0.16.1 released).

## What this is
A VS Code extension (TypeScript) for working with **dbt-core 1.x** (tested with 1.12.7) on **Windows**, running
dbt from a **Python venv** the user picks in a settings panel. Not for dbt 2 / Fusion. Public repo:
https://github.com/razjir-bote/dataops-dbt-commander — releases ship a `.vsix` (not on the Marketplace).
Formerly **dbt Runner** (repo https://github.com/razjir-bote/vscode-dbt-runner, left as it was: releases v0.1–v0.6.1;
its v0.8.0 tag has no release because that CI run failed). The new repo has the full history but none of the old tags.
Git remotes in the working copy: `origin` = new repo, `legacy` = old repo.
Since v0.9.0 the extension ID is `local.dataops-dbt-commander` and every command / setting / view / context key
is `dbtCommander.*`; `migrate.ts` copies old `dbtRunner.*` user and workspace settings once on activation.

## Status
- **v0.16.1 — released** (https://github.com/razjir-bote/dataops-dbt-commander/releases/tag/v0.16.1) — **SQLFluff path mode for the dbt templater.** sqlfluff-templater-dbt raises "does not support
  stdin input" whenever `fname == "stdin"` — and `lint -` / `fix -` always pass `"stdin"`, `--stdin-filename` only
  picks the config. So `SqlFluff.pathMode(file)` (sqlfluffRunner.ts): `--templater` in `sqlfluff.extraArgs`, else the
  nearest config's core `templater` (`configCore`; folders nearest first, in a folder pyproject.toml > .sqlfluff >
  tox.ini > setup.cfg), is `dbt` — or a stdin run already refused (`refusesStdin`, remembered per file until a
  settings change). Path mode: lint = `lint <file>` (skipped while dirty; the save lints); fix = `fix <file>
  --fixed-suffix .dbtcommander-sqlfluff-fix-<pid>-<n>` → SQLFluff writes the fixed copy beside the file (only when
  something changed), the extension reads it as one edit and deletes it; the file itself is never rewritten by
  SQLFluff. `parseTrigger` ignores those copies (`isFixCopy`). Fix on save in path mode: will-save marks the file
  (`fixAfterSave`), `onDidSave` fixes the saved file and re-saves (`applyLate` → `saveQuietly`, which skips fix on
  save and the save's own lint; the mark holds the version and is dropped by the next will-save, so a save that
  never completed can't fix a later auto-save). Lint / Fix commands save unsaved edits first. Format Document on
  unsaved edits returns nothing and starts a 2 s timer (`formatPending`): a save inside it was Format on Save
  (`editor.formatOnSave`) → the fix follows the save; no save → "save the file first". The formatter returns
  nothing during the extension's own re-save. A refusal counts only from stderr of a failed run (`fix -` prints
  the user's SQL on stdout). SQLFluff < 3 gets `-f` for path fixes (it asks "Are you sure" otherwise; version from
  `sqlfluff --version`, cached per executable). Integration test: a stand-in "dbt" templater
  (`test/fixtures/sqlfluff-stub-dbt`, pip-installed into the test venv from a copy by `run.js`, reinstalled when
  its hash changes) that refuses stdin like the real one; covers lint, Format Document, fix on save, Format on
  Save. Not integration-tested: the refusal fallback (config we can't read), SQLFluff 2.x.
- **v0.16.0 — released** (https://github.com/razjir-bote/dataops-dbt-commander/releases/tag/v0.16.0) — **Copy Compiled SQL** (`dbtCommander.copyCompiled`, `ctrl+' y`; Inspect group after Compile).
  What to compile comes from `pickQuery` in `scratch.ts` — the one picker Preview Selection / CTE uses too (whole
  CTEs → trailing comma → plain selection → CTE at the cursor → unsaved text → the saved model node). A model node:
  `dbt compile --select … --quiet` (captured, no terminal), then its file under target/compiled (`compiledPath`);
  anything else: `dbt compile --inline … --quiet`, whose stdout is the compiled SQL. `copyCompiled` in query.ts
  (deps `compileModel` / `compileInline` in extension.ts); a failure or cancel leaves the clipboard alone.
- **Also in v0.16.0: Preview Selection / CTE on whole CTEs or a selection ending in a comma** selects from the last CTE
  selected: `trailingCteQuery` in `scratch.ts` (comma found with the comment / string / Jinja-aware tokenizer; the
  selection minus the comma must end exactly at a CTE found by `ctesIn`, retried with `with ` prefixed for CTEs
  selected from the middle; Jinja tags after the comma kept). Before it, `selectedCteQuery(model, start, end)`: a
  selection that is whole CTEs of the model (from a CTE name / the `with` to a CTE's `)` / its comma; no token cut
  by the selection) → `cteQueryAt` on the last one, so earlier CTEs it reads from are included. Order in
  `previewSelection` (query.ts): selectedCteQuery → trailingCteQuery → the selection as is.
- **Also in v0.16.0: one right-click list.** `package.json` menus: Explorer + editor tab → submenu
  `dbtCommander.submenu`, code editor → `dbtCommander.editorSubmenu` (both labelled `dbt`; nothing loose in VS Code's
  menus — seed CSVs and YAML included); sidebar / Lineage view items use the same groups `1_run` · `2_graph` ·
  `3_inspect` · `4_create` · `5_refactor` · `6_sqlfluff` · `9_settings` and order. The list lives in
  `src/test/menus.test.ts` (`LIST`), which fails when a menu item is missing from it or out of place: add a new
  command there first. Titles have no `dbt ` prefix (category `dbt Commander` / the submenu says it), Title Case;
  project-wide commands read `Run dbt deps` / `Run dbt seed (all)` etc.
- **Also in v0.16.0: auto-parse.** `autoparseCore.ts` (pure: `parseTrigger(rel, paths)`; `DbtActivity` — the
  one registry (`dbtActivity`) of dbt processes per project, `'auto'` or `'user'`; `ParseScheduler` — 1.5 s debounce
  per project, one parse at a time + one queued, waits while any dbt runs in the project, a user command that
  parses, exits 0 and started after the last change cancels the pending parse and clears a failure) and
  `autoparse.ts` (`AutoParser`: `**/*` watcher with a cheap path pre-filter, `dbt parse` via execFile with the
  target + `debugArgs` flags only, 5 min timeout, killed on dispose; status bar item; output channel
  "dbt Commander: auto-parse"; `parses` counter for tests). Every dbt process the extension starts registers:
  `runner.ts` tasks (wait in the terminal with a message), `testing.ts`, `captureDbt` (extension.ts), `runShow`
  (query.ts) — all wait for a running auto-parse first (`whenIdleUnless`, cancellable). Not tracked: dbt run in a
  terminal, the SQLFluff dbt templater. Setting `dbtCommander.autoParse` (default on; settings page checkbox).
  The integration workspace turns it **off** (`run.js`) so other steps stay deterministic; section `v16` turns it
  on (the whole suite also passed with it on, 2026-11-22).
  Design: `docs/superpowers/specs/2026-11-22-dbt-commander-v0.16-auto-parse-design.md`.
- **v0.15.0 — released** (https://github.com/razjir-bote/dataops-dbt-commander/releases/tag/v0.15.0) — **Add seed as source.** `addSeedsAsSource` in `projectedits.ts`
  (command `dbtCommander.addSeedAsSource`, Explorer seed CSVs + sidebar seeds); pure `csvHeader` / `addSourceTable`
  in `yamlgen.ts` (text insertion, existing lines untouched; flow / empty lists rewritten by the YAML library like
  `appendModel`). Seed schema / database from the manifest (`NodeEntry.schema`, `.database` only when configured);
  parses first if a seed is missing; last source name remembered in workspace state. Also: the SCD2 command now
  also writes `dim_<source>__<entity>__candidate` / `__history` / `__published` (one-line calls to the project's
  `scd2_*` macros, which the extension never creates) to `dbtCommander.scd2.generatedFolder`, and the singular test
  `dim_<source>__<entity>__gates` (`scd2_gate_test`) to `dbtCommander.scd2.testsFolder` (`tests/scd2/generated`)
  (`scd2GeneratedModels` in `scd2.ts`, `test: true` for the gates file); existing files kept, missing macros reported. And: *Create staging model*
  from a sources YAML entry (`sourceTableAt` in `yamlcontext.ts`; editor right-click in YAML + a lightbulb on the
  table's own lines). And: the SCD2 command adds the dimension to `scd2_dimensions:` in `vars.yaml`
  (`dbtCommander.scd2.varsFile`, project-relative; `addScd2Dimension` / `scd2DimensionLines` in `scd2.ts`): text
  insertion after the list's last item at its indentation (blank-line style kept, BOM / CRLF kept), section appended
  when missing, file created when missing; an entry whose own `name:` matches → `exists`; a flow list, an anchor, a
  mapping, tabs or a second `scd2_dimensions` key → `unsupported` (untouched, reported). An open vars file is edited
  in place (only the inserted range) and saved only if it had no other unsaved changes. The entry's `source` /
  `baseline_source` is the change-key model as named in the prompt. **Breaking rename:** the change-key model is now
  `int_<source>__<entity>__changekey` (two underscores, user decision); existing files aren't renamed.
  Design: `docs/superpowers/specs/2026-11-21-dbt-commander-v0.15-seed-as-source-design.md`.
- **v0.14.0 — released** (https://github.com/razjir-bote/dataops-dbt-commander/releases/tag/v0.14.0) — **SCD2 change-key model.** `scd2.ts` (pure: `changeKeyNames`, `changeKeySql`,
  `HASH_COLUMNS_MACRO`) + `createChangeKeyModel` in `projectedits.ts` (command `dbtCommander.createChangeKey`,
  sidebar staging models have contextValue `model-stg` — sidebar when-clauses on `model` accept it too).
  `attribute_hash`: first of `scd2.hashColumns` (versionnumber, _full_row_hash) the staging model has, else the
  `hash_columns` macro over the columns not starting with `_` (minus entity_id / rn / the key alias). The macro is
  written only if no macro file defines `hash_columns` (scanned, not just the manifest). Columns: the built
  table first, the staging YAML if not built. Checked by `dbt compile` in the integration suite (600-column
  grouping checked by hand: 250 / 250 / 100). Review fixes also in `bronze.ts`: warehouse date / datetime
  columns are cast directly (a text round trip of DATETIME drops seconds); an existing `entity_id` column
  isn't duplicated. Not done (minor): NULL delete flags are dropped (as the template); `_bronze_run_id` sorts
  as text in the dedupe; no-key dedupe partitions on every data column (wide on very wide tables).
  Design: `docs/superpowers/specs/2026-11-21-dbt-commander-v0.14-scd2-changekey-design.md`.
- **Also in v0.14.0: Create staging model uses the team's bronze template.** `bronze.ts`
  (pure: `bronzeStaging(source, table, columns, rules)` → SQL + staged YAML columns; `BRONZE_DEFAULTS`); the old
  plain `stagingSql` was removed (user decision: replace, not add). Rules are `dbtCommander.bronzeStaging.*`
  settings. Types by column name first, then a warehouse date / datetime type; key kept + copied to `entity_id`;
  no key → dedupe on every column not starting with `_` per extract date; no order columns → `ORDER BY (SELECT
  NULL)`. The output is T-SQL: on the DuckDB test fixture it is only checked as text, never run. File name
  `stg_<system>__<entity>` from the table name split at its first underscore (`stagingName`); no underscore → the
  dbt source name is the system.
  Design: `docs/superpowers/specs/2026-11-21-dbt-commander-v0.14-bronze-staging-design.md`.
- **v0.13.0 — released** (https://github.com/razjir-bote/dataops-dbt-commander/releases/tag/v0.13.0): **YAML autocomplete.** `yamlcontext.ts` (pure: path / kind / siblings /
  item names at the cursor, from indentation, so half-typed YAML works), `yamlcomplete.ts` (pure: what to suggest
  where — keys per place, config values, test snippets honouring `arguments:` by dbt version, materializations from
  `materialization_*` macros), `yamlCompletion.ts` (provider: manifest + catalog.json; `ref('` / `source('` delegate
  to the SQL `DbtCompletionProvider`). Columns come from catalog.json only — no warehouse queries while typing.
  Design: `docs/superpowers/specs/2026-11-21-dbt-commander-v0.13-yaml-autocomplete-design.md`.
  From the review: only YAML in resource folders (model / seed / snapshot / macro / analysis / test paths), never
  `dbt_project.yml`; block-scalar text (`description: |`) is not structure; anchors / tags on a parent key, quoted
  values, bare `-` lines, indentless-list siblings and `---` documents handled; generic tests are macros whose
  `macro_sql` starts with `{% test` (`MacroEntry.test`); base data cached per manifest (WeakMap); no manifest load for
  keys that don't need it. Not done (minor): quoted / `+`-prefixed keys aren't read as keys; versioned-model column
  names come from the model's latest version in the catalog.
- **v0.12.0 — released** (https://github.com/razjir-bote/dataops-dbt-commander/releases/tag/v0.12.0): **optional SQLFluff**, off by default (`dbtCommander.sqlfluff.enabled`
  off / on / auto). `sqlfluff.ts` (pure: JSON parsing, dialect from adapter, config detection, args, CRLF→file EOL)
  and `sqlfluffRunner.ts` (stdin runs with `--stdin-filename`, so `.sqlfluff` / `.sqlfluffignore` apply; problems on
  open / save; fix on manual save via `onWillSaveTextDocument` + `waitUntil`; a formatter registered only while active;
  context key `dbtCommander.sqlfluffActive` for menus). Off: no formatter, problems cleared, SQLFluff never spawned.
  Settings page has a SQLFluff section. Gotchas: SQLFluff 4 on Windows writes CRLF to stdout and crashes printing
  emoji unless `PYTHONIOENCODING=utf-8`. The integration venv installs `sqlfluff>=3,<5`.
  Design: `docs/superpowers/specs/2026-11-21-dbt-commander-v0.12-sqlfluff-design.md`.
  From the review: VS Code drops a will-save participant's edits after 1.5 s (and ignores it after a few misses), so
  fix on save races 1.2 s and applies a slower fix right after the save, then saves again (only if the text is
  unchanged); lints are queued per file (one running + one pending, 2 SQLFluff processes at most), settings changes
  are debounced, runs are killed when turned off; `fix` output is used only for exit 0 / 1 and not when killed; the
  dialect check reads the same folders SQLFluff does (file folder up, home, user config dir), cached by mtime; the
  settings page stores off / false as "not set" and never starts SQLFluff while off. Not done (minor): SQLFluff
  counts columns in code points, VS Code in UTF-16 units (an emoji shifts ranges on its line); with fix on save and
  `editor.formatOnSave` both on, SQLFluff runs twice per save; the formatter is registered for every `.sql` file
  (returns nothing outside dbt folders).
- **Also in v0.12.0:** *Show lineage* centres the Lineage panel on any manifest node —
  `DbtLineage.pinNode(root, id)`, used for sidebar source tables / exposures / semantic models (their `DbtItem.data.uniqueId`)
  and for Lineage panel items (re-centre). Files still follow the editor only for models / seeds / snapshots.
- **v0.11.0 — released** (https://github.com/razjir-bote/dataops-dbt-commander/releases/tag/v0.11.0): preview table sort / filter / Copy (TSV) /
  Save CSV (`exportrows.ts`; the webview runs `viewRows.toString()`, so the function must stay self-contained;
  Copy / Save recompute from the view state in the extension), column profile (`profile.ts`: one inline query with
  `dbt.type_string()` / `dbt.type_bigint()`; YAML lightbulb on model / seed / snapshot / source columns and Σ in model
  previews), relationships + dbt_utils test quick fixes (`yamlfix.ts` tests with args; `columnOwnerAt`). Design:
  `docs/superpowers/specs/2026-11-21-dbt-commander-v0.11-design.md`. From the review: profile rows are re-sorted
  client-side (dbt show's limit wrapper can drop the inner order by); a min()/max() error re-runs the profile without
  them (Postgres uuid / boolean); YAML column names stay bare unless they need quoting. Not done (minor): a column's
  `quote: true` in YAML is not read when profiling.
- **v0.11.1 — released** (https://github.com/razjir-bote/dataops-dbt-commander/releases/tag/v0.11.1), whole-project review fixes: `path:` selectors escape spaces (`?`) and glob
  characters (`[[]`), since dbt splits `--select` on spaces; Problems are kept per project + node
  (`ProblemStore` in `errors.ts`) and errors in installed packages' nodes point into the package folder
  (`fileFor`); the Testing panel reports "dbt didn't start" as errored, not skipped; project discovery has no
  50-file cap (and the sidebar reuses it); accepted_values input takes quoted values (`parseValueList`);
  CSV / TSV export prefixes formula-like text with `'` (numbers untouched); one `captureDbt` helper.
- **v0.10.0 — released** (https://github.com/razjir-bote/dataops-dbt-commander/releases/tag/v0.10.0): SQL scratchpad (`query.ts`: untitled
  `dbt-scratch-N.sql` in the project folder, recognised by name so it survives hot exit; context key
  `dbtCommander.isScratchpad` scopes Ctrl+Enter), preview selection / CTE (`dbtCommander.previewSelection`,
  `Ctrl+'` `Q`; pure CTE parser `scratch.ts`; runs `dbt show --inline` with config() blocks and a trailing `;`
  stripped), YAML quick fixes (`DbtCodeActions`; pure `yamlfix.ts` text insertions; `accepted_values` values go
  under `arguments:` for dbt ≥ 1.10, top level before), macro hover (`macrohover.ts`; manifest macros carry
  description / arguments), run-state pruning (`RunStatusStore.prune` on manifest change + at activation; pure
  `pruneRunState` / `liveNodeIds`). Design: `docs/superpowers/specs/2026-11-21-dbt-commander-v0.10-design.md`.
  The CTE parser reads standard SQL first, then retries with backslash escapes and `#` comments and keeps the
  reading that finds the most CTEs (so `'C:\'` in standard SQL and `'O\'Brien'` in Snowflake both work). Preview
  selection never saves: an unsaved model with the cursor outside any CTE previews the editor text inline
  (`dbtCommander.preview` itself still saves first, like the run commands).
- **v0.9.0 — released** from the new repo (https://github.com/razjir-bote/dataops-dbt-commander/releases/tag/v0.9.0)
  and installed locally as `local.dataops-dbt-commander@0.9.0` (old `local.dbt-runner` uninstalled): the rename to DataOps dbt Commander (`dbtCommander.*` IDs,
  settings migration) plus everything from v0.7 and v0.8, and a fix found by CI: rename refused to rename back
  right after a rename because the stale manifest still listed the old name (`takenModelNames` now ignores
  manifest entries whose file is gone). Previously released: v0.6.1 (old repo).
- **v0.8 (version 0.8.0, committed `2ba6749`):** dbt debug
  (`checkConnection`, only debug-safe flags via `debugArgs`), rename model (`projectedits.ts` + pure
  `refactor.ts`: WorkspaceEdit with refactor preview; skips other packages' refs and versioned models; renames
  `models:` / `unit_tests:` YAML entries incl. indentless lists), staging model from a source and new model
  (`scaffold.ts`; columns via `adapter.get_columns_in_relation`; unusual column names via `adapter.quote`),
  exposures / semantic models in the manifest, sidebar and lineage, Open in dbt docs (regenerates the static
  site only when the page lacks the node; opens through `target/dbt_commander_docs.html`). Integration: 55 checks
  passed before the review fixes; the fixes were verified with typecheck + unit tests (113).
- **v0.7 (version 0.7.0, committed `8e131cb`, unreleased):** custom
  `model-paths`/`seed-paths`/`snapshot-paths` (published as context keys `dbtCommander.modelPaths` etc. and used in
  package.json `when` clauses via `resourcePath in …`), custom `packages-install-path` (packages are never treated
  as projects: `isUnderPackages`), `dbt retry`, rerun last command (`Ctrl+'` `L`), long-run notification
  (`dbtCommander.notifyAfterSeconds`), last-run badges (sidebar + CodeLens, `RunStatusStore` in workspace state),
  Last run view, column autocomplete after `alias.`, find references. Integration suite: 49 checks passed before
  the review fixes; the review fixes were checked with typecheck + unit tests (98) only.
- Not done from the v0.8 review (minor): renaming Python models / flow-style YAML, renaming per-model config in
  dbt_project.yml (the rename message points this out), semantic models open at line 0 in Lineage.
- Deferred from the v0.7 review: `Ctrl+'` `L` doesn't reach VS Code while the terminal has focus. (Run-state
  pruning was done in v0.10.)

## Build, test, release
```bash
npm install
npm run typecheck            # tsc --noEmit
npm run compile && npm test  # unit tests (node:test) → out/test/*.test.js
npm run test:integration     # real VS Code + dbt 1.12 + duckdb, see below
npm run package              # esbuild → dist/extension.js, then vsce → .vsix (no node_modules shipped)
```
- **Integration suite** (`test/integration/run.js` + `suite.js` + `groups.js`): creates `.vscode-test/dbt-venv`
  (dbt-core~=1.12.0 + dbt-duckdb + sqlfluff) on first run (`DBT_PYTHON` picks the Python; default `py -3.12` on
  Windows), downloads VS Code once, then runs the suite's **groups in parallel** — one VS Code, one
  `.vscode-test/user-data-gN` and one copy of `test/fixtures/demo` in `.vscode-test/work/gN/demo` each — and prints
  every group's `PASS` / `FAIL` lines with per-step times, then a total; exits 1 on any FAIL.
  `npm run test:integration:serial` (or `--serial`) runs every step in one VS Code, in order, as before.
  Groups are lists of suite sections (`await section('v08')`) in `groups.js`; every group after the first starts with
  a setup step (seed, build, docs generate) standing in for what earlier steps left behind. A new step goes in a
  section; a new section must be added to a group. Rebalance with the step times. Currently 76 checks (+ 3 setup
  steps in parallel runs). The suite talks to the extension through the API returned by `activate()`.
- **CI** (`.github/workflows/ci.yml`): windows-latest, Node 22, Python 3.12; typecheck, unit, integration,
  package. A pushed tag `vX.Y.Z` that equals `package.json` version publishes a GitHub release with the vsix.
- **Release steps:** bump `version` in package.json (+ `npm install` to refresh the lockfile), commit, push
  `main`, `git tag -a vX.Y.Z -m … && git push origin vX.Y.Z`, wait for the tag's CI run, then
  `gh release download vX.Y.Z --pattern "*.vsix"` and `code --install-extension <file> --force`.
  If a tag's CI fails before publishing, fix on main and (with the user's OK) move the tag.

## Architecture (src/)
| File | Role |
|---|---|
| `extension.ts` | activation, all commands, selection resolution (`resolveSelection`, Explorer/sidebar/editor args), status bar, settings wiring, Generate YAML command |
| `dbt.ts` | pure: selectors (`path:`), graph operators, args, venv exe lookup, project root, version parse |
| `runner.ts` | runs dbt as a VS Code task via CustomExecution pseudoterminal; per-node diagnostics (`DbtDiagnostics`); `killTree` |
| `proctree.ts` | pure: process-tree descendants with creation-time check (Windows PID reuse) |
| `errors.ts` | pure: dbt console output → problems (dbt 1.12 formats incl. `[ERROR]: in test …`) |
| `manifest.ts` | pure: manifest.json → models/sources/macros/seeds/snapshots/tests/patches/lineage maps |
| `language.ts` | manifest cache (`loadManifest`), definition/completion/CodeLens/reference providers, configured-path checks |
| `hover.ts` | ref()/source() hover; `loadCatalog` (catalog.json, mtime-cached) |
| `jinja.ts` | pure: ref/source/macro call under cursor, completion context |
| `columns.ts` | pure: table aliases, `alias.` detection, ref() line search |
| `runresults.ts` | pure: run_results parsing/acceptance, test locations, hover markdown, column merge |
| `runstate.ts` | pure: per-node last result merge, status badges, run summary, slowest |
| `projectconfig.ts` | pure: dbt_project.yml paths with defaults; folder walk for menu context keys |
| `runstatus.ts` / `lastrun.ts` | per-node last result store (watches run_results.json) / Last run view |
| `columns.ts` | pure: `alias.` completion helpers, `refLines` for references |
| `projectedits.ts` | rename model, create staging model, new model, open in docs, dbt debug commands |
| `refactor.ts` / `scaffold.ts` | pure: ref()/YAML rename edits / staging names, new-model template SQL, docs routes, debug parsing |
| `profiles.ts` | pure: profiles.yml targets, project file fields |
| `show.ts` / `previewPanel.ts` | `dbt show` parsing (big-int safe) / data preview webview |
| `yamlgen.ts` | pure: YAML generation/merge that inserts text and never restyles existing lines |
| `sidebar.ts` / `tree.ts` | dbt sidebar tree (Models/Sources/Seeds/Snapshots/Tests) / pure folder helpers, selection |
| `lineage.ts` | Lineage tree view (follows editor, pinnable) |
| `testing.ts` | Testing panel controller; runs `dbt test`, maps run_results; snapshot-based runs |
| `settingsPanel.ts` | settings webview (venv, target, extra flags) |
| `query.ts` | `runShow` (shared by Preview Data), scratchpads, preview selection / CTE, YAML quick-fix code actions |
| `yamlcontext.ts` / `yamlcomplete.ts` / `yamlCompletion.ts` | pure YAML cursor context / pure suggestion rules / YAML completion provider |
| `autoparseCore.ts` / `autoparse.ts` | pure auto-parse trigger / dbt activity registry / scheduler; the watcher + background `dbt parse` + status bar |
| `sqlfluff.ts` / `sqlfluffRunner.ts` | pure SQLFluff helpers / optional linting, fix on save, formatter, commands |
| `bronze.ts` / `scd2.ts` | pure: the bronze → staging template / SCD2 change-key template + `hash_columns` macro |
| `exportrows.ts` / `profile.ts` | pure: preview sort / filter / CSV / TSV / profile query + display rows |
| `scratch.ts` / `yamlfix.ts` / `macrohover.ts` | pure: CTE parser + inline SQL / column test insertions / macro signature + hover text |

Design docs per version: `docs/superpowers/specs/`, plans: `docs/superpowers/plans/`.

## Things learned the hard way
- **Shell + backslashes:** in this environment, bash heredocs and `node -e` strings lose backslashes. Edit
  `package.json` `when` clauses (regexes like `[\\/]`) with a Node script written via the file tool, then verify.
- **when-clause regexes** in package.json are JSON-escaped: `/[\\\\/]models[\\\\/]/i` in the file = `[\\/]` regex.
- **dbt 1.12 specifics:** `path:.` is rejected (project root = no selector); test failures print as
  `[ERROR]: in test x (path)` / `[WARNING]: …`; `dbt retry` keeps `args.which` of the original command;
  `dbt show --output json --log-format json` puts rows in the `ShowNode` event's `data.preview`;
  `docs generate --static` writes `target/static_index.html`. `dbt show --inline` puts errors in a level-"error"
  event's `data.exc`; generic test args belong under `arguments:` since 1.10 (older versions reject the key).
- **run_results.json is shared:** only trust it when `metadata.invocation_id` changed since the run started
  (and `args.which` matches when it matters). A manifest rewrite mid-run triggers tree refreshes — snapshot
  data at run start.
- **Windows PID reuse:** never `taskkill /T`; use `proctree.ts`.
- **CI runs Node 22** (not 26 like the dev machine): avoid Node-26-only features in tests; `node --test` needs a
  glob, not a folder.
- **Integration flakiness:** VS Code's `executeCodeLensProvider` can throw "Illegal argument" right after
  `closeAllEditors` — open the document first. New files get CRLF from VS Code on Windows.
- Opening a browser from tests: `openExternal` can't be stubbed from the suite; the workspace setting
  `dbtCommander.openDocsAfterGenerate=false` is used instead.

## Working agreements with the user
- New features: short design doc → user approves → plan → implement here (TDD for pure logic) → fresh reviewer
  subagent → fix findings → ask "commit / release?". The user often says *just commit*.
- **Don't run the full integration suite for every commit** (it takes ~4 min). Before a commit: `npm run typecheck`
  and the unit tests. Run the integration suite once at the end of a feature (or when a change touches VS Code
  wiring the unit tests can't reach); CI runs it on every push and before every release anyway.
- Releases only when asked; moving a pushed tag needs explicit OK each time.
- Keep `samples/` (a sample seed CSV) untracked unless asked.
- Commit messages end with the Co-Authored-By line from the session's attribution instructions.

## Known limitations / backlog
- Ancestor folders named `target`, `logs`, `venv`, … hide the folder menu (path-regex based).
- Paths in dbt_project.yml written with Jinja fall back to dbt's defaults.
- Generate YAML doesn't handle versioned/ephemeral models.
- Ideas not yet picked: full-refresh build, run/test upstream/downstream, state:modified + defer, run on save,
  source freshness, dbt unit tests in the Testing panel, query history / CSV export for the preview, Marketplace publish.
