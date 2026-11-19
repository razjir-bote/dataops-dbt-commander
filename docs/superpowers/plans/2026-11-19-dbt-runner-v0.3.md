# dbt Runner v0.3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-repo integration tests + CI releases + esbuild bundle, preview/settings/status fixes, and ref()/source() go-to-definition, CodeLens and autocomplete.

**Architecture:** New pure modules `src/manifest.ts` (manifest → models/sources) and `src/jinja.ts` (call under cursor, completion context), consumed by providers in `src/language.ts`. Build via esbuild to `dist/`; tsc only type-checks and compiles unit tests. Integration suite moves from scratch into `test/integration/` with a fixture project.

**Tech Stack:** TypeScript, esbuild, node:test, @vscode/test-electron, GitHub Actions (windows-latest), dbt-core 1.12 + dbt-duckdb.

**Spec:** `docs/superpowers/specs/2026-11-19-dbt-runner-v0.3-design.md`

## Global Constraints
- dbt-core 1.x only; manifest paths are project-relative with OS separators (`models\\b.sql`).
- New settings: `dbtRunner.codeLens` (boolean, default true), `dbtRunner.openDocsAfterGenerate` (boolean, default true).
- Integration tests never open a browser (they set `openDocsAfterGenerate: false`).
- vsix contains no `node_modules`; `main` = `./dist/extension.js`.
- Version 0.3.0; CI publishes the release for tag `v0.3.0` only if it equals `v` + package.json version.

**User decisions (already made):** items 1, 2, 3, 4, 5, 6, 7, 8, 10 approved; design approved as written.

## Review Focus
- `ref()` to a model in an installed package (`dbt_packages/pkg/models/x.sql`) → opens that file. Test: `parseManifest` package path.
- Cursor on the closing quote or just after `ref(` (not on the name) → still resolves / no crash. Test: `callAt` boundary cases.
- Versioned model `ref('m', v=2)` with two versions → opens version 2's file. Test: `callAt` + `resolveRef` with versions.
- Manifest missing → ref falls back to a `<name>.sql` file search; source returns nothing (no error). Test: integration step with manifest deleted.
- Preview JSON with negative big ints and decimals (`-12345678901234567890`, `1.5`) → negatives exact, decimals untouched. Test: show.test.

---

### Task 1: esbuild bundling
**Files:** `package.json`, `.vscodeignore`, `.gitignore`
- [ ] Scripts: `build` = `esbuild src/extension.ts --bundle --platform=node --target=node18 --format=cjs --external:vscode --outfile=dist/extension.js --sourcemap`; `typecheck` = `tsc --noEmit -p .`; `compile` = typecheck + tsc for tests (`tsc -p .`, outDir out); `vscode:prepublish` = `npm run build`; `main` = `./dist/extension.js`.
- [ ] `.vscodeignore` excludes `node_modules/**`, `out/**`, `src/**`, `test/**`, `.github/**`, `**/*.map`; `.gitignore` adds `dist/`, `.vscode-test/`.
- [ ] Verify: `npx vsce package` lists only `dist/extension.js`, package.json, readme, license, changelog-less; extension installs & integration suite passes (Task 6).

### Task 2: manifest + jinja parsers (TDD)
**Files:** Create `src/manifest.ts`, `src/jinja.ts`, `src/test/manifest.test.ts`, `src/test/jinja.test.ts`
**Produces:**
- `interface ModelEntry { name: string; package: string; version?: number|string; file: string }`, `interface SourceEntry { source: string; table: string; file: string }`
- `parseManifest(json: string, root: string, rootPackage: string): { models: ModelEntry[]; sources: SourceEntry[] } | undefined` — file = `root` + original_file_path for root package, else `root/dbt_packages/<package>/` + path.
- `resolveRef(models, name, pkg?, version?): ModelEntry | undefined` — with no version prefer the model whose `version` equals the manifest's `latest_version` if present, else first.
- `type JinjaCall = { kind: 'ref'; name: string; package?: string; version?: string } | { kind: 'source'; source: string; table: string }`
- `callAt(line: string, col: number): JinjaCall | undefined` — col anywhere inside `ref(...)`/`source(...)`.
- `completionContext(before: string): { kind: 'ref' } | { kind: 'sourceName' } | { kind: 'sourceTable'; source: string } | undefined`
- [ ] Tests: root & package model paths; source entries; `callAt` on `{{ ref('b') }}` at name/quote/paren, `ref('pkg', 'm')`, `ref("m", v=2)`, `source('raw', 'orders')`, outside call → undefined; `completionContext` for `{{ ref('st`, `source("`, `source('raw', 'or`, plain text → undefined.

