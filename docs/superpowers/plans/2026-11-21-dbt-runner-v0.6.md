# dbt Runner v0.6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Folder/section actions in the dbt sidebar (seeds by folder) and a Lineage tree view.
**Spec:** `docs/superpowers/specs/2026-11-21-dbt-runner-v0.6-design.md`

## Global Constraints
- Folder selection exactly as the Explorer: `path:<folder>`, project folder = no selector (`folderSelectors`).
- Lineage from manifest `parent_map` / `child_map`; tests (and unit tests) excluded; sources upstream, exposures downstream.
- Commit only.

## Review Focus
- Seeds that aren't under a `seeds/` folder (custom `seed-paths`) → still listed (top level), still seedable. Test: `levelOf` with mixed roots.
- Followed file that isn't a node (macro, yml) → lineage keeps the previous node, no error. Test: integration (open macro file).
- Node referenced in parent_map but missing from nodes/sources (disabled) → skipped, not "undefined". Test: `relatives` unit case.
- Very wide model (hundreds of children) → lazy expansion only. Covered by design (no eager recursion).
- Multi-project workspace: lineage uses the open file's project manifest. Covered by `projectRootOf`.

### Task 1 (TDD): `manifest.ts` lineage (`NodeInfo`, `nodes`, `parents`, `children`, `relatives(index, id, 'up'|'down')`) and pure `src/tree.ts` (`levelOf(root, files, dir)`).
### Task 2: sidebar — seeds by folder, section/project contextValues + resourceUris, inline buttons (`tree.seed` on folders/sections/project, `tree.build` on seed folders/sections/project, `tree.snapshotAll`), `Show lineage` on models.
### Task 3: `src/lineage.ts` view `dbtRunner.lineage` (follow editor, pin, follow-editor button, lazy branches, open on click, Build on models), exposed in `activate` API.
### Task 4: integration (sidebar seed folder + buttons, section buttons, lineage up/down/expand/open/follow), review, README, commit.
