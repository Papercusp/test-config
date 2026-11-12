import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('reads its tracked input in the remaining native file', async () => {
  expect(readFileSync(new URL('../armed-capture/input.txt', import.meta.url), 'utf8'))
    .toBe('armed-capture-input\n');
  if (process.env.PC_COMPLETION_DATABASE_RESET === '1') {
    const { createFreshTestDb } = await import('../../pg-migrate.ts');
    const { default: postgres } = await import('postgres');
    const db = await createFreshTestDb({ prefix: 'nativereset' });
    const sql = postgres(db.url, { max: 1 });
    try { expect(await sql`SELECT current_database() AS name`).toEqual([{ name: db.name }]); }
    finally { await sql.end(); expect(await db.dropWithResult()).toBe('dropped'); }
  }
});
