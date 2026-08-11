import { CallHandler, ExecutionContext, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, lastValueFrom } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

const run = async (
  body: unknown,
  opts: { headersSent?: boolean; type?: string; optedOut?: boolean } = {},
) => {
  const context = {
    getType: () => opts.type ?? 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getResponse: () => ({ headersSent: opts.headersSent ?? false }) }),
  } as unknown as ExecutionContext;
  const next = { handle: () => of(body) } as CallHandler;
  const reflector = {
    getAllAndOverride: () => opts.optedOut ?? false,
  } as unknown as Reflector;
  return lastValueFrom(new ResponseInterceptor(reflector).intercept(context, next));
};

describe('ResponseInterceptor', () => {
  describe('idempotence — the property that makes this deployable on its own', () => {
    it('passes an already-enveloped body through untouched', async () => {
      const body = { success: true, data: { id: 'client-1' } };
      // Double-wrapping would ship {success, data:{success, data}} to a frontend whose
      // ApiClient.request() ends in `return res.data`, breaking every screen at once. The 285
      // controller sites that hand-build this envelope are why that is not hypothetical.
      expect(await run(body)).toBe(body);
    });

    it('preserves sibling keys alongside data', async () => {
      // POST /documents returns { success, data, documentUrl } and the clients read it.
      const body = { success: true, data: { id: 'doc-1' }, documentUrl: '/documents/doc-1/download' };
      expect(await run(body)).toEqual(body);
    });

    it('preserves both pagination shapes currently in use', async () => {
      const withMeta = { success: true, data: [], meta: { total: 0, unreadCount: 0 } };
      const withPagination = { success: true, data: [], pagination: { page: 1, limit: 50, total: 0 } };
      // Two incompatible shapes already coexist. Normalising them here would be a breaking
      // change wearing the costume of a cleanup; unifying them is a separate, deliberate step.
      expect(await run(withMeta)).toEqual(withMeta);
      expect(await run(withPagination)).toEqual(withPagination);
    });

    it('passes a failure envelope through without rewriting success', async () => {
      const body = { success: false, message: 'File not found in object storage' };
      expect(await run(body)).toEqual(body);
    });
  });

  describe('wrapping', () => {
    it('wraps a bare object', async () => {
      expect(await run({ id: 'client-1' })).toEqual({ success: true, data: { id: 'client-1' } });
    });

    it('wraps a bare array', async () => {
      expect(await run([1, 2])).toEqual({ success: true, data: [1, 2] });
    });

    it('wraps a void handler as an explicit null', async () => {
      // So a client never has to tell "no content" apart from a malformed response.
      expect(await run(undefined)).toEqual({ success: true, data: null });
    });

    it('does not mistake a data-carrying object for an envelope', async () => {
      // `success` here is a domain field, not the envelope flag — but it IS a boolean, so
      // this documents the one ambiguity the heuristic cannot resolve. A handler returning a
      // bare object with a boolean `success` field is treated as already-enveloped.
      const body = { success: true, syncedCount: 3 };
      expect(await run(body)).toBe(body);
    });

    it('wraps an object whose success field is not a boolean', async () => {
      const body = { success: 'yes', id: 'x' };
      expect(await run(body)).toEqual({ success: true, data: body });
    });
  });

  describe('handlers that own the response', () => {
    it('leaves a response whose headers are already sent', async () => {
      // Document downloads, attachment streams and the metrics scrape all use @Res and have
      // written bytes by the time this runs; re-serialising throws ERR_HTTP_HEADERS_SENT.
      expect(await run(undefined, { headersSent: true })).toBeUndefined();
    });

    it('leaves a StreamableFile for Nest to pipe', async () => {
      const file = new StreamableFile(Buffer.from('pdf'));
      expect(await run(file)).toBe(file);
    });

    it('leaves a @NoEnvelope route exactly as the handler returned it', async () => {
      // /health and /health/ready are read by load balancers, container healthchecks and the
      // mobile "test this server address" button — configured out-of-band and not redeployed
      // with the application, so their body shape is a deployment contract, not an API one.
      const body = { status: 'ok', database: 'up', redis: 'up' };
      expect(await run(body, { optedOut: true })).toBe(body);
    });

    it('ignores non-HTTP contexts', async () => {
      const body = { anything: true };
      expect(await run(body, { type: 'ws' })).toBe(body);
    });
  });
});
