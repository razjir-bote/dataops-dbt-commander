# dbt Runner v0.4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Macro go-to-definition, "dbt Generate YAML" for models, and a dbt project sidebar.

**Architecture:** Extend the pure `manifest.ts` (macros, seeds, snapshots, tests) and `jinja.ts` (macro call under cursor); new pure `yamlgen.ts`; new `sidebar.ts` TreeDataProvider; wiring in `language.ts`/`extension.ts`/`package.json`. Everything reads the shared manifest cache.

**Tech Stack:** TypeScript, `yaml` Document API, VS Code TreeView API, node:test, existing integration harness.

**Spec:** `docs/superpowers/specs/2026-11-20-dbt-runner-v0.4-design.md`

## Global Constraints
- dbt-core 1.12 manifest shapes (verified): macros `{name, package_name, original_file_path}` with `\\` separators; `patch_path` like `demo://models\\schema.yml`; core macros in package `dbt`, adapter macros in `dbt_<adapter>`.
- dbt's own macros live in `<venv>/Lib/site-packages/dbt/include/global_project/` (package `dbt`) and `.../include/<adapter>/` (package `dbt_<adapter>`); POSIX venvs use `lib/python3.*/site-packages`.
- Columns via `dbt compile --inline` rendering `adapter.get_columns_in_relation(ref('<model>'))`, lines `DBTCOL|<name>|<type>`, with target + extra flags.
- YAML edits are applied as a WorkspaceEdit (unsaved, undoable); never remove/overwrite existing columns.
- Version 0.4.0, committed only (no release).

**User decisions (already made):** v0.4 design approved as written (columns from warehouse, placement rules, five sidebar sections, commit only).

## Review Focus
- Macro call with whitespace `{{ cents_to_dollars ( 'x' ) }}` or `{%- call m() -%}` → still resolves. Test: `macroCallAt` cases.
- Model name present in two YAML files' folder (e.g. entry already in another yml in the folder without a manifest) → merges into that entry, never duplicates. Test: `findModelEntryFile` helper via integration (stg_a generated twice).
- Existing YAML with comments/anchors → comments survive the merge. Test: `mergeColumns` keeps `# keep me`.
- Model not yet built (no relation) → "Build & retry" offered, no empty YAML written. Test: `parseColumnsOutput('')` → [] and command guard.
- Workspace with no manifest → sidebar shows the "Run dbt parse" item, no error. Test: integration step after manifest deletion.

---

### Task 1: manifest + jinja additions (TDD)
**Files:** `src/manifest.ts`, `src/jinja.ts`, `src/test/manifest.test.ts`, `src/test/jinja.test.ts`
**Produces:**
- `interface MacroEntry { name: string; package: string; file: string }`; `interface NodeEntry { name: string; package: string; file: string; attachedTo?: string }`
- `parseManifest(json, root, rootPackage, dbtIncludeDir?)` → adds `macros`, `seeds`, `snapshots`, `tests`, and `patches: Map<modelName, absYamlFile>` (root-package models only).
- `macroFile(root, rootPackage, pkg, original, dbtIncludeDir?)`: root → root; `dbt` → include/global_project; `dbt_<x>` (and no `dbt_packages/<pkg>`) → include/<x>; else dbt_packages/<pkg>.
- `resolveMacro(macros, name, pkg?)`: pkg match; else root package, then installed packages, then dbt/adapter.
- `macroDefinitionLine(text, name)`: 0-based line of `{%-? macro name(`.
- `macroCallAt(line, col): { package?: string; name: string } | undefined` — identifier (optionally `pkg.`) followed by `(`; skips `ref source config var env_var is_incremental return log print range len this adapter caller loop modules api exceptions`.
- [ ] Tests first (paths for all four package kinds; resolve order; definition line with `{%- macro`; call parsing incl. spaces, `dbt_utils.star(`, `{% call m() %}`, builtins → undefined, plain SQL `count(` returns {name:'count'} (resolution fails later)).

### Task 2: macro go-to-definition
**Files:** `src/language.ts`, `src/extension.ts`
- [ ] Definition provider: ref/source first, else macro → `Location(file, macroDefinitionLine)`.
- [ ] `LanguageDeps.dbtIncludeDir(): string | undefined` from venv (Windows `Lib/site-packages/dbt/include`, else glob `lib/python3*/site-packages/dbt/include`).
- [ ] `loadManifest` exported for reuse.

### Task 3: YAML generation
**Files:** create `src/yamlgen.ts`, `src/test/yamlgen.test.ts`; modify `src/extension.ts`, `package.json`
**Produces:** `parseColumnsOutput(out): {name, dataType}[]`, `newModelYaml(model, cols): string`, `appendModel(text, model, cols): string`, `mergeColumns(text, model, cols): { text: string; added: string[] } | undefined` (undefined if model not in file), `hasModel(text, model): boolean`.
- [ ] Tests first: new file exact text; append keeps existing `b` entry; merge adds only missing (case-insensitive), keeps `# keep me` comment and existing description; DBTCOL parsing ignores other lines.
- [ ] Command `dbtRunner.generateYaml` (explorer submenu, file only; command palette for models): columns via compile --inline with progress; empty → "Build & retry"; placement: manifest patch → folder yml with that model → folder yml with `models:` → new `<model>.yml`; WorkspaceEdit; open and reveal entry; info message with added count / "already complete".

### Task 4: sidebar
**Files:** create `src/sidebar.ts`, `resources/dbt.svg`; modify `src/extension.ts`, `package.json`
- [ ] View container `dbtRunner` (activitybar, `resources/dbt.svg`), view `dbtRunner.project` "Project".
- [ ] Sections Models (folders), Sources (source → tables), Seeds, Snapshots, Tests (by `attachedTo`, else "(singular)"); empty sections hidden; multiple projects → a node per project; no manifest → item running `dbtRunner.parse`.
- [ ] Inline buttons (`view/item/context`, group `inline`): model & modelFolder → run/build/test; seed → seedFiles; snapshot → `dbtRunner.snapshotNode`; test → `dbtRunner.testNode`. Title bar: refresh, parse.
- [ ] Commands accept tree items (`resourceUri`) in addition to Uris. Refresh on `**/target/manifest.json` watcher.
- [ ] `activate` returns `{ sidebar }` for the integration suite.

### Task 5: integration + finish
**Files:** `test/fixtures/demo/macros/money.sql`, `test/fixtures/demo/analyses/uses_macro.sql`, `test/integration/suite.js`
- [ ] Steps: macro def (project macro, `dbt.current_timestamp` core macro); generate YAML for `c` (appends to models/schema.yml), `stg_a` (new staging/stg_a.yml), then merge after removing its columns (comment kept); sidebar sections/children, run a model + a test from tree items; sidebar shows parse item without manifest.
- [ ] Review subagent; fix Critical/Important with tests; README; version 0.4.0; commit.
