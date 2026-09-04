import {
  getRequestContext,
  runWithRequestContext,
  updateRequestContext,
  type RequestContext,
} from './request-context';

/**
 * The ambient request context is what lets every audit row name who acted, from where, on which
 * session, without the call site passing any of it. Two properties must hold or that guarantee is
 * unsafe: the store must survive `await` boundaries within a request, and it must be invisible to
 * any other concurrent request. Both are asserted here.
 */
describe('request-context', () => {
  it('exposes the context to code running inside the scope', () => {
    const ctx: RequestContext = { userId: 'u1', ipAddress: '1.2.3.4' };
    const seen = runWithRequestContext(ctx, () => getRequestContext());
    expect(seen).toEqual(ctx);
  });

  it('has no context outside any request (a worker, a cron sweep, boot)', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('survives await boundaries — the whole async chain of a request sees it', async () => {
    const result = await runWithRequestContext({ userId: 'u1' }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      return getRequestContext()?.userId;
    });
    expect(result).toBe('u1');
  });

  it('lets the interceptor add the actor to the store the middleware opened', () => {
    const captured = runWithRequestContext({ ipAddress: '1.2.3.4' }, () => {
      // Middleware seeded transport facts; interceptor later fills in the resolved principal.
      updateRequestContext({ userId: 'u1', role: 'ADMIN', sessionId: 's1' });
      return getRequestContext();
    });
    expect(captured).toEqual({ ipAddress: '1.2.3.4', userId: 'u1', role: 'ADMIN', sessionId: 's1' });
  });

  it('updateRequestContext is a safe no-op outside a request', () => {
    expect(() => updateRequestContext({ userId: 'u1' })).not.toThrow();
    expect(getRequestContext()).toBeUndefined();
  });

  it('isolates concurrent requests — one request never sees another’s actor', async () => {
    const run = (id: string, delay: number) =>
      runWithRequestContext({ userId: id }, async () => {
        await new Promise((r) => setTimeout(r, delay));
        return getRequestContext()?.userId;
      });
    // Interleaved on purpose: if the store leaked across async contexts, the slower one would
    // read the faster one's actor.
    const [a, b] = await Promise.all([run('user-a', 10), run('user-b', 1)]);
    expect(a).toBe('user-a');
    expect(b).toBe('user-b');
  });
});
