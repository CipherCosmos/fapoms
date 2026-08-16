/**
 * This package's jest runs on `testEnvironment: node`, which has no localStorage. A minimal
 * in-memory stand-in is installed here rather than switching the whole suite to jsdom.
 */
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

// `api` reaches `socket` through `session`, and that module uses `import.meta`, which this
// package's jest transform cannot parse. Mocked for the same reason the session spec mocks it.
jest.mock('./socket', () => ({ disconnectSocket: jest.fn(), connectSocket: jest.fn() }));

import { api } from './api';

/**
 * A successful response need not carry a body.
 *
 * `DELETE` handlers answer `204 No Content`. The client called `.json()` on every non-blob
 * response, so an empty body threw `Unexpected end of JSON input` — *after* the server had
 * already carried out the delete. The caller treated that as a failed request, skipped its own
 * refresh, and showed the raw parser message, so the record stayed on screen beside a JavaScript
 * error and the obvious next move was to delete it again.
 */
describe('api.request — responses with no body', () => {
  const withResponse = (init: { status: number; headers?: Record<string, string>; body?: string }) => {
    (globalThis as any).fetch = jest.fn().mockResolvedValue(
      new Response(init.body ?? null, { status: init.status, headers: init.headers }),
    );
  };

  afterEach(() => {
    jest.restoreAllMocks();
    store.clear();
  });

  it('resolves for 204 No Content instead of throwing a JSON parse error', async () => {
    withResponse({ status: 204 });

    await expect(api.request('/assayers/as-1', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('resolves for a 200 that declares an empty body', async () => {
    withResponse({ status: 200, headers: { 'content-length': '0' } });

    await expect(api.request('/anything', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('still unwraps an ordinary JSON envelope', async () => {
    withResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ success: true, data: { id: 'z-1' } }),
    });

    await expect(api.request<{ id: string }>('/zones/z-1')).resolves.toEqual({ id: 'z-1' });
  });
});
