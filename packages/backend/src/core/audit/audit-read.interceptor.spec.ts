import { lastValueFrom, of, throwError } from 'rxjs';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EventCategory } from '@fapoms/shared';
import { AuditReadInterceptor } from './audit-read.interceptor';
import { AUDIT_READ_KEY } from './audit-read.decorator';
import { NOT_A_RECORD_ENTITY_ID } from './audit-event';
import type { AuditService } from './audit.service';

/**
 * The access log is the answer to "who viewed this person's data". These pin the three things that
 * make it trustworthy: it fires on a marked read, it records the record's identity but NEVER the
 * value, and a refused read is logged as DENIED rather than vanishing.
 */
describe('AuditReadInterceptor', () => {
  let recorded: any[];
  let audit: AuditService;
  let reflector: Reflector;

  const ctx = (handlerMeta: any, req: any) =>
    ({
      getType: () => 'http',
      getHandler: () => 'h',
      getClass: () => 'C',
      switchToHttp: () => ({ getRequest: () => req }),
      _meta: handlerMeta,
    }) as any;

  beforeEach(() => {
    recorded = [];
    audit = { recordEventSafe: jest.fn(async (dto: any) => void recorded.push(dto)) } as any;
    reflector = {
      getAllAndOverride: (key: string, _targets: any[]) =>
        key === AUDIT_READ_KEY ? currentMeta : undefined,
    } as any;
  });

  let currentMeta: any;
  const interceptor = () => new AuditReadInterceptor(reflector, audit);

  it('does nothing when the handler is not marked @AuditRead', async () => {
    currentMeta = undefined;
    const out = await lastValueFrom(
      interceptor().intercept(ctx(undefined, { params: {} }), { handle: () => of({ secret: 'x' }) }),
    );
    expect(out).toEqual({ secret: 'x' });
    expect(recorded).toHaveLength(0);
  });

  it('records a DATA_ACCESS success with the record id, and no returned data', async () => {
    currentMeta = { resource: 'ASSAYER_RECORD', idParam: 'id' };
    const req = { params: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, query: { include: 'pii' }, route: { path: '/assayers/:id' } };
    await lastValueFrom(
      interceptor().intercept(ctx(currentMeta, req), {
        handle: () => of({ panNumber: 'ABCDE1234F', bankAccountNumber: '000123' }),
      }),
    );
    expect(recorded).toHaveLength(1);
    const ev = recorded[0];
    expect(ev).toMatchObject({
      category: EventCategory.DATA_ACCESS,
      eventType: 'ASSAYER_RECORD_VIEWED',
      entityType: 'ASSAYER_RECORD',
      entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      outcome: 'SUCCESS',
    });
    // The value read must never appear anywhere in the access-log row.
    expect(JSON.stringify(ev)).not.toContain('ABCDE1234F');
    expect(JSON.stringify(ev)).not.toContain('000123');
    // Only query KEYS are kept, never their values (a value could be a name being searched).
    expect(ev.metadata.queryKeys).toEqual(['include']);
    expect(JSON.stringify(ev.metadata)).not.toContain('pii');
  });

  it('uses the not-a-record sentinel for a list read with no id param', async () => {
    currentMeta = { resource: 'CUSTOMER_RECORD' };
    await lastValueFrom(
      interceptor().intercept(ctx(currentMeta, { params: {}, query: {} }), { handle: () => of([]) }),
    );
    expect(recorded[0].entityId).toBe(NOT_A_RECORD_ENTITY_ID);
  });

  it('logs a refused read as DENIED', async () => {
    currentMeta = { resource: 'ASSAYER_RECORD', idParam: 'id' };
    const req = { params: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, query: {} };
    await expect(
      lastValueFrom(
        interceptor().intercept(ctx(currentMeta, req), {
          handle: () => throwError(() => new ForbiddenException()),
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(recorded[0].outcome).toBe('DENIED');
  });

  it('logs any other failed read as FAILURE', async () => {
    currentMeta = { resource: 'ASSAYER_RECORD', idParam: 'id' };
    await expect(
      lastValueFrom(
        interceptor().intercept(ctx(currentMeta, { params: { id: 'x' }, query: {} }), {
          handle: () => throwError(() => new NotFoundException()),
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(recorded[0].outcome).toBe('FAILURE');
  });
});
