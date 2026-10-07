/**
 * Integration-only live-Postgres rail (WI-10006585).
 *
 * Capture DSN identities before test files redirect HARNESS_*_DATABASE_URL to
 * their throwaway fixture. The unit setup forbids every real pool; integration
 * must allow its testcontainer, so this setup records the ambient/live targets
 * and the explicitly provisioned testcontainer endpoint separately. It runs
 * first in each integration worker, before hermetic-env and test modules.
 *
 * Only host, port, and database are retained. Usernames and passwords never
 * enter the guard metadata or an error message.
 */
type PgTarget = { host: string; port: string; database: string };
type PgEndpoint = { host: string; port: string };

function targetFromUrl(raw: string | undefined): PgTarget | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!database) return null;
    return { host: url.hostname.toLowerCase(), port: url.port || '5432', database };
  } catch {
    return null;
  }
}

function targetKey(target: PgTarget): string {
  return `${target.host}\u0000${target.port}\u0000${target.database}`;
}

if (process.env.PAPERCUSP_LIVE_PG_GUARD_INITIALIZED !== '1') {
  const candidates = [
    process.env.HARNESS_ADMIN_DATABASE_URL,
    process.env.HARNESS_DATABASE_URL,
    process.env.DATABASE_URL,
    process.env.PAPERCUSP_PG_URL,
    `postgresql://harness_admin:harness_admin_pwd@localhost:${Number(process.env.PAPERCUSP_PG_PORT) || 5432}/papercusp`,
  ];
  const targets = new Map<string, PgTarget>();
  for (const candidate of candidates) {
    const target = targetFromUrl(candidate);
    if (target) targets.set(targetKey(target), target);
  }

  const testContainerTarget = targetFromUrl(process.env.PAPERCUSP_TEST_PG_ADMIN_URL);
  const safeEndpoints: PgEndpoint[] = testContainerTarget
    ? [{ host: testContainerTarget.host, port: testContainerTarget.port }]
    : [];

  process.env.PAPERCUSP_FORBID_LIVE_PG_TARGETS = JSON.stringify([...targets.values()]);
  process.env.PAPERCUSP_SAFE_TEST_PG_ENDPOINTS = JSON.stringify(safeEndpoints);
  process.env.PAPERCUSP_LIVE_PG_GUARD_INITIALIZED = '1';
}

process.env.PAPERCUSP_FORBID_LIVE_PG = '1';
