import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DestructiveApprovalService } from './destructive-approval.service';

/**
 * The two-person rule, held as tests: a DEVELOPER requests, an ADMIN who is not the requester
 * approves, and only the REQUESTING developer executes — exactly once, exactly the approved
 * selection, only while the approval lasts. Mocking follows data-reset.service.spec.ts: raw
 * `dataSource.query` stubbed per statement shape, because the logic under test is the decision
 * making, not Postgres.
 */
describe('DestructiveApprovalService', () => {
  let service: DestructiveApprovalService;
  let mockDataSource: { query: jest.Mock };
  let mockDataReset: { preview: jest.Mock };
  let mockAudit: { recordEventSafe: jest.Mock };
  let mockDispatch: { emitSafe: jest.Mock };

  /** One route table per test: first regex to match the SQL answers it. Unmatched SQL throws, so
   *  a statement this suite never anticipated fails the test instead of silently returning []. */
  let routes: Array<[RegExp, (sql: string, params?: any[]) => any]>;
  const answer = (sql: string, params?: any[]) => {
    for (const [re, responder] of routes) {
      if (re.test(sql)) return Promise.resolve(responder(sql, params));
    }
    return Promise.reject(new Error(`Unrouted SQL in test: ${sql.slice(0, 80)}`));
  };

  const row = (overrides: Partial<Record<string, any>> = {}) => ({
    id: 'req-1',
    action_type: 'DATA_RESET',
    status: 'REQUESTED',
    payload: { domainKeys: ['clients', 'users'], previewCounts: { clients: 5, users: 2 } },
    requested_by: 'dev-1',
    decided_by: null,
    decision_reason: null,
    requested_at: new Date('2026-09-05T10:00:00Z'),
    decided_at: null,
    executed_at: null,
    expires_at: null,
    ...overrides,
  });

  beforeEach(() => {
    routes = [];
    mockDataSource = { query: jest.fn(answer) };
    mockDataReset = {
      preview: jest.fn().mockResolvedValue({
        counts: { clients: 5, client_contacts: 0, users: 2, device_tokens: 0, refresh_tokens: 0 },
      }),
    };
    mockAudit = { recordEventSafe: jest.fn().mockResolvedValue(undefined) };
    mockDispatch = { emitSafe: jest.fn() };

    service = new DestructiveApprovalService(
      mockDataSource as any,
      mockDataReset as any,
      mockAudit as any,
      mockDispatch as any,
    );
  });

  // ── request ──────────────────────────────────────────────────────────────

  describe('request', () => {
    beforeEach(() => {
      routes = [
        [/SELECT id, status FROM destructive_action_requests/, () => []],
        [/INSERT INTO destructive_action_requests/, (_sql, params) => [
          row({ payload: JSON.parse(params![2]), requested_by: params![3] }),
        ]],
        [/SELECT display_name FROM users/, () => [{ display_name: 'Dev One' }]],
      ];
    });

    it('validates via a real server-side preview and freezes sorted domains + per-domain counts', async () => {
      const result = await service.request('dev-1', ['users', 'clients']);

      expect(mockDataReset.preview).toHaveBeenCalledWith(['users', 'clients']);
      const insert = mockDataSource.query.mock.calls.find(([sql]) => /INSERT INTO destructive_action_requests/.test(sql))!;
      const payload = JSON.parse(insert[1][2]);
      expect(payload.domainKeys).toEqual(['clients', 'users']); // sorted, whatever order was sent
      expect(payload.previewCounts).toEqual({ clients: 5, users: 2 }); // summed per DOMAIN, not per table
      expect(result.status).toBe('REQUESTED');
      expect(mockDispatch.emitSafe).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'DESTRUCTIVE_ACTION_REQUESTED', actorUserId: 'dev-1' }),
      );
    });

    it('refuses a second open request from the same developer, naming the first', async () => {
      routes.unshift([
        /SELECT id, status FROM destructive_action_requests/,
        () => [{ id: 'req-0', status: 'APPROVED' }],
      ]);

      await expect(service.request('dev-1', ['clients'])).rejects.toThrow(ConflictException);
      await expect(service.request('dev-1', ['clients'])).rejects.toThrow(/req-0/);
      expect(mockDataSource.query.mock.calls.some(([sql]) => /INSERT/.test(sql))).toBe(false);
    });

    it('refuses an unknown domain exactly as preview does', async () => {
      mockDataReset.preview.mockRejectedValue(new NotFoundException('Unknown domain "bogus".'));
      await expect(service.request('dev-1', ['bogus'])).rejects.toThrow(NotFoundException);
    });
  });

  // ── decide ───────────────────────────────────────────────────────────────

  describe('decide', () => {
    const decidedRow = row({
      status: 'APPROVED',
      decided_by: 'admin-1',
      decided_at: new Date('2026-09-05T11:00:00Z'),
      expires_at: new Date('2026-09-06T11:00:00Z'),
    });

    beforeEach(() => {
      routes = [
        [/SELECT \* FROM destructive_action_requests/, () => [row()]],
        [/FROM user_roles/, () => [{ exists: true }]],
        [/UPDATE destructive_action_requests\s+SET status = \$2/, () => [[decidedRow], 1]],
      ];
    });

    it('approves: APPROVED + decided_* + expiry, and tells the requester', async () => {
      const result = await service.decide('req-1', 'admin-1', true);

      expect(result.status).toBe('APPROVED');
      expect(result.decidedById).toBe('admin-1');
      expect(result.expiresAt).toBe('2026-09-06T11:00:00.000Z');
      expect(mockDispatch.emitSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DESTRUCTIVE_ACTION_DECIDED',
          ownerUserId: 'dev-1',
          payload: expect.objectContaining({ decision: 'approved' }),
        }),
      );
    });

    it('refuses an approver without a DIRECT ADMIN role row — implication does not count here', async () => {
      routes[1] = [/FROM user_roles/, () => []];

      await expect(service.decide('req-1', 'dev-2', true)).rejects.toThrow(ForbiddenException);
      await expect(service.decide('req-1', 'dev-2', true)).rejects.toThrow(/held directly/);
      // The refusal came from a fresh user_roles query, not from any cached principal.
      expect(mockDataSource.query.mock.calls.some(([sql]) => /FROM user_roles/.test(sql))).toBe(true);
      expect(mockDataSource.query.mock.calls.some(([sql]) => /UPDATE/.test(sql))).toBe(false);
    });

    it('refuses self-approval, naming the two-person rule', async () => {
      await expect(service.decide('req-1', 'dev-1', true)).rejects.toThrow(ForbiddenException);
      await expect(service.decide('req-1', 'dev-1', true)).rejects.toThrow(/two-person/);
    });

    it('requires a reason to reject', async () => {
      await expect(service.decide('req-1', 'admin-1', false)).rejects.toThrow(BadRequestException);
      await expect(service.decide('req-1', 'admin-1', false, '   ')).rejects.toThrow(BadRequestException);
    });

    it('rejects with the reason recorded and relayed', async () => {
      const rejected = row({ status: 'REJECTED', decided_by: 'admin-1', decision_reason: 'Not on prod.' });
      routes[2] = [/UPDATE destructive_action_requests\s+SET status = \$2/, () => [[rejected], 1]];

      const result = await service.decide('req-1', 'admin-1', false, 'Not on prod.');
      expect(result.status).toBe('REJECTED');
      expect(mockDispatch.emitSafe).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ decision: 'rejected' }) }),
      );
    });

    it('409s a request that is not awaiting a decision', async () => {
      routes[0] = [/SELECT \* FROM destructive_action_requests/, () => [row({ status: 'CANCELLED' })]];
      await expect(service.decide('req-1', 'admin-1', true)).rejects.toThrow(ConflictException);
    });

    it('409s when a concurrent decision won the race', async () => {
      routes[2] = [/UPDATE destructive_action_requests\s+SET status = \$2/, () => [[], 0]];
      await expect(service.decide('req-1', 'admin-1', true)).rejects.toThrow(ConflictException);
    });
  });

  // ── cancel ───────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('lets only the requester withdraw, and only from REQUESTED', async () => {
      routes = [
        [/SELECT \* FROM destructive_action_requests/, () => [row()]],
        [/UPDATE destructive_action_requests\s+SET status = 'CANCELLED'/, () => [[row({ status: 'CANCELLED' })], 1]],
      ];

      await expect(service.cancel('req-1', 'someone-else')).rejects.toThrow(ForbiddenException);

      const result = await service.cancel('req-1', 'dev-1');
      expect(result.status).toBe('CANCELLED');
    });

    it('409s a cancel on an already-decided request', async () => {
      routes = [
        [/SELECT \* FROM destructive_action_requests/, () => [row({ status: 'APPROVED' })]],
        [/UPDATE destructive_action_requests\s+SET status = 'CANCELLED'/, () => [[], 0]],
      ];
      await expect(service.cancel('req-1', 'dev-1')).rejects.toThrow(ConflictException);
    });
  });

  // ── assertExecutableAndConsume ───────────────────────────────────────────

  describe('assertExecutableAndConsume', () => {
    const approved = () =>
      row({ status: 'APPROVED', decided_by: 'admin-1', expires_at: new Date(Date.now() + 3_600_000) });

    it('consumes an APPROVED request atomically for the requester with the exact approved selection', async () => {
      routes = [
        [/SELECT \* FROM destructive_action_requests/, () => [approved()]],
        [/UPDATE destructive_action_requests\s+SET status = 'EXECUTED'/, () => [[{ id: 'req-1' }], 1]],
      ];

      await expect(
        service.assertExecutableAndConsume('req-1', 'dev-1', ['users', 'clients']),
      ).resolves.toBeUndefined();

      const consume = mockDataSource.query.mock.calls.find(([sql]) => /SET status = 'EXECUTED'/.test(sql))!;
      expect(consume[0]).toMatch(/status = 'APPROVED' AND expires_at > now\(\)/);
    });

    it('runs on the wipe transaction manager when given one', async () => {
      const manager = { query: jest.fn(answer) };
      routes = [
        [/SELECT \* FROM destructive_action_requests/, () => [approved()]],
        [/UPDATE destructive_action_requests\s+SET status = 'EXECUTED'/, () => [[{ id: 'req-1' }], 1]],
      ];

      await service.assertExecutableAndConsume('req-1', 'dev-1', ['clients', 'users'], manager as any);

      expect(manager.query).toHaveBeenCalledTimes(2);
      expect(mockDataSource.query).not.toHaveBeenCalled();
    });

    it('403s an executor who is not the requester', async () => {
      routes = [[/SELECT \* FROM destructive_action_requests/, () => [approved()]]];
      await expect(
        service.assertExecutableAndConsume('req-1', 'admin-1', ['clients', 'users']),
      ).rejects.toThrow(ForbiddenException);
    });

    it('409s a selection that drifted from the approved one, naming both', async () => {
      routes = [[/SELECT \* FROM destructive_action_requests/, () => [approved()]]];
      const attempt = service.assertExecutableAndConsume('req-1', 'dev-1', ['clients', 'users', 'billing']);
      await expect(attempt).rejects.toThrow(ConflictException);
      await expect(
        service.assertExecutableAndConsume('req-1', 'dev-1', ['clients']),
      ).rejects.toThrow(/not what was approved/);
    });

    it('flips a stale APPROVED to EXPIRED — outside the doomed transaction — and refuses', async () => {
      const manager = { query: jest.fn(answer) };
      const stale = row({ status: 'APPROVED', expires_at: new Date(Date.now() - 1000) });
      routes = [
        [/SET status = 'EXPIRED'/, () => [[], 1]],
        [/SELECT \* FROM destructive_action_requests/, () => [stale]],
        [/UPDATE destructive_action_requests\s+SET status = 'EXECUTED'/, () => [[], 0]],
      ];

      await expect(
        service.assertExecutableAndConsume('req-1', 'dev-1', ['clients', 'users'], manager as any),
      ).rejects.toThrow(/expired/);

      // The EXPIRED flip must SURVIVE the rollback the throw is about to cause, so it goes to
      // the root dataSource, never the transaction's own manager.
      expect(manager.query.mock.calls.some(([sql]) => /EXPIRED/.test(sql))).toBe(false);
      expect(mockDataSource.query.mock.calls.some(([sql]) => /SET status = 'EXPIRED'/.test(sql))).toBe(true);
    });

    it('409s a not-yet-approved request', async () => {
      routes = [
        [/SELECT \* FROM destructive_action_requests/, () => [row()]],
        [/UPDATE destructive_action_requests\s+SET status = 'EXECUTED'/, () => [[], 0]],
      ];
      await expect(
        service.assertExecutableAndConsume('req-1', 'dev-1', ['clients', 'users']),
      ).rejects.toThrow(/not been approved/);
    });

    it('refuses a double execute — the second consume finds zero rows', async () => {
      routes = [
        [/SELECT \* FROM destructive_action_requests/, () => [row({ status: 'EXECUTED', executed_at: new Date() })]],
        [/UPDATE destructive_action_requests\s+SET status = 'EXECUTED'/, () => [[], 0]],
      ];
      await expect(
        service.assertExecutableAndConsume('req-1', 'dev-1', ['clients', 'users']),
      ).rejects.toThrow(/already used/);
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('sweeps stale approvals to EXPIRED, then scopes: direct admins see the queue, developers their own', async () => {
      const listed: string[] = [];
      routes = [
        [/SET status = 'EXPIRED'/, () => [[], 0]],
        [/LEFT JOIN users/, (sql) => {
          listed.push(sql);
          return [row({ requested_by_name: 'Dev One', decided_by_name: null })];
        }],
      ];

      const adminView = await service.list({ id: 'admin-1', isAdminDirect: true, isDeveloper: false });
      expect(adminView[0].requestedByName).toBe('Dev One');
      expect(listed[0]).toMatch(/status = 'REQUESTED' OR/);

      const devView = await service.list({ id: 'dev-1', isAdminDirect: false, isDeveloper: true });
      expect(devView).toHaveLength(1);
      expect(listed[1]).toMatch(/requested_by = \$1/);

      expect(mockDataSource.query.mock.calls.filter(([sql]) => /SET status = 'EXPIRED'/.test(sql))).toHaveLength(2);
    });
  });

  // ── lifecycle, end to end ────────────────────────────────────────────────

  it('walks the happy path: request → approve by another admin → consume by the requester', async () => {
    // One mutable row standing in for the table, so each step sees the previous step's write.
    const table: { current: any } = { current: null };
    routes = [
      [/SELECT id, status FROM destructive_action_requests/, () => []],
      [/INSERT INTO destructive_action_requests/, (_sql, params) => {
        table.current = row({ payload: JSON.parse(params![2]) });
        return [table.current];
      }],
      [/SELECT display_name FROM users/, () => [{ display_name: 'Dev One' }]],
      [/FROM user_roles/, () => [{ exists: true }]],
      [/UPDATE destructive_action_requests\s+SET status = \$2/, (_sql, params) => {
        table.current = { ...table.current, status: params![1], decided_by: params![2], decided_at: new Date(), expires_at: new Date(Date.now() + 3_600_000) };
        return [[table.current], 1];
      }],
      [/SELECT \* FROM destructive_action_requests/, () => [table.current]],
      [/UPDATE destructive_action_requests\s+SET status = 'EXECUTED'/, () => {
        if (table.current.status !== 'APPROVED') return [[], 0];
        table.current = { ...table.current, status: 'EXECUTED', executed_at: new Date() };
        return [[{ id: table.current.id }], 1];
      }],
    ];

    const requested = await service.request('dev-1', ['users', 'clients']);
    expect(requested.status).toBe('REQUESTED');

    const approvedView = await service.decide('req-1', 'admin-1', true);
    expect(approvedView.status).toBe('APPROVED');

    await expect(
      service.assertExecutableAndConsume('req-1', 'dev-1', ['clients', 'users']),
    ).resolves.toBeUndefined();
    expect(table.current.status).toBe('EXECUTED');

    // And the approval is spent: running it again finds nothing to consume.
    await expect(
      service.assertExecutableAndConsume('req-1', 'dev-1', ['clients', 'users']),
    ).rejects.toThrow(/already used/);
  });
});

