import { describe, expect, it } from 'vitest';
import { OWNED_DATABASE_SCHEMA_GAPS, OWNED_DATABASE_SCHEMA_V2_GAPS,
  ownedDatabaseSchemaFingerprint, parseOwnedDatabaseSchemaSnapshot,
  type OwnedDatabaseSchemaSnapshot } from './configuration-snapshot.ts';
import { parseRecordedWorkerDatabaseReset, captureRecordedProofContext } from './execution-details.ts';
import { beginDatabaseResetCapture, beginFile, endFile, snapshotCaptureForTests } from './executed-inputs-capture.ts';

function fixture(): OwnedDatabaseSchemaSnapshot {
  const body = { schemaVersion: 'owned-database-schema-v1' as const,
    scope: 'pg-dump-and-baseline-migration-ledger' as const, populationStatus: 'unknown' as const,
    schemaSha256: 'a'.repeat(64), appliedMigrationsSha256: 'b'.repeat(64), extensionsSha256: 'c'.repeat(64),
    dumpExecutableSha256: 'd'.repeat(64), serverVersionNum: '180001', missing: [...OWNED_DATABASE_SCHEMA_GAPS] };
  return { ...body, fingerprint: ownedDatabaseSchemaFingerprint(body) };
}

describe('owned database schema observation', () => {
  it('retains legacy validity while binding both new measurements without a completeness upgrade', () => {
    const legacy = fixture();
    expect(parseOwnedDatabaseSchemaSnapshot(legacy)).toEqual(legacy);
    const body = { ...legacy, schemaVersion: 'owned-database-schema-v2' as const,
      scope: 'pg-dump-extension-definitions-migrations-and-roles' as const,
      extensionDefinitionsSha256: 'e'.repeat(64), serverRoleStateSha256: 'f'.repeat(64),
      missing: [...OWNED_DATABASE_SCHEMA_V2_GAPS] };
    const current = { ...body, fingerprint: ownedDatabaseSchemaFingerprint(body) };
    expect(parseOwnedDatabaseSchemaSnapshot(current)).toEqual(current);
    for (const patch of [{ extensionDefinitionsSha256: 'a'.repeat(64) },
      { serverRoleStateSha256: 'a'.repeat(64) }, { serverRoleStateSha256: undefined },
      { schemaVersion: 'owned-database-schema-v1' }, { missing: [] }, { populationStatus: 'complete' }])
      expect(parseOwnedDatabaseSchemaSnapshot({ ...current, ...patch })).toBeUndefined();
    expect(parseOwnedDatabaseSchemaSnapshot({ ...legacy, serverRoleStateSha256: 'f'.repeat(64) })).toBeUndefined();
  });

  it('recomputes the persisted binding and refuses completeness upgrades or omitted gaps', () => {
    const original = fixture();
    expect(parseOwnedDatabaseSchemaSnapshot(original)).toEqual(original);
    for (const patch of [{ schemaSha256: 'e'.repeat(64) }, { appliedMigrationsSha256: 'e'.repeat(64) },
      { extensionsSha256: 'e'.repeat(64) }, { dumpExecutableSha256: 'e'.repeat(64) },
      { serverVersionNum: '170001' }, { populationStatus: 'complete' }, { missing: [] }, { complete: true }])
      expect(parseOwnedDatabaseSchemaSnapshot({ ...original, ...patch })).toBeUndefined();
  });

  it('transports the original allocation observations without late cross-file adoption or schema completeness', () => {
    const restore = snapshotCaptureForTests();
    try {
      beginFile({ captureId: '12345678-9abc-def0-1234-56789abcdef0', runGroupId: 'schema-test' });
      const capture = beginDatabaseResetCapture('it_0123456789ab', 'empty');
      capture.schema('before', fixture()); capture.ready(); capture.schema('after', fixture()); capture.cleanup('dropped');
      const prior = endFile('/repo/schema.test.ts')!.workerDatabaseReset!;
      expect(parseRecordedWorkerDatabaseReset(prior)).toEqual(prior);
      expect(prior.databases[0]?.schemaInputs?.before).toEqual(fixture());
      expect(captureRecordedProofContext({ commitSha: 'a'.repeat(40), worktreeDirty: false,
        workerDatabaseReset: prior } as never).components.schema).toBeNull();
      beginFile({ captureId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', runGroupId: 'next-file' });
      capture.schema('after', null);
      expect(prior.databases[0]?.schemaInputs?.after).toEqual(fixture());
      expect(endFile('/repo/next.test.ts')?.workerDatabaseReset?.databases).toEqual([]);
      const corrupt = structuredClone(prior);
      corrupt.databases[0]!.schemaInputs!.after!.fingerprint = 'e'.repeat(64);
      expect(parseRecordedWorkerDatabaseReset(corrupt)).toBeUndefined();
    } finally { restore(); }
  });
});
