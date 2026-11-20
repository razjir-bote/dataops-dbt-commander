/** A macro's documentation (from the manifest's `macros` entries and YAML `macros:` properties). */
export interface MacroDoc {
  name: string;
  package: string;
  description?: string;
  arguments?: { name: string; type?: string; description?: string }[];
}

/** `name(args)` from `{% macro name(args) %}` in a macro file, whitespace collapsed. */
export function macroSignature(text: string, name: string): string | undefined {
  const re = new RegExp(`\\{%-?\\s*macro\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
  const m = re.exec(text);
  if (!m) {
    return undefined;
  }
  let depth = 1;
  let quote = '';
  const start = m.index + m[0].length;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        quote = '';
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return `${name}(${text.slice(start, i).replace(/\s+/g, ' ').trim()})`;
    }
  }
  return undefined;
}

/** Hover markdown for a macro: signature, description, documented arguments, package and file. */
export function macroHover(doc: MacroDoc, signature: string | undefined, relFile: string | undefined): string {
  const parts = [`\`\`\`sql\n${signature ?? `${doc.name}(…)`}\n\`\`\``];
  if (doc.description?.trim()) {
    parts.push(doc.description.trim());
  }
  const args = (doc.arguments ?? []).filter(a => a.name);
  if (args.length) {
    parts.push(args.map(a => `- \`${a.name}\`${a.type ? ` (${a.type})` : ''}${a.description ? `: ${a.description}` : ''}`).join('\n'));
  }
  parts.push(`*${[doc.package, relFile].filter(Boolean).join(' · ')}*`);
  return parts.join('\n\n');
}
