# DataOps dbt Commander — developer handover

Keep this file current: update it in the same commit as any change to features, architecture, build/release
process, or known issues. Last updated: 2026-11-21 (v0.12.0 released: optional SQLFluff, Show lineage on any node).

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
- **Integration suite** (`test/integration/run.js` + `suite.js`): copies `test/fixtures/demo` to
  `.vscode-test/work/demo`, creates `.vscode-test/dbt-venv` (dbt-core~=1.12.0 + dbt-duckdb) on first run
  (`DBT_PYTHON` picks the Python; default `py -3.12` on Windows), launches VS Code with the extension and prints
  `PASS`/`FAIL` lines; exits 1 on any FAIL. ~4–5 min. Currently 68 checks; the v0.10 ones are last because they add a
  temporary model and feed a fake run_results file to the run-state store (which then is "the last run"). The suite talks to the extension
  through the API returned by `activate()` (`sidebar`, `tests`, `lineage`, `runStatus`, `projectEdits`, `query`, …).
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
| `refactor.ts` / `scaffold.ts` | pure: ref()/YAML rename edits / staging + template SQL, docs routes, debug parsing |
| `profiles.ts` | pure: profiles.yml targets, project file fields |
| `show.ts` / `previewPanel.ts` | `dbt show` parsing (big-int safe) / data preview webview |
| `yamlgen.ts` | pure: YAML generation/merge that inserts text and never restyles existing lines |
| `sidebar.ts` / `tree.ts` | dbt sidebar tree (Models/Sources/Seeds/Snapshots/Tests) / pure folder helpers, selection |
| `lineage.ts` | Lineage tree view (follows editor, pinnable) |
| `testing.ts` | Testing panel controller; runs `dbt test`, maps run_results; snapshot-based runs |
| `settingsPanel.ts` | settings webview (venv, target, extra flags) |
| `query.ts` | `runShow` (shared by Preview Data), scratchpads, preview selection / CTE, YAML quick-fix code actions |
| `sqlfluff.ts` / `sqlfluffRunner.ts` | pure SQLFluff helpers / optional linting, fix on save, formatter, commands |
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
