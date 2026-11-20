# dbt Runner v0.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dbt tests in VS Code's Testing panel, and hovers on `ref()`/`source()`.

**Architecture:** Manifest gains descriptions/columns/test details; new pure `runresults.ts` (run_results parsing, test locations, hover markdown); `testing.ts` (TestController running dbt and mapping run_results); `hover.ts` (HoverProvider). Shared manifest cache and watcher.

**Tech Stack:** TypeScript, VS Code Testing + Hover APIs, node:test, existing integration harness.

**Spec:** `docs/superpowers/specs/2026-11-20-dbt-runner-v0.5-design.md`

## Global Constraints
- Results only from `<target>/run_results.json` written by this run (mtime ≥ run start); statuses pass/fail/warn/error/skipped; warn → passed + message.
- Selectors: generic tests by name, singular by `path:`; project-level run → `dbt test` with no `--select`.
- Hover never calls the warehouse; catalog.json only if present.
- Version 0.5.0, commit only.

**User decisions (already made):** v0.5 design approved as written.

## Review Focus
- Run requested while manifest is missing → message "run dbt parse", no crash. Test: integration (manifest deleted).
- A test that errors (compile error in its model) → failed with dbt's error message, not left "running". Test: integration with a broken test model.
- Cancelling a run → items end as skipped, dbt killed. Test: covered by killTree; unit-level mapping of missing results → skipped.
- Hover on a ref to a model without description/columns → still shows name, materialization, path. Test: `modelHover` unit case.
- Markdown injection from descriptions (e.g. `[x](command:...)`) → hover markdown not trusted. Test: hover is `isTrusted` false (unit: rendered text escapes nothing harmful; MarkdownString not trusted).

---

### Task 1: manifest details + pure helpers (TDD)
**Files:** `src/manifest.ts`, create `src/runresults.ts`, tests `src/test/runresults.test.ts`, `src/test/macros.test.ts`
**Produces:**
- `ColumnInfo { name: string; dataType?: string; description?: string }`
- ModelEntry + `description?`, `columns: ColumnInfo[]`; SourceEntry + `description?`, `sourceDescription?`, `loader?`, `identifier?`, `columns`; NodeEntry (tests) + `columnName?`, `singular: boolean`, `uniqueId`.
- `parseRunResults(json): { uniqueId: string; status: string; message?: string; seconds?: number }[]`
- `testLine(yamlText, model, column?)`: 0-based line of `- name: <column>` inside the model's entry, else the model's `- name:` line, else 0.
- `parseCatalog(json): Map<uniqueId, ColumnInfo[]>` (types from catalog `columns[*].type`, ordered by `index`).
- `modelHover(model, catalogCols?, root)` / `sourceHover(source, catalogCols?, root)` → markdown string.
- [ ] Tests first for each, incl. hover without description/columns.

### Task 2: Testing panel (`src/testing.ts`)
- [ ] `TestController('dbtRunner.tests', 'dbt')`; items project → group → test, ids = unique_id; `uri`+`range` per test; rebuilt on manifest change and `resolveHandler`.
- [ ] Run profile (default): collect requested leaves (expand groups; exclude `request.exclude`); project-level request → no selector; else selectors; mark enqueued/started; spawn dbt `test --select …` + flags with `PYTHONIOENCODING`, stream to `run.appendOutput` (CRLF), cancel → killTree; on exit read run_results (fresh only), map statuses; tests without results → skipped (or errored with output tail if dbt failed before running); update Problems via DbtDiagnostics.
- [ ] `activate` exposes `{ sidebar, tests }`.

### Task 3: hover (`src/hover.ts`)
- [ ] HoverProvider on the dbt SQL selector: `callAt` → model via `resolveRef` / source; catalog cached by mtime; `MarkdownString` (not trusted, supportHtml false) with `command:`-free file link (`vscode.Uri.file(...).toString()` link).

### Task 4: integration + finish
- [ ] Steps: Testing tree has `b` group with `not_null_b_id`; run that test → passed; failing test (dup model with unique test) → failed with message; run model group; hover on `ref('b')` shows "materialization" and `id`; hover on source shows `customers`.
- [ ] Review subagent; fix; README; version 0.5.0; commit.
