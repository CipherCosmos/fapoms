import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataResetService } from './data-reset.service';
import { FkGraphService, FkEdge } from './fk-graph.service';

describe('DataResetService', () => {
  let service: DataResetService;
  let mockDataSource: { query: jest.Mock; transaction: jest.Mock };
  let mockFkGraph: { loadEdges: jest.Mock };
  let mockAudit: { recordEvent: jest.Mock };
  let mockBackup: { createDump: jest.Mock };

  const EDGES: FkEdge[] = [
    { child: 'branches', column: 'client_id', parent: 'clients', onDelete: 'SET NULL' },
    { child: 'billing_entries', column: 'client_id', parent: 'clients', onDelete: 'RESTRICT' },
    { child: 'device_tokens', column: 'user_id', parent: 'users', onDelete: 'NO ACTION' },
    // Cascade-reached but owned by no domain — the shape that caused the user_roles incident.
    { child: 'user_roles', column: 'user_id', parent: 'users', onDelete: 'CASCADE' },
  ];

  beforeEach(() => {
    mockDataSource = {
      // Every count/affected-row query in this suite returns 0 unless a test overrides it —
      // the point of these tests is the decision logic (conflicts, implied domains, ordering),
      // not real row counts.
      query: jest.fn().mockResolvedValue([{ count: 0 }]),
      transaction: jest.fn(async (_isolation: string, fn: (manager: any) => Promise<any>) =>
        fn({
          // COUNT(*) has to answer in its own shape — execute() re-counts inside the transaction
          // to measure what cascades removed, and a DELETE-shaped reply there reads as 0 rows.
          query: jest.fn((sql: string) =>
            Promise.resolve(/SELECT COUNT/.test(sql) ? [{ count: 0 }] : [[], 0]),
          ),
        }),
      ),
    };
    mockFkGraph = { loadEdges: jest.fn().mockResolvedValue(EDGES) };
    mockAudit = { recordEvent: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    mockBackup = { createDump: jest.fn() };

    service = new DataResetService(
      mockDataSource as any,
      mockFkGraph as any,
      mockAudit as any,
      mockBackup as any,
    );
  });

  describe('preview', () => {
    it('rejects an unknown domain', async () => {
      await expect(service.preview(['not-a-real-domain'])).rejects.toThrow(NotFoundException);
    });

    it('flags billing as an implied domain when clients is selected alone', async () => {
      const result = await service.preview(['clients']);
      expect(result.impliedDomains).not.toContain('billing');
      // billing_entries is a RESTRICT conflict, not a cascade-implied table — it shows up there:
      expect(result.restrictConflicts.map((c) => c.child)).toContain('billing_entries');
    });

    it('reports the SET NULL effect on branches without blocking', async () => {
      const result = await service.preview(['clients']);
      expect(result.setNullEffects.map((e) => e.child)).toContain('branches');
      expect(result.restrictConflicts.map((c) => c.child)).not.toContain('branches');
    });
  });

  describe('execute', () => {
    it('rejects with 409 when a RESTRICT conflict is unresolved', async () => {
      await expect(
        service.execute({ domainKeys: ['clients'], keepUserIds: [], actorUserId: 'admin-1' }),
      ).rejects.toThrow(ConflictException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('succeeds once the RESTRICT-conflicting domain is also selected', async () => {
      const result = await service.execute({
        domainKeys: ['clients', 'billing'],
        keepUserIds: [],
        billingConfirmed: true,
        actorUserId: 'admin-1',
      });
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(result.removed).toBeDefined();
    });

    it('rejects billing selection without the extra confirmation flag', async () => {
      await expect(
        service.execute({ domainKeys: ['clients', 'billing'], keepUserIds: [], actorUserId: 'admin-1' }),
      ).rejects.toThrow(ConflictException);
    });

    it('force-scopes device_tokens and the users delete to the keep-list, inside one transaction', async () => {
      const queries: Array<{ sql: string; params: any[] }> = [];
      mockDataSource.transaction.mockImplementation(async (_isolation: string, fn: (m: any) => Promise<any>) =>
        fn({
          query: jest.fn((sql: string, params: any[] = []) => {
            queries.push({ sql, params });
            return Promise.resolve(/SELECT COUNT/.test(sql) ? [{ count: 0 }] : [[], 0]);
          }),
        }),
      );

      await service.execute({
        domainKeys: ['users'],
        keepUserIds: ['keep-me'],
        actorUserId: 'admin-1',
      });

      const usersDelete = queries.find((q) => /DELETE FROM "users"/.test(q.sql));
      expect(usersDelete?.params[0]).toEqual(['keep-me']);

      const scopedDelete = queries.find((q) => /DELETE FROM "device_tokens"/.test(q.sql));
      expect(scopedDelete?.sql).toMatch(/user_id IN \(SELECT id FROM "users"/);

      // device_tokens must run before users, since it's the child in the dependency order.
      const usersIdx = queries.findIndex((q) => /DELETE FROM "users"/.test(q.sql));
      const tokensIdx = queries.findIndex((q) => /DELETE FROM "device_tokens"/.test(q.sql));
      expect(tokensIdx).toBeLessThan(usersIdx);
    });

    /**
     * The user_roles incident, as a test.
     *
     * `user_roles` is reached by CASCADE from `users` but belongs to no wipe domain. Iterating the
     * cascade closure meant it got a blanket `DELETE FROM "user_roles"`, which stripped the roles
     * off the accounts the keep-list had just saved — the surviving admin was left holding no
     * permissions at all. Only explicitly-selected tables may be deleted from here; the database's
     * own CASCADE removes the child rows of the parents that actually went, which is the only
     * behaviour that respects a scoped parent delete.
     */
    it('never issues a blanket DELETE against a cascade-reached table nobody selected', async () => {
      const statements: string[] = [];
      mockDataSource.transaction.mockImplementation(async (_iso: string, fn: (m: any) => Promise<any>) =>
        fn({
          query: jest.fn((sql: string) => {
            statements.push(sql);
            return Promise.resolve(/SELECT COUNT/.test(sql) ? [{ count: 0 }] : [[], 0]);
          }),
        }),
      );

      await service.execute({ domainKeys: ['users'], keepUserIds: ['keep-me'], actorUserId: 'admin-1' });

      expect(statements.some((s) => /DELETE FROM "user_roles"/.test(s))).toBe(false);
    });

    it('writes one unguarded audit event inside the same transaction', async () => {
      await service.execute({ domainKeys: ['users'], keepUserIds: ['admin-1'], actorUserId: 'admin-1' });

      expect(mockAudit.recordEvent).toHaveBeenCalledTimes(1);
      const [dto, scope] = mockAudit.recordEvent.mock.calls[0];
      expect(dto.eventType).toBe('DATA_RESET_EXECUTED');
      expect(scope?.manager).toBeDefined();
    });

    /**
     * `audit_events.entity_id` is `uuid NOT NULL`. This started as the literal `'ALL'`, which
     * Postgres rejected and — because the audit write is deliberately unguarded — rolled back the
     * whole wipe. A mocked AuditService can't reproduce the driver's type error, so assert the
     * shape here instead; that is the part a unit test can actually hold onto.
     */
    it('sends an entityId the uuid column will accept', async () => {
      await service.execute({ domainKeys: ['users'], keepUserIds: ['admin-1'], actorUserId: 'admin-1' });

      const [dto] = mockAudit.recordEvent.mock.calls[0];
      expect(dto.entityId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });
});
