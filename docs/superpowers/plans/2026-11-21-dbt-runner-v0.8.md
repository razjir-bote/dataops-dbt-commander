# dbt Runner v0.8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** dbt debug, rename model, staging model from a source, new model from a template, exposures / semantic models, open in dbt docs.
**Spec:** `docs/superpowers/specs/2026-11-21-dbt-runner-v0.8-design.md`

## Global Constraints
- Rename = one WorkspaceEdit with refactor preview (`needsConfirmation`), never applied silently; model names `^[A-Za-z_][A-Za-z0-9_]*$`.
- `ref()` rewriting keeps quote style and package argument; only exact name matches.
- Docs URL: `static_index.html#!/<resource_type>/<unique_id>`; regenerate (`docs generate --static`) when the page is missing or older than manifest.json.
- dbt debug summary: "All checks passed!" → ok; else the text after "N check(s) failed:".
- Per-commit checks: typecheck + unit tests; integration once at the end.

## Review Focus
- `ref('old')` inside a longer name (`ref('old_v2')`) or a comment → untouched / only real calls. Test: renameRefEdits.
- Rename to a name that already exists → refused before any edit. Test: integration.
- YAML `- name: old` under `columns:` (a column named like the model) → untouched. Test: renameYamlEdits.
- Source/table names with spaces or dashes → valid staging file name. Test: stagingName.
- Template with no `{{name}}` placeholder → used as-is. Test: newModelSql.

### Task 1 (TDD): `refactor.ts` (renameRefEdits, renameYamlEdits, isValidModelName), `scaffold.ts` (stagingName, stagingSql, newModelSql, docsFragment, debugSummary); manifest exposures/semantic models.
### Task 2: commands — debug, rename (Explorer/sidebar/editor), staging (sidebar source table + source() in SQL), new model (folder), open in docs; package.json menus/settings.
### Task 3: sidebar Exposures / Semantic models sections; lineage + hover include them.
### Task 4: integration steps (rename with preview applied programmatically, staging, new model, docs URL, debug, exposures), review, README + handover, ask to commit.
