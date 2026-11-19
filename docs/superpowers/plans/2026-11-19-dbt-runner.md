# dbt Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VS Code extension: right-click dbt models in the Explorer to run/build/test them using dbt-core 1.12 from a user-configured venv, with a custom settings webview.

**Architecture:** Pure, unit-tested helpers (`src/dbt.ts`) for path/arg/version logic; a webview settings panel (`src/settingsPanel.ts`); `src/extension.ts` wires commands, menus, status bar and runs dbt as a VS Code task with `ProcessExecution`.

**Tech Stack:** TypeScript (commonjs), `@types/vscode` ^1.90, `node:test` for unit tests, `@vscode/vsce` for packaging.

**Spec:** `docs/superpowers/specs/2026-11-19-dbt-runner-design.md`

## Global Constraints
- dbt executable: `<venvPath>\Scripts\dbt.exe` (Windows venv layout); fall back to `<venvPath>/bin/dbt` if the first doesn't exist.
- Must target dbt-core 1.x; warn (don't block) when detected major ≠ 1 or dbt not found.
- Settings keys: `dbtRunner.venvPath` (string), `dbtRunner.target` (string), `dbtRunner.extraArgs` (string); saved at Workspace scope.
- Menu only on `.sql` files whose path contains a `models` folder.
- Extra args split on whitespace.

## Review Focus
- Model in a nested subfolder (`models/staging/stg_x.sql`) → project root is the folder with `dbt_project.yml`, not `models/`. Test: `findProjectRoot` nested case.
- Multi-select of files from two different dbt projects → error message, nothing runs. Test: `groupByProject` returns >1 group → handled in extension.
- Venv path with spaces (`C:\My Envs\dbt`) → works (ProcessExecution, no shell). Test: `dbtExecutable` with spaces.
- Fusion/dbt 2 `--version` output → parsed as major 2 → warning. Test: `parseDbtVersion` fusion case.
- Empty/whitespace target and extraArgs → no stray `--target ""` or empty args. Test: `buildArgs` empty case.

---

### Task 1: Scaffold + pure helpers

**Files:**
- Create: `package.json`, `tsconfig.json`, `.vscodeignore`, `.gitignore`, `src/dbt.ts`, `src/test/dbt.test.ts`

**Interfaces — Produces (`src/dbt.ts`):**
- `type DbtAction = 'run' | 'build' | 'test'`
- `findProjectRoot(filePath: string, exists: (p: string) => boolean): string | undefined` — walks up dirs looking for `dbt_project.yml`.
- `modelName(filePath: string): string` — basename without `.sql`.
- `buildArgs(action: DbtAction, models: string[], target: string, extraArgs: string): string[]`
- `dbtExecutable(venvPath: string, exists: (p: string) => boolean): string | undefined`
- `parseDbtVersion(output: string): { version: string; major: number } | undefined` — prefer `installed:\s*(\d+\.\d+\.\d+)`, else first `\d+\.\d+\.\d+`.

- [ ] **Step 1: Write tests** in `src/test/dbt.test.ts` with `node:test` + `assert`:
  - `findProjectRoot('C:/p/models/staging/a.sql', p => p === path.join('C:/p','dbt_project.yml'))` → `path.join('C:/p')`; none found → `undefined`.
  - `modelName('C:/p/models/stg_orders.sql')` → `'stg_orders'`.
  - `buildArgs('build', ['a','b'], 'dev', '--full-refresh  --fail-fast')` → `['build','--select','a','b','--target','dev','--full-refresh','--fail-fast']`; `buildArgs('run',['a'],'  ','  ')` → `['run','--select','a']`.
  - `dbtExecutable('C:\\My Envs\\dbt', p => p.endsWith(path.join('Scripts','dbt.exe')))` → `path.join('C:\\My Envs\\dbt','Scripts','dbt.exe')`; nothing exists → `undefined`.
  - `parseDbtVersion('Core:\n  - installed: 1.12.0\n  - latest:    1.12.1')` → `{version:'1.12.0', major:1}`; `parseDbtVersion('dbt-fusion 2.0.0-preview.45')` → major 2; `parseDbtVersion('garbage')` → `undefined`.
- [ ] **Step 2:** `npm run compile && npm test` → FAIL (module missing).
- [ ] **Step 3:** Implement `src/dbt.ts` (no `vscode` import).
- [ ] **Step 4:** `npm test` → all pass. Scripts: `compile: tsc -p .`, `test: node --test out/test/`.

### Task 2: Settings panel

**Files:** Create `src/settingsPanel.ts`

**Interfaces:**
- Consumes: `dbtExecutable`, `parseDbtVersion`.
- Produces: `SettingsPanel.show(context: vscode.ExtensionContext, onSaved: () => void): void` (singleton); `detectDbtVersion(venvPath: string): Promise<{ exe?: string; version?: string; major?: number; error?: string }>` (exported, uses `child_process.execFile(exe, ['--version'])`, 30s timeout).

- [ ] **Step 1:** Webview (`enableScripts`, CSP with nonce) with fields: venv path + Browse, version line (OK / warning if major≠1 / error), target, extra flags, Save. Uses `--vscode-*` CSS vars.
- [ ] **Step 2:** Messages: webview→host `browse`, `check {venvPath}`, `save {venvPath,target,extraArgs}`; host→webview `state {venvPath,target,extraArgs}`, `version {...}`, `saved`. Browse uses `showOpenDialog({canSelectFolders:true})`. Save writes to `ConfigurationTarget.Workspace` (Global if no workspace open), then calls `onSaved`.
- [ ] **Step 3:** `npm run compile` → no errors.

### Task 3: Extension wiring + package

**Files:** Create `src/extension.ts`; modify `package.json` contributes.

- [ ] **Step 1:** `package.json` contributes: commands `dbtRunner.run|build|test|openSettings`; submenu `dbtRunner.submenu` ("dbt") in `explorer/context` with `when: resourceExtname == .sql && resourcePath =~ /[\\\\/]models[\\\\/]/`; hide run/build/test from command palette; configuration for the three keys. `activationEvents: ["workspaceContains:**/dbt_project.yml"]` (commands auto-activate).
- [ ] **Step 2:** Command handler `(uri, uris?)`: files = `uris ?? [uri]` (fallback active editor); group by `findProjectRoot`; >1 project or none → `showErrorMessage`; missing exe → error with "Open Settings" button; else `vscode.tasks.executeTask(new Task({type:'dbtRunner'}, Workspace, 'dbt <action> <models>', 'dbt', new ProcessExecution(exe, args, {cwd: root})))`.
- [ ] **Step 3:** Status bar item (left) → `dbtRunner.openSettings`; text `$(database) dbt <version>` / `$(warning) dbt <version>` (major≠1) / `$(gear) dbt: not configured`; refreshed on activate, on save, and on config change.
- [ ] **Step 4:** `npm run compile && npm test` pass; `npx @vscode/vsce package --allow-missing-repository` → `dbt-runner-0.1.0.vsix`.
- [ ] **Step 5:** Manual check: install vsix, right-click a model → task runs `dbt.exe run --select <model>` from project root.
