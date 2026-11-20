# dbt Runner v0.7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** custom dbt folder names and package path; retry / rerun-last / long-run notifications; last-run status, Last run view; column autocomplete; find references.
**Spec:** `docs/superpowers/specs/2026-11-21-dbt-runner-v0.7-design.md`

## Global Constraints
- dbt 1.x defaults: model-paths [models], seed-paths [seeds], snapshot-paths [snapshots], analysis-paths [analyses], macro-paths [macros], test-paths [tests], packages-install-path dbt_packages, target-path target.
- Run status only from fresh run_results.json (invocation changed); newest result per node wins; persisted in workspaceState.
- `dbt retry` runs in the project of the last run; `Rerun` repeats exact args.
- Notify threshold setting `dbtRunner.notifyAfterSeconds` (default 30, 0 = off).
- Commit only.

## Review Focus
- Paths with `./` prefixes or trailing slashes in dbt_project.yml (`model-paths: ["./transform/"]`) → normalised. Test: projectPaths.
- A run_results.json from `dbt compile` / `docs generate` (no statuses meaningful) → ignored for status. Test: mergeResults with which=compile.
- Alias defined on a later line than the cursor, or several aliases per file → correct columns. Test: aliasesIn multi-line.
- `ref('x')` written with double quotes / package arg → found as a reference. Test: refLines.
- Retry with no previous run → message, no crash. Test: integration.

### Task 1 (TDD): `projectconfig.ts` (`projectPaths`), manifest uses packages path.
### Task 2 (TDD): `runstate.ts` (`mergeResults`, `statusBadge`, `runSummary`, `slowest`).
### Task 3 (TDD): `columns.ts` (`aliasesIn`, `aliasBefore`), `refLines(text, name)`.
### Task 4: custom-path context keys + menus/CodeLens/keybindings; language/sidebar use configured paths.
### Task 5: run state store, sidebar/CodeLens badges, Last run view, retry, rerun-last, notifications.
### Task 6: column completion + reference provider.
### Task 7: integration (custom-path project fixture, retry, rerun, last run view, badges, columns, references), review, README, commit.
