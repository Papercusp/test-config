import { setupServer, type SetupServerApi } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const msw: SetupServerApi = setupServer();

export function setupMsw(): void {
  beforeAll(() => msw.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => msw.resetHandlers());
  afterAll(() => msw.close());
}
