export interface Proc {
  pid: number;
  ppid: number;
  /** Creation time (any monotonic unit, e.g. Windows file time). */
  created: number;
}

/**
 * All descendants of `rootPid`. Windows reuses process ids, so a process whose recorded parent id now belongs to
 * a *newer* process is not that process's child: a child must have been created no earlier than its parent.
 */
export function descendants(procs: Proc[], rootPid: number): number[] {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const root = byPid.get(rootPid);
  if (!root) {
    return [];
  }
  const children = new Map<number, Proc[]>();
  for (const p of procs) {
    if (p.pid !== p.ppid) {
      children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
    }
  }
  const out: number[] = [];
  const queue: Proc[] = [root];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const c of children.get(parent.pid) ?? []) {
      if (!seen.has(c.pid) && c.created >= parent.created) {
        seen.add(c.pid);
        out.push(c.pid);
        queue.push(c);
      }
    }
  }
  return out;
}

/** Processes from PowerShell `... | Select ProcessId,ParentProcessId,Created | ConvertTo-Json`. */
export function parseProcessList(json: string): Proc[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  return rows
    .filter((r: any) => typeof r?.ProcessId === 'number')
    .map((r: any) => ({ pid: r.ProcessId, ppid: Number(r.ParentProcessId ?? 0), created: Number(r.Created ?? 0) }));
}

/** PowerShell that prints every process with its parent and creation time (Windows file time) as JSON. */
export const PROCESS_LIST_PS =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,' +
  '@{n="Created";e={ if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 } }} | ConvertTo-Json -Compress';
