# dbt Runner v0.3 — design

## Intent
Make the extension safe to keep changing (tests in the repo, CI releases, bundled build), close the known
small bugs, and add the editor features used most when writing models: jump to `ref()`/`source()`,
run links above each model, and `ref()` autocomplete. User picked items 1–8 and 10 from the proposal.

## Goals
1. **Integration tests in the repo** — `npm run test:integration` launches VS Code with the extension against a
   small fixture dbt project (duckdb), using a dbt-core 1.12 venv the script creates/caches itself.
2. **CI + automatic releases** — GitHub Actions: on push/PR to `main` run type-check, unit and integration tests;
   on a `v*` tag also package and publish the GitHub release with the `.vsix` attached.
3. **Bundling** — esbuild bundles `src/extension.ts` (+ `yaml`) into `dist/extension.js`; vsix ships no node_modules.
4. **Preview keeps big integers exact** — values beyond 2^53 shown exactly as dbt returned them.
5. **Settings panel fixes** — save errors shown; reopening reloads current values; cleared fields remove the setting.
6. **Status bar notices dbt installed later** — version re-checked when the VS Code window regains focus and when
   the dbt menu opens.
7. **Go to definition** — Ctrl+click / F12 on `ref('m')`, `ref('pkg', 'm')`, `ref('m', v=2)` opens the model;
   on `source('src', 'tbl')` opens the sources YAML at that table.
8. **CodeLens** — `Run · Build · Test · Compile · Preview` above line 1 of each model; setting
   `dbtRunner.codeLens` (default on).
10. **Autocomplete** — inside `ref('` suggests model names; `source('` suggests source names;
    `source('src', '` suggests that source's tables.

## Non-goals
Lineage panel, selection preview, rerun-last, state:modified, dbt debug, Marketplace publishing (not picked).
Hover info, rename, diagnostics for unknown refs.

## Approaches (where there was a real choice)
**Where 7/10 get model & source names.**
- **A. Read `target/manifest.json` (chosen, Claude's call)** — exact names, packages, versions, sources and file
  paths; dbt writes it on every run/build/compile/parse. Stale until the next dbt command.
- **B. Scan the workspace for `.sql`/`.yml` files** — always current, but guesses (aliases, versions, sources in
  YAML need parsing). Used only as a **fallback** for `ref()` (model file named `<name>.sql`) when no manifest exists.
- **C. Run `dbt parse` on demand** — exact but seconds of latency on every keystroke/click; rejected.

**Test-only behaviour of docs generate.** Integration tests must not open a browser. Add a real setting
`dbtRunner.openDocsAfterGenerate` (default true) that the tests turn off — rather than a hidden env-var switch.

## Design
- **Manifest (`src/manifest.ts`, pure + cache):** `parseManifest(json, root)` → models
  `{name, package, version, file}` and sources `{source, table, file}` (absolute paths; non-root packages
  resolved under `dbt_packages/<package>`). Cached per project by manifest mtime.
- **Jinja call parsing (`src/jinja.ts`, pure):** `callAt(line, col)` finds the `ref`/`source` call under the
  cursor and its arguments; `completionContext(textBeforeCursor)` says whether we're in a ref name, source
  name or source table argument.
- **Definition provider** for `.sql` under `models`/`macros`/`tests`/`snapshots`/`analyses`; source YAML opened
  at the `- name: <table>` line under that source.
- **CodeLens provider** for model files (same `when` scope as menus); each lens runs the existing command.
- **Preview:** JSON parse keeps integer literals outside the safe range as their source text (JSON.parse
  source-text access; falls back to the number if unavailable).
- **Settings panel:** `save` wraps updates in try/catch and reports errors; `undefined` written for blank values;
  `show()` on an open panel re-sends current settings and targets.
- **Build:** `npm run build` = esbuild → `dist/extension.js`; `npm run typecheck` = `tsc --noEmit`; unit tests still
  compiled by tsc to `out/`. `main` → `./dist/extension.js`.
- **Integration tests:** `test/integration/` (runner + suite), fixture project `test/fixtures/demo/`
  (models incl. staging folder, schema tests, seed, sources, duckdb profile with dev/prod). The runner creates
  `.vscode-test/dbt-venv` with `dbt-core~=1.12.0` + `dbt-duckdb` if missing.
- **CI (`.github/workflows/ci.yml`):** `windows-latest` (the extension targets Windows; process-tree test uses
  `taskkill`), Node 20, Python 3.12. Tag job checks tag == `v` + package.json version, then `gh release create`
  with the vsix.

## Claude's calls (correct if wrong)
- Manifest-based lookups with filename fallback for `ref()`.
- New settings: `dbtRunner.codeLens`, `dbtRunner.openDocsAfterGenerate`.
- CI on Windows only.
- Ship as v0.3.0 (release now produced by CI from the tag).
