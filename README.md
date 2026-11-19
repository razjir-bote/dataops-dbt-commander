# dbt Runner

Run dbt-core 1.x from the VS Code Explorer and editor, using dbt from a Python venv you choose.
Supports dbt-core 1.x (tested with 1.12); not dbt 2 / Fusion.

## Features

- **Right-click models or folders** under `models/` → **dbt** → Run / Build / Test.
  Multi-select works; folders run everything inside (`--select path:models/staging`).
- **Build + Upstream / + Downstream / + Upstream & Downstream** for a model (`+model`, `model+`, `+model+`).
- **▶ in the editor title** builds the open model. Unsaved changes are saved first.
- **Keyboard shortcuts** (while a model is open): `Ctrl+'` then
  `B` build · `R` run · `T` test · `C` compile · `P` preview.
- **dbt Compile** opens the compiled SQL beside the model.
- **dbt Preview Data** runs `dbt show` and shows the rows in a table (limit: `dbtRunner.previewLimit`, default 100).
- **Errors in the Problems panel**: compilation/runtime/database errors on the model (with the line when dbt
  gives one), test failures and warnings on the YAML file. A model's problems are replaced when it runs again.
- **Target switcher** in the status bar, listing the targets from your `profiles.yml`.
- **Project commands** — `deps`, `seed`, `snapshot`, `docs generate` — from the `dbt` status bar menu
  or the command palette.

## Setup

1. Install the `.vsix` from the [Releases](https://github.com/razjir-bote/vscode-dbt-runner/releases) page:
   `code --install-extension dbt-runner-<version>.vsix`
2. Click **dbt: not configured** in the status bar → **Settings**, browse to your venv (the folder containing
   `Scripts\dbt.exe`), check the detected version shows dbt-core 1.x, and Save.

Settings are saved per workspace. Extra flags apply to every command except `deps`
(quotes keep values together, e.g. `--vars '{"key": "value"}'`).

dbt runs your project's macros and hooks, so dbt Runner only runs in **trusted** workspaces, and in untrusted
ones the venv path, target and extra flags are read from your user settings only.
