export type Scope = 'global' | 'workspace';

/** Settings that existed under the extension's old name (`dbtRunner.*`, before it became DataOps dbt Commander). */
export const MIGRATED_KEYS = [
  'venvPath',
  'target',
  'extraArgs',
  'previewLimit',
  'codeLens',
  'openDocsAfterGenerate',
  'notifyAfterSeconds',
  'newModelTemplate'
];

/** Old values to copy to the new keys: only where the old key is set and the new one isn't. */
export function plannedMigrations(
  keys: string[],
  readOld: (scope: Scope, key: string) => unknown,
  readNew: (scope: Scope, key: string) => unknown
): { scope: Scope; key: string; value: unknown }[] {
  const plan: { scope: Scope; key: string; value: unknown }[] = [];
  for (const scope of ['global', 'workspace'] as Scope[]) {
    for (const key of keys) {
      const value = readOld(scope, key);
      if (value !== undefined && readNew(scope, key) === undefined) {
        plan.push({ scope, key, value });
      }
    }
  }
  return plan;
}
