import { ArgumentsHost, BadRequestException, NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { GlobalExceptionFilter } from './global-exception.filter';

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
    expect(res.body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
      correlationId: 'cid-3',
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('secret_table');
    expect(serialized).not.toContain('uq_secret');
  });
});