### Task 3: language providers
**Files:** Create `src/language.ts`; modify `src/extension.ts`, `package.json`
**Produces:** `registerLanguageFeatures(ctx, deps: { projectRootOf(file): string|undefined; targetDirOf(root): string })`
- [ ] DefinitionProvider (`{ language: 'sql', scheme: 'file' }` + `jinja-sql`): ref → model file (manifest, else `**/<name>.sql` under project excluding dbt_packages/target); source → YAML at line of `- name: <table>` after `name: <source>`.
- [ ] CompletionItemProvider triggered by `'` `"` `,` ` `: models (label name, detail package/path), source names, tables.
- [ ] CodeLensProvider on model files when `dbtRunner.codeLens`: Run · Build · Test · Compile · Preview → existing commands with the doc uri.
- [ ] Manifest cache keyed by path+mtime.

### Task 4: fixes (preview big ints, settings panel, status bar)
**Files:** `src/show.ts`, `src/test/show.test.ts`, `src/settingsPanel.ts`, `src/extension.ts`
- [ ] Test first: `parseShowOutput` preview `[{"id": 12345678901234567890, "n": -98765432109876543210, "x": 1.5, "s": 3}]` → id/n as exact strings, x 1.5, s 3.
- [ ] Implement with `JSON.parse(text, (k, v, ctx) => ...)` keeping `ctx.source` for unsafe integers.
- [ ] Settings: try/catch on save → `{type:'saveError', message}`; blank → `undefined`; reopening re-posts state/targets.
- [ ] Status: refresh on `window.onDidChangeWindowState(focused)` and in `showMenu`.
- [ ] `openDocsAfterGenerate` setting honoured.

### Task 5: integration tests in repo
**Files:** `test/integration/run.js`, `test/integration/suite.js`, `test/fixtures/demo/**`
- [ ] Fixture: dbt_project.yml (name demo, profile demo), profiles.yml (dev/prod duckdb), models/b.sql, c.sql, staging/stg_a.sql, schema.yml (not_null b.id), sources.yml (raw.orders/customers), seeds/s.csv.
- [ ] Runner copies fixture to `.vscode-test/work/demo` (fresh each run), creates `.vscode-test/dbt-venv` (`py -3.12 -m venv` or `python -m venv`, pip install `dbt-core~=1.12.0 dbt-duckdb`) if missing, writes workspace settings (venv, openDocsAfterGenerate false), runs tests; exits non-zero on any FAIL.
- [ ] Suite: all v0.2 steps + go-to-definition (ref, package-less fallback without manifest, source), completion list contains `stg_a`, CodeLens count 5 on a model, docs page generated and not opened.
- [ ] `npm run test:integration` = `npm run build && node test/integration/run.js`.

### Task 6: CI + release
**Files:** `.github/workflows/ci.yml`, `package.json` (version 0.3.0), `README.md`
- [ ] Job on push/PR (main) + tags `v*`: windows-latest, setup-node 20, setup-python 3.12, `npm ci`, `npm run compile`, `npm test`, `npm run test:integration`, `npx vsce package`; on tags: verify tag matches version, `gh release create $TAG *.vsix --generate-notes`, permissions `contents: write`.
- [ ] Final review subagent; fix Critical/Important with tests.
- [ ] Commit, push, tag `v0.3.0`, watch CI publish release; install locally.
