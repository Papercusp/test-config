/**
 * In-process boot helper for NestJS apps under test — shared via the
 * `@papercusp/test-config/nest` subpath (kept OUT of the main barrel so projects
 * without Nest, e.g. Papercusp, never load `@nestjs/*`).
 *
 * Wraps `Test.createTestingModule(...).compile()` → `createNestApplication()` →
 * `init()` and hands back a ready supertest client bound to the in-memory HTTP
 * server. No port is opened. Pair with `provisionRestartTestDb()` / `getTestRedis()`
 * for a hermetic integration test:
 *
 *   import { bootNestTestApp } from '@papercusp/test-config/nest';
 *   import { provisionRestartTestDb } from '@papercusp/test-config';
 *
 *   const db = await provisionRestartTestDb();
 *   process.env.DATABASE_URL = db.url;
 *   const { AppModule } = await import('../src/app.module');
 *   const nest = await bootNestTestApp({
 *     metadata: { imports: [AppModule] },
 *     configure: (b) => b.overrideProvider('MAPPING_SERVICE').useValue(fakeClientProxy),
 *   });
 *   await nest.request.get('/api/v1/health').expect(200);
 *   // afterAll: await nest.close(); await db.drop();
 */
import type { INestApplication, ModuleMetadata } from '@nestjs/common';
import { Test, type TestingModule, type TestingModuleBuilder } from '@nestjs/testing';
import supertest from 'supertest';

export interface NestTestApp {
  app: INestApplication;
  module: TestingModule;
  /** supertest agent bound to the in-process HTTP server (no port opened). */
  request: ReturnType<typeof supertest>;
  /** Close the Nest app (call in afterAll, before dropping the test DB). */
  close: () => Promise<void>;
}

export interface BootNestTestAppOptions {
  /** Nest module metadata, e.g. `{ imports: [AppModule] }`. */
  metadata: ModuleMetadata;
  /**
   * Override providers/guards/clients before compile, e.g.
   * `(b) => b.overrideProvider('MAPPING_SERVICE').useValue(fake)`.
   */
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /** Configure the app before `init()` — global pipes, middleware, prefixes. */
  setup?: (app: INestApplication) => void | Promise<void>;
}

export async function bootNestTestApp(opts: BootNestTestAppOptions): Promise<NestTestApp> {
  let builder = Test.createTestingModule(opts.metadata);
  if (opts.configure) builder = opts.configure(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  if (opts.setup) await opts.setup(app);
  await app.init();
  return {
    app,
    module: moduleRef,
    request: supertest(app.getHttpServer() as Parameters<typeof supertest>[0]),
    close: async () => { await app.close(); },
  };
}