/**
 * Decorator fitness for the controller, in the repo's source-reading style
 * (assayer-controller-region-scope.spec.ts): what is asserted is a property of the source —
 * which gates each route declares — not runtime behaviour a request would have to observe.
 * data-reset has no controller spec to extend, so the assertions live here with the feature.
 */
describe('DataResetController gate fitness', () => {
  const src = fs.readFileSync(path.join(__dirname, 'data-reset.controller.ts'), 'utf8');
  // Comments blanked so prose about a decorator cannot satisfy an assertion about the decorator.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

  const between = (start: RegExp, end: RegExp): string => {
    const from = code.search(start);
    expect(from).toBeGreaterThanOrEqual(0);
    const rest = code.slice(from);
    const to = rest.search(end);
    return to === -1 ? rest : rest.slice(0, to);
  };

  it('gates the class on DEVELOPER alone — the wipe belongs to the developer', () => {
    const classDecorators = between(/@Controller\('admin\/data-reset'\)/, /export class DataResetController/);
    expect(classDecorators).toMatch(/@Roles\(SystemRole\.DEVELOPER\)/);
    expect(classDecorators).not.toMatch(/SystemRole\.ADMIN/);
  });

  for (const route of ['approve', 'reject']) {
    it(`fences ${route} as the ADMIN half: name + @RoleOnly + the approve permission`, () => {
      const block = between(new RegExp(`@Post\\('requests/:id/${route}'\\)`), /async \w+Request\(/);
      expect(block).toMatch(/@Roles\(SystemRole\.ADMIN\)/);
      expect(block).toMatch(/@RoleOnly\(\)/);
      expect(block).toMatch(/@RequirePermissions\('system:approve:platform'\)/);
    });
  }

  it('widens only the list route to admins', () => {
    const block = between(/@Get\('requests'\)/, /async listRequests\(/);
    expect(block).toMatch(/@Roles\(SystemRole\.DEVELOPER, SystemRole\.ADMIN\)/);
  });

  it('makes requestId a required uuid on execute — no request, no wipe', () => {
    const dto = between(/export class ExecuteDataResetDto/, /@Controller/);
    const chunk = dto.split(/\n\s*\n/).find((c) => c.includes('requestId'));
    expect(chunk).toBeDefined();
    expect(chunk!).toMatch(/@IsUUID\('4'\)/);
    expect(chunk!).not.toMatch(/@IsOptional/);
    expect(chunk!).toMatch(/requestId: string;/); // not `requestId?:`
  });

  it('passes the consume hook into the wipe from execute', () => {
    const block = between(/@Post\('execute'\)/, /^\}/m);
    expect(block).toMatch(/consumeApproval/);
    expect(block).toMatch(/assertExecutableAndConsume\(dto\.requestId, req\.user\.id, dto\.domainKeys, manager\)/);
  });
});
