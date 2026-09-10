import 'reflect-metadata';
import { ROUTE_ARGS_METADATA, PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { OutboxController } from './outbox.controller';

/**
 * The outbox admin surface: who reaches it, and what it leaves behind.
 *
 * `POST /admin/outbox/dead-letters/:id/replay` re-publishes a domain event to every subscriber.
 * For `assignment:status-changed` that is the billing engine, so this one button can set money
 * moving. Two properties therefore have to hold, and neither is visible from the service tests
 * that cover the replay itself:
 *
 *  1. It is reachable by the DEVELOPER role alone, and by the ROLE — not by a permission an
 *     administrator could tick on in the role editor. `admin/rule-bypass` and the four
 *     notification-admin writes already carry `@RoleOnly()` for exactly this reason.
 *  2. Every read and every replay reaches the audit trail. A screen whose purpose is to show
 *     what the system failed to do, and to make it try again, must itself leave a record — and
 *     that record has to say what was actually undone.
 *
 * The last part is not hypothetical. The replay audit metadata reads `previousAttempts`, and the
 * controller took it off the row the service returns — which has just had `attempts` reset to 0
 * by the replay. Every replay was recorded as "returned after failing 0 times".
 */
describe('OutboxController', () => {
  const audit = { recordEventSafe: jest.fn(async (_event: Record<string, unknown>) => undefined) };
  const deadLetters = {
    health: jest.fn(async () => ({ pending: 2, deadLettered: 1, retrying: 1, oldestPendingAgeSeconds: 90, maxAttempts: 15 })),
    list: jest.fn(async () => [{ id: 'e1', eventName: 'assignment:status-changed', subject: { assignmentId: 'asn-1' } }]),
    get: jest.fn(async () => ({ id: 'e1', eventName: 'assignment:status-changed', attempts: 15, payload: { assignmentId: 'asn-1' } })),
    replay: jest.fn(async () => ({
      id: 'e1',
      eventName: 'assignment:status-changed',
      subject: { assignmentId: 'asn-1' },
      attempts: 0,
      previousAttempts: 15,
      replayedBy: 'dev-1',
    })),
  };

  const req: any = { user: { id: 'dev-1', fullName: 'A Developer' }, ip: '10.0.0.9' };
  let controller: OutboxController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new OutboxController(deadLetters as any, audit as any);
  });

  describe('who can reach it', () => {
    it('is mounted under admin/outbox and gated on the DEVELOPER role only', () => {
      expect(Reflect.getMetadata(PATH_METADATA, OutboxController)).toBe('admin/outbox');
      expect(Reflect.getMetadata('roles', OutboxController)).toEqual(['DEVELOPER']);
    });

    it('is role-only, so the capability cannot be granted through the role editor', () => {
      // Without this, a permission ticked onto any role would open a route that re-fires
      // arbitrary domain events. The flag is what keeps it off that list.
      expect(Reflect.getMetadata('roleOnly', OutboxController)).toBe(true);
    });

    it('declares no grantable permission of its own on any handler', () => {
      for (const name of ['health', 'list', 'get', 'replay'] as const) {
        const handler = (OutboxController.prototype as any)[name];
        expect(Reflect.getMetadata('permissions', handler)).toBeUndefined();
      }
    });

    it('exposes exactly the three reads and the one write, and replay is a POST', () => {
      const route = (name: string) => ({
        path: Reflect.getMetadata(PATH_METADATA, (OutboxController.prototype as any)[name]),
        method: Reflect.getMetadata(METHOD_METADATA, (OutboxController.prototype as any)[name]),
      });
      expect(route('health')).toEqual({ path: 'health', method: RequestMethod.GET });
      expect(route('list')).toEqual({ path: 'dead-letters', method: RequestMethod.GET });
      expect(route('get')).toEqual({ path: 'dead-letters/:id', method: RequestMethod.GET });
      expect(route('replay')).toEqual({ path: 'dead-letters/:id/replay', method: RequestMethod.POST });
    });

    it('validates the event id as a UUID on both routes that take one', () => {
      // A path parameter reaching a repository lookup unchecked. The pipe is metadata, so it is
      // asserted as metadata rather than by driving a request through a whole Nest application.
      for (const name of ['get', 'replay'] as const) {
        const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, OutboxController, name) ?? {};
        const params = Object.values(args) as Array<{ data?: unknown; pipes?: unknown[] }>;
        const idParam = params.find((p) => p.data === 'id');
        expect(idParam).toBeDefined();
        expect((idParam!.pipes ?? []).length).toBeGreaterThan(0);
      }
    });
  });

  describe('what it leaves behind', () => {
    it('records the health read as a plain delegation with no audit noise', async () => {
      // Counts only, no rows, nothing identifying. A dashboard tile polling this must not write
      // an audit row per poll, or the trail becomes unreadable exactly when it is needed.
      await expect(controller.health()).resolves.toEqual({
        success: true,
        data: { pending: 2, deadLettered: 1, retrying: 1, oldestPendingAgeSeconds: 90, maxAttempts: 15 },
      });
      expect(audit.recordEventSafe).not.toHaveBeenCalled();
    });

    it('records who read the queue, and how much of it they saw', async () => {
      const res: any = await controller.list('25', req);
      expect(deadLetters.list).toHaveBeenCalledWith(25);
      expect(res.data.count).toBe(1);
      expect(audit.recordEventSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'OUTBOX_DEAD_LETTERS_READ',
          entityType: 'OutboxEvent',
          userId: 'dev-1',
          ipAddress: '10.0.0.9',
          outcome: 'SUCCESS',
          metadata: { returned: 1 },
        }),
      );
    });

    it('passes no limit through when the caller gave none, rather than NaN', async () => {
      await controller.list(undefined, req);
      expect(deadLetters.list).toHaveBeenCalledWith(undefined);
    });

    it('records reading one event, which is the read that returns the payload', async () => {
      await controller.get('e1', req);
      expect(audit.recordEventSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'OUTBOX_EVENT_READ',
          entityId: 'e1',
          metadata: { eventName: 'assignment:status-changed', attempts: 15 },
        }),
      );
    });

    it('records a replay with the attempt count it undid, not the reset one', async () => {
      const res: any = await controller.replay('e1', req);
      expect(deadLetters.replay).toHaveBeenCalledWith('e1', 'dev-1');
      expect(res.data.previousAttempts).toBe(15);
      const [event] = audit.recordEventSafe.mock.calls.at(-1)!;
      expect(event).toMatchObject({
        eventType: 'OUTBOX_EVENT_REPLAYED',
        entityId: 'e1',
        userId: 'dev-1',
        metadata: {
          eventName: 'assignment:status-changed',
          subject: { assignmentId: 'asn-1' },
          previousAttempts: 15,
        },
      });
      // The bug this pins: `attempts` on the returned row is 0 by construction, so recording it
      // as `previousAttempts` made every replay look like it had never failed.
      expect((event as any).metadata.previousAttempts).not.toBe(0);
    });

    it('does not swallow a refused replay into a success', async () => {
      // The service refuses a delivered or still-retrying row. If the controller caught that and
      // answered 200, an operator would believe an event was requeued when it was not.
      deadLetters.replay.mockRejectedValueOnce(new Error('nothing to replay'));
      await expect(controller.replay('e1', req)).rejects.toThrow(/nothing to replay/);
      expect(audit.recordEventSafe).not.toHaveBeenCalled();
    });
  });
});
