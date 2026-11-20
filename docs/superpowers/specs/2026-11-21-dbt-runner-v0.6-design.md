# dbt Runner v0.6 — design

## Intent
1. The sidebar should do what the Explorer now does: run dbt on a whole folder (and section), not only on single
   files.
2. A lineage panel: see what the open model depends on and what depends on it, and jump there.

## Goals
**Sidebar folders**
- Seeds are shown **by folder** (like Models), so `seeds/ref` is a node.
- Inline buttons:
  - model folder: Run · Build · Test (exists) — unchanged
  - seed folder: **Seed · Build** (everything inside, subfolders included)
  - **Models** section: Run · Build · Test on the models folder
  - **Seeds** section: Seed · Build on all seeds
  - **Snapshots** section: Snapshot all
  - project node (multi-project workspaces): Build · Seed the whole project
- Same selectors as the Explorer (`path:<folder>`; the project itself = no selector).

**Lineage panel**
- A **Lineage** view under Project in the dbt sidebar. It follows the active editor: open a model (or seed /
  snapshot) and it shows that node with two branches:
  - **Upstream** — parents (models, seeds, snapshots, sources), each expandable to *its* parents, and so on.
  - **Downstream** — children (models, snapshots, exposures), each expandable further. Tests are left out
    (they're in the Testing panel).
- Click any node to open its file (sources open the YAML at the table). Model nodes have a Build button.
- "Show lineage" on sidebar models (right-click) pins the panel to that model; the panel title shows which model
  it's following. Refreshes when the manifest changes.

## Non-goals
A drawn graph (DAG picture), column-level lineage, editing lineage, showing tests in lineage.

## Approaches (lineage)
- **A. Tree view in the dbt sidebar (chosen, Claude's call)** — native, keyboard-friendly, themed, cheap; each
  level expands on demand, so large DAGs stay fast. Not a picture.
- **B. Webview drawing a graph** — the dbt-docs look, but needs a layout library, custom theming and scrolling,
  and gets unreadable past a few dozen nodes.
- **C. Peek / references list** — reuses VS Code's references UI, but can't show multiple levels.

## Design notes
- `manifest.ts`: `parents: Map<id, id[]>`, `children: Map<id, id[]>` from `parent_map` / `child_map`; a
  `nodeInfo(id)` lookup (name, type, file, package) covering models, seeds, snapshots, sources, exposures.
- `lineage.ts`: `TreeDataProvider`; root = followed node; branches build lazily; cycles impossible in dbt but
  guarded by depth/visited anyway.
- Sidebar: seeds folder tree via the same folder logic as models; `contextValue`s `seedFolder`, `section-models`,
  `section-seeds`, `section-snapshots`, `project`.
- Tests: unit tests for lineage maps and seed folder grouping; integration: seed folder node + Seed button,
  section buttons, lineage for `b` (upstream `stg_a`, downstream `c`), clicking opens the file, following the
  active editor.

## Changes after review (implementation)
- Section buttons act on the section's top-level folder(s) (`sectionTargets`), never the whole project — with
  several model folders, Build on Models no longer also builds seeds and snapshots.
- Lineage: only sources/exposures read their YAML (cached per expansion); file→node map cached per manifest;
  picks up the open model when the first manifest appears; a pin made mid-lookup wins; a pinned node that left
  the manifest unpins itself; Build/Seed buttons only on the project's own .sql models and seeds.
- Palette "Show lineage" also for seeds and snapshots.

## Claude's calls (correct if wrong)
- Tree view, not a drawn graph.
- Lineage hides tests; shows sources and exposures.
- Section/project buttons as listed above.
- Committed only (no release).
