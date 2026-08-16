/**
 * In-process test client for any Hono app (or anything with a Fetch-style
 * `request(input, init)` method). No real HTTP server, no port — calls handlers
 * directly via `app.request()`. Shared by Restart (apps/web Hono routers) and
 * Papercusp (operator endpoint-route apps).
 *
 * Deliberately structural (no `hono` import) so the shared lib stays dependency-free:
 * any object exposing `request(input, init): Promise<Response>` works.
 *
 *   import { honoTestClient } from '@papercusp/test-config';
 *   import { schemas } from '@/app/api/_hono/schemas';
 *   const api = honoTestClient(schemas);
 *   const { status, body } = await api.get('/browse/amazon');
 */

/** Anything with a Fetch-style request method — a Hono instance satisfies this. */
export interface RequestableApp {
  request(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface HonoTestResponse<T = unknown> {
  status: number;
  headers: Headers;
  /** Parsed JSON when the response is `application/json`, otherwise the raw text. */
  body: T;
  /** The original Response. Its body stream is already consumed — read `body`/`text`. */
  raw: Response;
  text: string;
}

export interface HonoTestClient {
  /** Raw in-process request. `path` may be a path (`/x`) or a full URL. */
  request(path: string, init?: RequestInit): Promise<Response>;
  get<T = unknown>(path: string, init?: RequestInit): Promise<HonoTestResponse<T>>;
  post<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<HonoTestResponse<T>>;
  put<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<HonoTestResponse<T>>;
  patch<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<HonoTestResponse<T>>;
  delete<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<HonoTestResponse<T>>;
}

export interface HonoTestClientOptions {
  /** Origin used to build absolute URLs for relative paths. Default `http://test.local`. */
  baseUrl?: string;
}

export function honoTestClient(app: RequestableApp, opts: HonoTestClientOptions = {}): HonoTestClient {
  const base = (opts.baseUrl ?? 'http://test.local').replace(/\/$/, '');
  const toUrl = (p: string) => (/^https?:\/\//.test(p) ? p : `${base}${p.startsWith('/') ? p : `/${p}`}`);
  const request = (path: string, init?: RequestInit) => app.request(toUrl(path), init);

  async function send<T>(method: string, path: string, body: unknown, init?: RequestInit): Promise<HonoTestResponse<T>> {
    const headers = new Headers(init?.headers);
    let payload = init?.body;
    if (body !== undefined) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const raw = await request(path, { ...init, method, headers, body: payload });
    const text = await raw.text();
    let parsed: unknown = text;
    if ((raw.headers.get('content-type') ?? '').includes('application/json') && text) {
      try { parsed = JSON.parse(text); } catch { /* leave as text */ }
    }
    return { status: raw.status, headers: raw.headers, body: parsed as T, raw, text };
  }

  return {
    request,
    get: (p, init) => send('GET', p, undefined, init),
    post: (p, body, init) => send('POST', p, body, init),
    put: (p, body, init) => send('PUT', p, body, init),
    patch: (p, body, init) => send('PATCH', p, body, init),
    delete: (p, body, init) => send('DELETE', p, body, init),
  };
}
