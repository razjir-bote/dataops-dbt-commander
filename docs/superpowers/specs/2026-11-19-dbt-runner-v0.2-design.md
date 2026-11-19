# dbt Runner v0.2 — design

## Intent
Cut the remaining trips out of VS Code in a dbt-core 1.12 workflow: run whole folders, run the open
model from the editor, switch targets quickly, see compiled SQL and data previews, jump to errors,
and run project-level commands. Builds on v0.1 (right-click run/build/test, venv settings panel).

## Goals (user picked 1, 4, 5, 6, 7, 8, 9 from the proposal)
1. **Folder runs** — right-click a folder under `models/` → dbt → Run / Build / Test
   (`--select path:models/staging`).
4. **Editor title button + shortcuts** — ▶ button on dbt model editors runs Build; keyboard shortcuts.
5. **Target switcher** — status bar item showing the active target; click → quick pick of targets
   read from `profiles.yml`; saves `dbtRunner.target`.
6. **Compiled SQL** — "dbt Compile" compiles the model and opens `target/compiled/...` beside it.
7. **Preview data** — "dbt Preview" runs `dbt show` and shows rows in a table panel.
8. **Clickable errors** — dbt errors/test failures become entries in the Problems panel on the file.
9. **Project commands** — dbt deps / seed / snapshot / docs generate, from the command palette and
   the status bar menu.

## Non-goals
Full-refresh item (2) and run/test upstream/downstream (3) — user declined. `docs serve`, lineage
view, inline-SQL preview, dbt 2 / Fusion.

## Approaches considered (for the part with a real choice: how output is captured, feature 8)
- **A. Contributed problem matcher on the existing ProcessExecution tasks** — little code, but dbt
  prints paths relative to the project root and matcher `fileLocation` resolution against a per-task
  cwd is unreliable; parsing can't be unit-tested.
- **B. CustomExecution + pseudoterminal (chosen, Claude's call)** — extension spawns dbt itself, streams
  output to the task terminal (colours kept), and parses lines into a DiagnosticCollection with
  absolute paths. Parser is a pure, tested function. Also gives the exit code, which Compile needs
  to open the compiled file afterwards.
- **C. Output channel instead of terminal** — simplest capture, but loses colours and the familiar
  task terminal / rerun.

## Design
**Runner (`src/runner.ts`).** `runDbtTask({root, args, title}) → Promise<exitCode>`: a VS Code Task
with `CustomExecution`; pseudoterminal spawns `dbt.exe` (no shell), writes output with `\r\n`,
kills the process on close. Each line (ANSI and timestamp stripped) goes to the error parser.
Diagnostics are cleared at the start of each run.

**Error parser (`src/errors.ts`, pure).** Headers matched (from real dbt 1.12.7 output):
`<Kind> Error in <type> <name> (<relpath>)`, `Failure in test <name> (<relpath>)`,
`Warning in test ...`. Following indented lines (until a blank line) are the message, excluding
`compiled code at ...`. `line N` in a Compilation Error sets the line. Paths resolved against the
project root. Error/Failure → Error severity, Warning → Warning.

**Folder runs.** Same submenu; Run/Build/Test shown for folders inside `models` (excluding
`dbt_packages`/`target`). Model-only items (Compile, Preview, upstream/downstream builds) hidden
for folders. Selector `path:<folder relative to root>`.

**Editor.** `editor/title` ▶ (Build) on `.sql` model files. Shortcuts (only when a dbt model is the
active editor): Ctrl+Alt+B build, Ctrl+Alt+R run, Ctrl+Alt+T test, Ctrl+Alt+C compile,
Ctrl+Alt+P preview. Dirty files are saved before running.

**Targets.** Find profile name in `dbt_project.yml` (`profile:`), find `profiles.yml` in dbt 1.x
order: `--profiles-dir` in extra flags → `DBT_PROFILES_DIR` → project root → `~/.dbt/`. List
`outputs` keys, marking the profile's default. Picking "(profile default)" clears the setting.
Settings panel target field gets the same list as suggestions. Uses the `yaml` npm package.

**Compile.** `dbt compile --select path:<model>`; on exit 0 open
`<root>/<target-path or "target">/compiled/<project name>/<model relpath>` beside the editor.

**Preview.** `dbt show --select path:<model> --limit <dbtRunner.previewLimit, default 100>
--output json --log-format json`, captured (not a terminal). Rows from the `ShowNode` event's
`data.preview`; errors from `level: error` events shown in the panel. Panel: model name, row count,
elapsed time, sticky-header table, Refresh button. Progress notification while running.

**Project commands.** `deps`, `seed`, `snapshot`, `docs generate` run in the dbt project of the
active editor, or a quick pick if the workspace has several projects. Status bar `dbt` item now opens
a menu: these commands + Open Settings.

**Flags.** Target applies to everything but `deps`; extra flags apply to everything but `deps`.

## Changes after review (implementation)
- Shortcuts are chords `Ctrl+'` then B/R/T/C/P: Ctrl+Alt+B is VS Code's "Toggle Secondary Side Bar", Ctrl+Alt is
  AltGr on European layouts, and `Ctrl+;` is VS Code's Testing chord prefix. `Ctrl+'` was verified unused by defaults.
- Diagnostics are tracked per dbt node: a run replaces problems only for the nodes it executed (from
  `run_results.json`) and nodes it reports, instead of clearing everything.
- dbt commands are refused in untrusted workspaces; `dbtRunner.target` is also a restricted setting.
- Stopping a run kills the whole process tree (`taskkill /T`), since `dbt.exe` launches python.exe.
- dbt 1.12 prints test failures as `[ERROR]: in test x (path)` / `[WARNING]: in test x (path)`; the parser handles both.

## Claude's calls (correct if wrong)
- Approach B for output capture.
- ▶ button runs Build (not Run); shortcut keys above.
- Extra flags apply to compile/show/seed/snapshot/docs too (needed for `--vars`, `--profiles-dir`).
- Version bumps to 0.2.0 with a new GitHub release once done.
