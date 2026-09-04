import { setupServer, type SetupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

// `setupServer()` returns the `SetupServer` INTERFACE, not the `SetupServerApi`
// CLASS that implements it (the class carries private fields + a `network` member
// the interface doesn't expose) — typing this as `SetupServerApi` fails structurally
// even though the runtime value is exactly what setupServer() produces.
export const msw: SetupServer = setupServer();

export function setupMsw(): void {
  beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => msw.resetHandlers());
  afterAll(() => msw.close());
}
