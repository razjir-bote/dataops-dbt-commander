# dbt Runner v0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add folder runs, editor ▶/shortcuts, target switcher, compile view, data preview, Problems-panel errors and project commands to dbt Runner.

**Architecture:** Pure, unit-tested parsers (`errors.ts`, `profiles.ts`, `show.ts`, additions to `dbt.ts`); a CustomExecution runner (`runner.ts`) that streams dbt output to a task terminal and feeds the error parser; a preview webview (`previewPanel.ts`); wiring in `extension.ts` + `package.json`.

**Tech Stack:** TypeScript, VS Code API ^1.90, `node:test`, `yaml` (runtime dependency, bundled in vsix).

**Spec:** `docs/superpowers/specs/2026-11-19-dbt-runner-v0.2-design.md`

## Global Constraints
- dbt-core 1.x CLI only; dbt spawned without a shell (`child_process.spawn/execFile`).
- Target + extra flags apply to every command except `deps`.
- Menus only for `models` paths, never `dbt_packages`/`target` (existing `when` regexes).
- Version 0.2.0.

## Review Focus
- Error header printed twice (`[ERROR]: in model bad (...)` then `Runtime Error in model bad (...)`) → one problem. Test: `parseDbtErrors` dedupe case.
- Windows backslash paths in dbt output (`models\bad.sql`) → resolved to the real file. Test: errors fixture uses backslashes.
- `profiles.yml` containing Jinja (`{{ env_var('X') }}`) → still lists targets. Test: `listTargets` jinja case.
- `dbt show` failure (no ShowNode event) → error text shown, not an empty table. Test: `parseShowOutput` error fixture.
- Folder right-click on the `models` folder itself → `path:models`. Test: `modelSelector` folder case.

---

### Task 1: Error parser + runner
**Files:** Create `src/errors.ts`, `src/runner.ts`, `src/test/errors.test.ts`
**Produces:**
- `cleanLine(raw: string): string` — strips ANSI codes and a leading `HH:MM:SS  ` timestamp.
- `interface DbtProblem { relPath: string; line: number /*0-based*/; message: string; severity: 'error' | 'warning' }`
- `parseDbtErrors(output: string): DbtProblem[]` — headers `^(?:(\w+) Error|Failure|Warning) in \w+ \S+ \(([^)]+)\)`; message = following lines that are indented after `cleanLine`, until a blank line, excluding `compiled code at`; `line N` sets line N-1; dedupe on relPath+message.
- `runDbtTask(opts: { exe: string; args: string[]; cwd: string; title: string; diagnostics: vscode.DiagnosticCollection; folder?: vscode.WorkspaceFolder }): Promise<number | undefined>` — CustomExecution pseudoterminal; resolves with exit code.
- [ ] Tests (fixtures copied from real dbt 1.12.7 output): runtime error with `[ERROR]: in model` duplicate → 1 problem, path `models\bad.sql`, message starts `Catalog Error`; compilation error → line 0 from `line 1`, message `unexpected '}', expected ')'`; `Failure in test not_null_b_id (models/schema.yml)` → error on schema.yml; `Warning in test ...` → warning; clean run → `[]`.
- [ ] RED, implement, GREEN.

### Task 2: Profiles + target switcher
**Files:** Create `src/profiles.ts`, `src/test/profiles.test.ts`
**Produces:**
- `parseProjectFile(text: string): { name?: string; profile?: string; targetPath?: string }`
- `profilesDirCandidates(root: string, extraArgs: string, env: NodeJS.ProcessEnv, home: string): string[]` — order: `--profiles-dir X` (relative → against root), `DBT_PROFILES_DIR`, root, `home/.dbt`.
- `listTargets(profilesText: string, profile: string): { targets: string[]; defaultTarget?: string } | undefined`
- [ ] Tests: project file fields incl. `target-path`; candidates order with `--profiles-dir .`; listTargets with Jinja values and default; unknown profile → undefined.
- [ ] RED, implement (`yaml` package), GREEN.
- [ ] Status bar target item + `dbtRunner.selectTarget` quick pick ("(profile default: dev)" clears setting); settings panel target input gets a `<datalist>` of targets.

### Task 3: Folder runs, editor ▶, shortcuts
**Files:** Modify `src/dbt.ts`, `src/extension.ts`, `package.json`, `src/test/dbt.test.ts`
- [ ] Test: `modelSelector('C:/p', 'C:/p/models')` → `path:models`; folder `models/staging` → `path:models/staging`.
- [ ] `runDbt` accepts folders (stat isDirectory) and `.sql`; saves dirty documents first; uses `runDbtTask`.
- [ ] package.json: folder `when` (`explorerResourceIsFolder && resourcePath =~ /[\\/]models([\\/]|$)/i` + exclusions); model-only items get `!explorerResourceIsFolder`; `editor/title` ▶ `dbtRunner.build` (icon `$(play)`); keybindings Ctrl+Alt+B/R/T/C/P with `editorTextFocus && resourceExtname =~ /^\.sql$/i && resourcePath =~ models…`.

### Task 4: Compile + preview
**Files:** Create `src/show.ts`, `src/previewPanel.ts`, `src/test/show.test.ts`; modify `src/extension.ts`, `package.json`
**Produces:**
- `parseShowOutput(output: string): { rows?: Record<string, unknown>[]; error?: string }` — scans JSON log lines; `info.name === 'ShowNode'` → `JSON.parse(data.preview)`; else first `level: error` → `data.exc ?? info.msg` (ANSI stripped).
- `compiledPath(root: string, projectName: string, targetPath: string | undefined, modelFile: string): string`
- `PreviewPanel.show(model: string, result, elapsedMs, onRefresh)`.
- [ ] Tests: ShowNode fixture → `[{id: 1}]`; error fixture → error contains `Catalog Error`; `compiledPath` → `<root>/target/compiled/demo/models/b.sql`.
- [ ] Commands `dbtRunner.compile` (runDbtTask then open beside on exit 0) and `dbtRunner.preview` (execFile with progress notification, `--limit dbtRunner.previewLimit` default 100). Setting `dbtRunner.previewLimit`.

### Task 5: Project commands + status bar menu
**Files:** Modify `src/extension.ts`, `package.json`
- [ ] Commands `dbtRunner.deps|seed|snapshot|docsGenerate`; project = active editor's project, else single `dbt_project.yml` in workspace, else quick pick.
- [ ] Status bar dbt item → `dbtRunner.menu` quick pick: Deps, Seed, Snapshot, Docs Generate, Switch Target, Open Settings.

### Task 6: Verify + release
- [ ] `npm run compile && npm test` green; e2e script against scratch dbt 1.12.7 project for parsers (real show + error output).
- [ ] Final review subagent; fix Critical/Important with tests.
- [ ] Bump 0.2.0, package, commit, push, `gh release create v0.2.0`.
