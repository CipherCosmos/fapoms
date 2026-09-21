import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { UserController } from './user.controller';

/**
 * `POST /users/bulk/status` walks its id list one row at a time — a lookup, an update and an audit
 * write per id — inside a single request. Its DTO had no ceiling on that list and did not check
 * the ids were ids, so the request's size was whatever the caller chose, and a malformed id became
 * a database error per row instead of a 400 before any work. Run against the real class bound to
 * the route, through the same whitelisting pipe main.ts installs.
 */
describe('BulkSetStatusDto, as bound to POST /users/bulk/status', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const BulkDto = Reflect.getMetadata('design:paramtypes', UserController.prototype, 'bulkSetStatus')?.[0];
  const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
  const run = (body: unknown) => pipe.transform(body, { type: 'body', metatype: BulkDto });

  it('is the class the route actually validates', () => {
    expect(BulkDto?.name).toBe('BulkSetStatusDto');
  });

  it('accepts a batch of exactly 500', async () => {
    await expect(run({ ids: ids(500), status: 'SUSPENDED' })).resolves.toMatchObject({ status: 'SUSPENDED' });
  });

  /** The ceiling, with a message a person can act on rather than a bare constraint name. */
  it('refuses 501 ids with a message that says the limit', async () => {
    const err = await run({ ids: ids(501), status: 'SUSPENDED' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify(err.getResponse())).toContain('at most 500 users at a time');
  });

  it('refuses an id that is not a UUID before any row is touched', async () => {
    await expect(run({ ids: [randomUUID(), 'not-a-uuid'], status: 'ACTIVE' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
