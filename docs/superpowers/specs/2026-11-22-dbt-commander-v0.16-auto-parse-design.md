# v0.16 design: parse automatically so the sidebar keeps up with your files

## Problem
The sidebar, Tests view, lineage, completion and go-to-definition all read `target/manifest.json`, and the
sidebar refreshes when that file changes. Saving a model, adding a YAML entry or creating a file doesn't change
the manifest until `dbt parse` (or another dbt command) runs, so the sidebar shows the project as it was.

## Behaviour
- **When it parses:** after a file is **saved, created, deleted or renamed** under a project's model, seed,
  snapshot, test, macro or analysis paths, or `dbt_project.yml` / `packages.yml` / `selectors.yml` changes.
  Changes in `target/`, the packages folder, `logs/`, `.git` and venvs never count.
- **Debounce:** wait 1.5 s after the last change, per project, so a burst of saves (or a generator that writes
  six files, like the SCD2 command) gives one parse.
- **Never alongside another dbt command in that project.** dbt writes `target/` on every command; two at once
  can corrupt `partial_parse.msgpack` or the manifest. While a dbt task (run / build / test / seed / …) or a
  background dbt process (preview, compile, show, column lookups) is running for the project, the parse waits
  and runs once after the last one ends. A command that itself parses (everything but `dbt deps` / `dbt
  clean` / `dbt debug`) clears the pending parse instead, because its manifest is already current.
- **At most one parse per project at a time;** changes during a parse queue one more parse after it.
- **Quiet:** runs in the background (no terminal, no notification) with the current target and only the extra
  flags parse accepts (`--profiles-dir`, `--vars`, `--profile`, `--project-dir`; run flags like `--full-refresh`
  would fail it). Stopped after 5 minutes (reported as a failure), and on window close. The status bar item shows
  `$(sync~spin) dbt parse` while it runs.
- **Failure:** a failed parse (a Jinja / YAML error mid-edit is normal) leaves the last good manifest as it
  is, so the sidebar keeps showing the project as it was last parsed. The status bar shows `$(warning) dbt parse failed`; clicking it opens the "dbt Commander: auto-parse"
  output channel with dbt's error text. The next successful parse clears it. No pop-ups.
- **Off switch:** `dbtCommander.autoParse` (boolean, **default on**), with a toggle on the settings page
  ("Parse automatically when project files change"). Off = today's behaviour (manual Refresh / Parse).
- **No dbt yet / no venv:** auto-parse does nothing until dbt is found (no errors repeated per save).
- **Unsaved edits** don't trigger a parse (dbt reads files from disk).

## Design
- New `src/autoparse.ts`:
  - `AutoParser` (VS Code side): owns the file watcher + `onDidSaveTextDocument`, a per-project state
    `{ timer, running, again, failed }`, and the status bar text.
  - Pure helper `parseTrigger(rel, paths): boolean` — whether a project-relative path counts (unit tested).
- New small "busy" registry in `runner.ts`: `dbtBusy(root)` / `onDbtIdle(root)`. `runDbtTask` and the
  background `execFile` runners (`extension.ts` relation columns, `query.ts` show / compile) register while
  their process lives. The auto-parse runner registers too, so a user command started during a background
  parse waits for it to end. That waiting is the one behaviour change for user commands; parse is usually
  1–5 s with partial parsing.
- The sidebar needs no change: its `manifest.json` watcher already refreshes it. Same for the Tests view.
- The watcher replaces nothing. The existing create/delete watcher for folder menus keeps its job.

## Tests
- **Unit:** `parseTrigger` for model / YAML / macro / test paths, target / packages / logs / `.git` excluded,
  custom `model-paths`, Windows separators; debounce + queue logic with a fake clock and a fake runner
  (burst → one parse, change during a parse → exactly one more, busy → waits, failure → `failed` set, then
  cleared).
- **Integration:**
  - Write a new model file → it appears in the sidebar without a command.
  - Edit a YAML description and save → the manifest has it.
  - A broken file → status bar shows the failure and the sidebar still lists the other models, then fixing it
    clears the failure.
  - Auto-parse off → nothing runs.
  - Start a `dbt run` and save a file meanwhile → the parse runs only after the run ends.

## Known gaps
- dbt run outside the extension (a terminal, the SQLFluff dbt templater) isn't tracked: it can still overlap a
  background parse.
- A created / deleted folder whose name has a dot (`models/v1.2`) doesn't trigger a parse; its files do.
- A command that fails (non-zero exit) doesn't count as having parsed: the pending parse still runs.
- Changes made while auto-parse is off aren't caught up when it's turned back on (until the next change).

## Out of scope
- Showing unparsed files in the sidebar straight from disk.
- Parsing on every keystroke / unsaved buffers.
