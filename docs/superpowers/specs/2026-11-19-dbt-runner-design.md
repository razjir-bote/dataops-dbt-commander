# dbt Runner — VS Code extension design

## Intent
Right-click a dbt model (`.sql`) in the VS Code Explorer and run / build / test it, without
typing commands or activating a venv. dbt is installed in a venv whose path the user sets
through a GUI. Must target **dbt-core 1.12** (1.x CLI), not dbt 2 / Fusion.

## Goals
- Explorer context menu on `.sql` files under a `models` folder: **dbt Run**, **dbt Build**, **dbt Test**.
- A custom settings panel (webview) for: venv path (text field + Browse), detected dbt version,
  target, extra flags.
- Run dbt straight from `<venv>\Scripts\dbt.exe` — no PATH or activation needed.

## Non-goals (for now)
- Graph selectors (`+model`, `model+`), compile/preview, lineage, query results.
- Supporting dbt 2 / Fusion, or non-venv installs (conda, docker).
- Marketplace publishing (local `.vsix` install only).

## Anti-goals
- Silently running the wrong dbt (e.g. dbt 2 or a global one) — must warn instead.

## Approaches considered
- **A. Folder picker + status bar + native settings** — smallest, but no dedicated page.
- **B. Custom settings panel (chosen by user)** — dedicated page, room for more options; more code.
- **C. Reuse Python extension's interpreter** — no UI, but couples dbt venv to Python interpreter choice.

## Design
**Context menu.** A "dbt" submenu in `explorer/context`, shown when
`resourceExtname == .sql` and the path contains a `models` folder. Multi-select supported:
all selected models go into one `--select a b c`.

**Command.** For each invocation: find the dbt project root by walking up from the file to
the nearest `dbt_project.yml`; model name = file name without `.sql`. Run
`<venv>\Scripts\dbt.exe <run|build|test> --select <models> [--target <t>] [extra flags]`
with cwd = project root, as a VS Code task using `ProcessExecution` (no shell quoting issues;
output shows in the terminal panel, re-runnable). If the venv isn't set or `dbt.exe` is
missing, show an error with a button that opens the settings panel.

**Settings panel.** Webview opened by command "dbt Runner: Open Settings" and by clicking a
status bar item (`dbt 1.12.x` / `dbt: not configured`). Fields:
- Venv path — text input + **Browse** (native folder picker via the extension host).
- Detected dbt version — runs `dbt.exe --version` on load and when the path changes; shows the
  version, and a warning if major version ≠ 1 or dbt isn't found.
- Target — optional, passed as `--target`.
- Extra flags — free text, split on whitespace, appended to every command.
- **Save** writes to VS Code settings (`dbtRunner.venvPath`, `dbtRunner.target`,
  `dbtRunner.extraArgs`) at workspace scope, so each project can use its own venv.

**Tech.** TypeScript, plain HTML/CSS webview using VS Code theme variables, no UI framework.
Packaged with `@vscode/vsce` into a `.vsix`.

## Calls made by Claude (correct if wrong)
- Workspace-scoped settings (per project), not global.
- Context menu limited to `.sql` files in a `models` path.
- Tasks/ProcessExecution rather than typing into a shared terminal.
- Extra flags split on whitespace (no quoted-argument support).

## Left to the builder
File layout, version-parsing details, icon/status-bar styling.
