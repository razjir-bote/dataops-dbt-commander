# dbt Runner — developer handover

Keep this file current: update it in the same commit as any change to features, architecture, build/release
process, or known issues. Last updated: 2026-11-21 (v0.7 and v0.8 committed, neither released).

## What this is
A VS Code extension (TypeScript) for working with **dbt-core 1.x** (tested with 1.12.7) on **Windows**, running
dbt from a **Python venv** the user picks in a settings panel. Not for dbt 2 / Fusion. Public repo:
https://github.com/razjir-bote/vscode-dbt-runner — releases ship a `.vsix` (not on the Marketplace).

## Status
- Released: **v0.6.1** (installed locally as `local.dbt-runner@0.6.1`).
- On `main`, unreleased: `8da435f` — sidebar multi-select Build + Upstream / Downstream.
- **v0.8 (version 0.8.0, committed `2ba6749`, unreleased):** dbt debug
  (`checkConnection`, only debug-safe flags via `debugArgs`), rename model (`projectedits.ts` + pure
  `refactor.ts`: WorkspaceEdit with refactor preview; skips other packages' refs and versioned models; renames
  `models:` / `unit_tests:` YAML entries incl. indentless lists), staging model from a source and new model
  (`scaffold.ts`; columns via `adapter.get_columns_in_relation`; unusual column names via `adapter.quote`),
  exposures / semantic models in the manifest, sidebar and lineage, Open in dbt docs (regenerates the static
  site only when the page lacks the node; opens through `target/dbt_runner_docs.html`). Integration: 55 checks
  passed before the review fixes; the fixes were verified with typecheck + unit tests (113).
- **v0.7 (version 0.7.0, committed `8e131cb`, unreleased):** custom
  `model-paths`/`seed-paths`/`snapshot-paths` (published as context keys `dbtRunner.modelPaths` etc. and used in
  package.json `when` clauses via `resourcePath in …`), custom `packages-install-path` (packages are never treated
  as projects: `isUnderPackages`), `dbt retry`, rerun last command (`Ctrl+'` `L`), long-run notification
  (`dbtRunner.notifyAfterSeconds`), last-run badges (sidebar + CodeLens, `RunStatusStore` in workspace state),
  Last run view, column autocomplete after `alias.`, find references. Integration suite: 49 checks passed before
  the review fixes; the review fixes were checked with typecheck + unit tests (98) only.
- Not done from the v0.8 review (minor): renaming Python models / flow-style YAML, renaming per-model config in
  dbt_project.yml (the rename message points this out), semantic models open at line 0 in Lineage.
- Deferred from the v0.7 review: pruning the persisted run state (`dbtRunner.runState` grows with renamed /
  deleted nodes); `Ctrl+'` `L` doesn't reach VS Code while the terminal has focus.

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
  `PASS`/`FAIL` lines; exits 1 on any FAIL. ~3–4 min. Currently 44 checks. The suite talks to the extension
  through the API returned by `activate()` (`{ sidebar, tests, lineage }`).
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

Design docs per version: `docs/superpowers/specs/`, plans: `docs/superpowers/plans/`.

## Things learned the hard way
- **Shell + backslashes:** in this environment, bash heredocs and `node -e` strings lose backslashes. Edit
  `package.json` `when` clauses (regexes like `[\\/]`) with a Node script written via the file tool, then verify.
- **when-clause regexes** in package.json are JSON-escaped: `/[\\\\/]models[\\\\/]/i` in the file = `[\\/]` regex.
- **dbt 1.12 specifics:** `path:.` is rejected (project root = no selector); test failures print as
  `[ERROR]: in test x (path)` / `[WARNING]: …`; `dbt retry` keeps `args.which` of the original command;
  `dbt show --output json --log-format json` puts rows in the `ShowNode` event's `data.preview`;
  `docs generate --static` writes `target/static_index.html`.
- **run_results.json is shared:** only trust it when `metadata.invocation_id` changed since the run started
  (and `args.which` matches when it matters). A manifest rewrite mid-run triggers tree refreshes — snapshot
  data at run start.
- **Windows PID reuse:** never `taskkill /T`; use `proctree.ts`.
- **CI runs Node 22** (not 26 like the dev machine): avoid Node-26-only features in tests; `node --test` needs a
  glob, not a folder.
- **Integration flakiness:** VS Code's `executeCodeLensProvider` can throw "Illegal argument" right after
  `closeAllEditors` — open the document first. New files get CRLF from VS Code on Windows.
- Opening a browser from tests: `openExternal` can't be stubbed from the suite; the workspace setting
  `dbtRunner.openDocsAfterGenerate=false` is used instead.

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
  source freshness, dbt unit tests in the Testing panel, selected-SQL preview, dbt debug, Marketplace publish.
