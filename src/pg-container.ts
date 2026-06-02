import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let containerPromise: Promise<StartedPostgreSqlContainer> | null = null;

export async function getTestPg(): Promise<string> {
  if (!containerPromise) {
    containerPromise = new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('papercusp_test')
      .withReuse()
      .start();
  }
  const container = await containerPromise;
  return container.getConnectionUri();
}

export async function teardownTestPg(): Promise<void> {
  if (containerPromise) {
    const c = await containerPromise;
    await c.stop();
    containerPromise = null;
  }
}

export interface TestSchemaHandle {
  schema: string;
  connectionUri: string;
}

export async function withTestSchema(): Promise<TestSchemaHandle> {
  const connectionUri = await getTestPg();
  const schema = `t_${randomBytes(6).toString('hex')}`;
  return { schema, connectionUri };
}
