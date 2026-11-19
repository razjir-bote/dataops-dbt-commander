export interface DbtProblem {
  relPath: string;
  /** 0-based line number. */
  line: number;
  message: string;
  severity: 'error' | 'warning';
  /** dbt node name (model / test / seed name) the problem belongs to. */
  node: string;
}

/** Names of the nodes dbt executed, from target/run_results.json. */
export function executedNodeNames(runResultsJson: string): string[] {
  try {
    const results = JSON.parse(runResultsJson)?.results;
    return Array.isArray(results)
      ? results.map((r: any) => String(r?.unique_id ?? '').split('.')[2]).filter((n: string | undefined): n is string => !!n)
      : [];
  } catch {
    return [];
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const TIMESTAMP = /^\d{2}:\d{2}:\d{2}\s{2}/;
// e.g. "Runtime Error in model bad (models\bad.sql)", "Failure in test x (models/s.yml)"
const HEADER = /^(?:(\w+) Error|(Failure|Warning)) in (\w+) (\S+) \(([^)]+)\)\s*$/;
// dbt 1.12 summary form: "[ERROR]: in test x (models\s.yml)", "[WARNING]: in test x (...)"
const TAGGED = /^\[(ERROR|WARNING|WARN)\]:\s*in (\w+) (\S+) \(([^)]+)\)\s*$/;
const TAG_PREFIX = /^\[(?:ERROR|WARNING|WARN)\]:\s*/;

/** Strip ANSI colour codes and dbt's leading `HH:MM:SS  ` timestamp. */
export function cleanLine(raw: string): string {
  return raw.replace(ANSI, '').replace(/\r$/, '').replace(TIMESTAMP, '');
}

/** Turn dbt-core 1.x console output into problems on project-relative files. */
export function parseDbtErrors(output: string): DbtProblem[] {
  const lines = output.split(/\n/).map(cleanLine);
  const problems: DbtProblem[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    let label: string;
    let relPath: string;
    let warning: boolean;
    let node: string;

    const m = HEADER.exec(text);
    const t = m ? null : TAGGED.exec(text);
    if (m) {
      const [, errorKind, outcome, nodeType, nodeName, p] = m;
      label = errorKind ? `${errorKind} Error` : `${outcome} in ${nodeType} ${nodeName}`;
      relPath = p;
      node = nodeName;
      warning = outcome === 'Warning';
    } else if (t) {
      // "[ERROR]: in model x" just wraps a nested "Runtime Error in model x" header: let that one report.
      const next = lines.slice(i + 1).find(l => l.trim());
      if (next && HEADER.test(next.trim())) {
        continue;
      }
      const [, tag, nodeType, nodeName, p] = t;
      warning = tag !== 'ERROR';
      label = `${warning ? 'Warning' : nodeType === 'test' ? 'Failure' : 'Error'} in ${nodeType} ${nodeName}`;
      relPath = p;
      node = nodeName;
    } else {
      continue;
    }

    const detail: string[] = [];
    let line = 0;
    for (let j = i + 1; j < lines.length; j++) {
      let l = lines[j];
      if (TAG_PREFIX.test(l) && !TAGGED.test(l.trim())) {
        l = '  ' + l.replace(TAG_PREFIX, ''); // "[WARNING]: Got 1 result..." detail line
      }
      if (!l.trim() || !/^\s/.test(l)) {
        break;
      }
      const lineNo = /^\s*line (\d+)\s*$/.exec(l);
      if (lineNo) {
        line = Math.max(0, parseInt(lineNo[1], 10) - 1);
        break;
      }
      if (/^\s*compiled code at /.test(l)) {
        break;
      }
      detail.push(l.trim());
    }

    const message = detail.length ? `${label}: ${detail.join('\n')}` : label;
    const key = `${relPath}|${message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    problems.push({ relPath, line, message, severity: warning ? 'warning' : 'error', node });
  }
  return problems;
}
