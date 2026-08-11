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
