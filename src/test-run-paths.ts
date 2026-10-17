/**
 * Shared path rules for the harness_shared.test_runs ledger.
 *
 * New rows are repo-relative. Older rows can still carry a checkout prefix,
 * so readers must remove that prefix without assuming this box's
 * `papercupai-workspace` dirname. The workspace root is injectable for tests
 * and defaults to PAPERCUSP_WORKSPACE_ROOT when callers omit it.
 */

export const RESTORED_CHECKOUT_DIRS = [
  'papercup-checkpoint',
  'papercusp-checkpoint',
  'papercup-staging',
] as const;

/** PostgreSQL regex fragment matching a preserved checkout basename anywhere in a path. */
export const RESTORED_CHECKOUT_PATH_PATTERN =
  `(?:^|/)(?:${RESTORED_CHECKOUT_DIRS.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/`;

const normalizeSeparators = (value: string): string => value.replaceAll('\\', '/');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rootBasename(workspaceRoot: string | null | undefined): string | null {
  if (!workspaceRoot) return null;
  const normalized = normalizeSeparators(workspaceRoot).replace(/\/+$/, '');
  if (!normalized) return null;
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return name || null;
}

function workspaceRootNames(workspaceRoot: string | null | undefined): string[] {
  return [...new Set([
    'papercupai-workspace',
    rootBasename(workspaceRoot ?? process.env.PAPERCUSP_WORKSPACE_ROOT),
  ].filter((name): name is string => Boolean(name)))];
}

/** SQL/JavaScript-compatible prefix pattern, anchored at the start of a path. */
export function storedTestRunPathPattern(workspaceRoot?: string | null): string {
  const roots = workspaceRootNames(workspaceRoot);
  const rootPrefix = roots.length === 0
    ? '(?!)'
    : `(?:.*\\/)?(?:${roots.map(escapeRegExp).join('|')})\\/[^/]+\\/`;
  const restoredPrefix = `(?:.*\\/)?(?:${RESTORED_CHECKOUT_DIRS.map(escapeRegExp).join('|')})\\/`;
  return `^(?:${rootPrefix}|${restoredPrefix})`;
}

/** Remove a legacy checkout prefix while leaving repo-relative paths unchanged. */
export function normalizeStoredTestRunPath(
  filePath: string,
  workspaceRoot?: string | null,
): string {
  const normalized = normalizeSeparators(filePath);
  const match = normalized.match(new RegExp(storedTestRunPathPattern(workspaceRoot)));
  return match ? normalized.slice(match[0].length) : normalized;
}

/** Whether a path belongs to one of the preserved checkpoint/staging trees. */
export function isRestoredCheckoutPath(filePath: string): boolean {
  const normalized = normalizeSeparators(filePath);
  return new RegExp(RESTORED_CHECKOUT_PATH_PATTERN).test(normalized);
}
