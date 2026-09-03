import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { GlobalExceptionFilter } from './global-exception.filter';
import { withCode } from './api-error';

/**
 * The filter is a security boundary as much as an ergonomics one: the redaction test below
 * is the guarantee that a database error can never carry SQL or a constraint name to a client.
 */
describe('GlobalExceptionFilter', () => {
  const filter = new GlobalExceptionFilter();

  function hostFor(req: any): { host: ArgumentsHost; res: any } {
    const res: any = {
      statusCode: 0,
      body: undefined,
      // A live socket by default; the disconnect tests below flip these.
      writable: true,
      destroyed: false,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { this.body = payload; return this; },
      getHeader: () => undefined,
    };
    const host = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ArgumentsHost;
    return { host, res };
  }

  /**
   * A reader hanging up is not a fault on this side.
   *
   * A browser that navigates away, a phone that loses signal mid-upload, someone who gives up
   * on a slow attachment — each aborts the request, and Express surfaces that as a thrown
   * `Request aborted`. Reporting it as a 500 logged a server fault for something the server did
   * nothing wrong in, raised an alert, and tried to write a body to a socket that had gone. A
   * real upload abort in production is what put this here.
   */
  describe('a client that goes away', () => {
    // Its own filter with a stub alerter: the point of these is partly that nothing is paged.
    const alerter = { report: jest.fn() };
    const quietFilter = new GlobalExceptionFilter(alerter as any);
    beforeEach(() => alerter.report.mockClear());

    it('does not report an aborted request as a server error', () => {
      const { host, res } = hostFor({ method: 'POST', originalUrl: '/api/v1/feedback/attachments' });
      res.writable = false;
      res.destroyed = true;

      quietFilter.catch(new Error('Request aborted'), host);

      // Nothing written, nothing alerted — there is no client left to answer.
      expect(res.statusCode).toBe(0);
      expect(res.body).toBeUndefined();
      expect(alerter.report).not.toHaveBeenCalled();
    });

    it.each(['ECONNRESET', 'EPIPE', 'ECONNABORTED'])('treats %s as a disconnect', (code) => {
      const { host, res } = hostFor({ method: 'GET', originalUrl: '/api/v1/feedback/attachments/k' });
      const err: NodeJS.ErrnoException = new Error('socket hang up');
      err.code = code;

      quietFilter.catch(err, host);

      expect(res.statusCode).toBe(0);
      expect(alerter.report).not.toHaveBeenCalled();
    });

    it('still reports a genuine error that merely mentions aborting', () => {
      // The socket is alive, so this is the server failing — not the client leaving.
      const { host, res } = hostFor({ method: 'POST', originalUrl: '/x' });

      quietFilter.catch(new Error('Request aborted'), host);

      expect(res.statusCode).toBe(500);
      expect(alerter.report).toHaveBeenCalled();
    });
  });

  it('preserves an HttpException status and body, adding the correlation id', () => {
    const { host, res } = hostFor({ method: 'GET', originalUrl: '/x', correlationId: 'cid-1' });

    filter.catch(new BadRequestException(['name must be a string']), host);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      message: ['name must be a string'],
      correlationId: 'cid-1',
    });
  });

  it('keeps a NotFoundException message intact', () => {
    const { host, res } = hostFor({ method: 'GET', originalUrl: '/y', correlationId: 'cid-2' });

    filter.catch(new NotFoundException('Assignment not found'), host);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ message: 'Assignment not found', correlationId: 'cid-2' });
  });

  it('redacts a non-HttpException to a generic 500 that leaks no internals', () => {
    const { host, res } = hostFor({ method: 'POST', originalUrl: '/z', correlationId: 'cid-3' });
    const dbError = new QueryFailedError(
      'INSERT INTO secret_table ...',
      [],
      new Error('duplicate key value violates unique constraint "uq_secret"'),
    );

    filter.catch(dbError, host);

    expect(res.statusCode).toBe(500);
    // Exhaustive on purpose: this is the redaction contract, so the assertion has to fail if a
    // key is ever ADDED as well as if one changes. `code` is part of it now — a generic 500 names
    // itself like every other error, and INTERNAL_ERROR is the one code that must reveal nothing.
    expect(res.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
      correlationId: 'cid-3',
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('secret_table');
    expect(serialized).not.toContain('uq_secret');
  });

  /**
   * Every error body names itself.
   *
   * The mobile app is translated and the API is not, so the phone's only way to know WHAT went
   * wrong was to match the English sentence — thirty-five of them, in `i18n/server-errors.ts`,
   * each of which silently stops translating the day somebody rewords the message it matches.
   * The guarantee that makes that unnecessary is not "most errors carry a code"; it is that
   * every error does, so a client never has to keep the sentence matcher around as a fallback
   * for the ones that do not. That is why the coarse status-derived codes below exist at all.
   */
  describe('the code guarantee', () => {
    it('keeps the code a route named, and leaves its message untouched', () => {
      const { host, res } = hostFor({ method: 'POST', originalUrl: '/login', correlationId: 'c' });

      filter.catch(
        withCode(new UnauthorizedException('Invalid credentials'), 'INVALID_CREDENTIALS'),
        host,
      );

      expect(res.statusCode).toBe(401);
      expect(res.body).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid credentials',
        error: 'Unauthorized',
      });
    });

    /**
     * The 41st throw site. Precise codes are chosen by hand and one will always be missed, so
     * the boundary derives a coarse one from the status rather than letting `code` go absent —
     * a client that has to handle `undefined` is back to reading prose for every error.
     */
    it.each([
      [new BadRequestException('nope'), 400, 'BAD_REQUEST'],
      [new UnauthorizedException('nope'), 401, 'UNAUTHENTICATED'],
      [new ForbiddenException('nope'), 403, 'FORBIDDEN'],
      [new NotFoundException('nope'), 404, 'NOT_FOUND'],
      [new ConflictException('nope'), 409, 'CONFLICT'],
    ])('falls back to a status-derived code when a route named none', (exception, status, code) => {
      const { host, res } = hostFor({ method: 'GET', originalUrl: '/u', correlationId: 'c' });

      filter.catch(exception as HttpException, host);

      expect(res.statusCode).toBe(status);
      expect(res.body).toMatchObject({ code, message: 'nope' });
    });

    /**
     * A code invented outside the shared vocabulary is not a contract — the client has no case
     * for it and cannot have been written against it. Treating it as coarse is the honest
     * reading, and it keeps `ApiErrorCode` on the wire actually meaning what its type says.
     */
    it('ignores a code that is not in the shared vocabulary', () => {
      const { host, res } = hostFor({ method: 'GET', originalUrl: '/u', correlationId: 'c' });
      const rogue = new ForbiddenException('nope');
      Object.assign(rogue.getResponse() as object, { code: 'SOMETHING_INVENTED' });

      filter.catch(rogue, host);

      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    });

    /**
     * The class-validator array is the case the sentence matcher could never touch: there is no
     * single sentence, and its contents change with the DTO. The array itself must survive
     * untouched — the web app renders it — so this asserts both halves at once.
     */
    it('carries a code and per-field detail alongside the untouched message array', () => {
      const { host, res } = hostFor({ method: 'POST', originalUrl: '/a', correlationId: 'c' });
      const messages = ['password should not be empty', 'password must be a string'];
      const exception = withCode(new BadRequestException(messages), 'VALIDATION_FAILED');
      Object.assign(exception.getResponse() as object, {
        fields: [{ field: 'password', code: 'REQUIRED', message: messages[0] }],
      });

      filter.catch(exception, host);

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toEqual(messages);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.fields).toEqual([
        { field: 'password', code: 'REQUIRED', message: 'password should not be empty' },
      ]);
    });
  });
});
