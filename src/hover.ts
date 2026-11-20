import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { callAt } from './jinja';
import { ColumnInfo, resolveRef } from './manifest';
import { LanguageDeps, loadManifest } from './language';
import { modelHover, parseCatalog, sourceHover } from './runresults';

const catalogs = new Map<string, { mtime: number; cols: Map<string, ColumnInfo[]> }>();

/** `target/catalog.json` (written by `dbt docs generate`), if present; cached by mtime. */
export async function loadCatalog(deps: LanguageDeps, root: string): Promise<Map<string, ColumnInfo[]> | undefined> {
  const file = path.join(deps.targetDirOf(root), 'catalog.json');
  try {
    const mtime = (await fs.promises.stat(file)).mtimeMs;
    const hit = catalogs.get(file);
    if (hit && hit.mtime === mtime) {
      return hit.cols;
    }
    const cols = parseCatalog(await fs.promises.readFile(file, 'utf8'));
    catalogs.set(file, { mtime, cols });
    return cols;
  } catch {
    return undefined;
  }
}

/** Hover on ref('model') / source('src', 'table'): description, materialization, path and columns. */
export class DbtHoverProvider implements vscode.HoverProvider {
  constructor(private readonly deps: LanguageDeps) {}

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const call = callAt(doc.lineAt(pos.line).text, pos.character);
    const root = call && this.deps.projectRootOf(doc.uri.fsPath);
    const index = root ? await loadManifest(this.deps, root) : undefined;
    if (!call || !root || !index) {
      return undefined;
    }
    const catalog = await loadCatalog(this.deps, root);
    let text: string | undefined;
    let file: string | undefined;
    if (call.kind === 'ref') {
      const model = resolveRef(index.models, call.name, call.package, call.version);
      if (model) {
        text = modelHover(model, catalog?.get(model.uniqueId), root);
        file = model.file;
      }
    } else {
      const src = index.sources.find(s => s.source === call.source && s.table === call.table);
      if (src) {
        text = sourceHover(src, catalog?.get(src.uniqueId), root);
        file = src.file;
      }
    }
    if (!text) {
      return undefined;
    }
    // Descriptions come from the project: render as plain, untrusted markdown (no command links, no HTML).
    const md = new vscode.MarkdownString(text);
    md.isTrusted = false;
    md.supportHtml = false;
    if (file) {
      md.appendMarkdown(`\n\n[Open file](${vscode.Uri.file(file).toString()})`);
    }
    return new vscode.Hover(md);
  }
}
