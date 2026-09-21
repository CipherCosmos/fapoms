import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ValidationController } from './validation.controller';

/**
 * `POST /validation/bulk/transition` runs the full per-case transition — state machine, workflow
 * command, audit — for each id in turn inside one request (`ValidationService.bulkTransition`).
 * Its DTO had no ceiling on the id list, so one request could be made arbitrarily long. Run against
 * the real class bound to the route, through the same whitelisting pipe main.ts installs.
 */
describe('BulkTransitionValidationCaseDto, as bound to POST /validation/bulk/transition', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const BulkDto = Reflect.getMetadata('design:paramtypes', ValidationController.prototype, 'bulkTransition')?.[0];
  const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
  const run = (body: unknown) => pipe.transform(body, { type: 'body', metatype: BulkDto });

  it('is the class the route actually validates', () => {
    expect(BulkDto?.name).toBe('BulkTransitionValidationCaseDto');
  });

  it('accepts a batch of exactly 500', async () => {
    await expect(run({ ids: ids(500), targetStatus: 'APPROVED' })).resolves.toMatchObject({ targetStatus: 'APPROVED' });
  });

  /** The ceiling, with a message a person can act on rather than a bare constraint name. */
  it('refuses 501 ids with a message that says the limit', async () => {
    const err = await run({ ids: ids(501), targetStatus: 'APPROVED' }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify(err.getResponse())).toContain('at most 500 validation cases at a time');
  });

  it('still refuses an id that is not a UUID', async () => {
    await expect(run({ ids: ['not-a-uuid'], targetStatus: 'APPROVED' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
