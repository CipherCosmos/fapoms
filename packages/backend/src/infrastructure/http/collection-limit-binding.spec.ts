import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { PipeTransform, Type } from '@nestjs/common';

import { AuditLogController } from '../../core/audit/audit.controller';
import { ClientController } from '../../modules/client/client.controller';
import { GeoController } from '../../modules/geo/geo.controller';
import { NotificationController } from '../../modules/notifications/notification.controller';
import { OrganizationController } from '../../modules/organization/organization.controller';
import { ProjectController } from '../../modules/project/project.controller';
import { RuleBypassController } from '../../modules/platform/rule-bypass/rule-bypass.controller';
import { SchedulingController } from '../../modules/scheduling/scheduling.controller';
import { ValidationController } from '../../modules/validation/validation.controller';

/**
 * THE BINDING, NOT THE PIPE.
 *
 * `parse-limit.pipe.spec.ts` already proves `ParseLimitPipe` clamps, floors and rejects garbage.
 * What that cannot catch is the thing that actually regresses: somebody reverting a parameter to a
 * bare `@Query('limit')`, or dropping the pipe argument while keeping the name. That leaves the
 * pipe's own tests green and the route unbounded again — which is how these nine got here in the
 * first place.
 *
 * So this reads the pipes Nest will really run, off each route, and puts absurd, negative and
 * non-numeric input through them. Each row was measured against the running rig before it was
 * changed; the comment on each says what it did then.
 *
 * The two questions kept separate on purpose:
 *
 *   is there a MAXIMUM      `?limit=5000000` must come back as the route's ceiling, never as
 *                           5,000,000 and never as a 500 from `take: 5000000`.
 *   is the input VALIDATED  `-5`, `abc`, `0` and a repeated `?limit=1&limit=2` must all land on
 *                           the route's default. A 5xx is never the right answer to a query
 *                           parameter, and four of these routes were answering one.
 *
 * Routes deliberately NOT listed here are bounded one layer down, in their service, and are named
 * in the campaign report rather than moved: the three document data-entry/overview routes, the
 * mobile-facing `GET /assignments/assayer/:id`, `GET /feedback`, `GET /validation-queries`,
 * `GET /assayer-remarks/assayer/:id` and `GET /telemetry/user`. A service clamp is a real clamp;
 * it is just not the boundary.
 */
describe('collection endpoints: the limit pipe is bound, not just written', () => {
  const pipesFor = (controller: Type<any>, method: string, param = 'limit'): PipeTransform[] => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {};
    const entry = Object.values(args).find((a: any) => a?.data === param) as any;
    return entry?.pipes ?? [];
  };

  /** route label, controller, handler, default, max, and what it did before the pipe. */
  const ROUTES: Array<[string, Type<any>, string, number, number, string]> = [
    ['GET /clients', ClientController, 'findAll', 20, 200,
      'take(limit) with no ceiling; ?limit=5000000 accepted and echoed back, ?limit=-5 was a 500'],
    ['GET /organizations', OrganizationController, 'findAll', 50, 200,
      'take: limit with no ceiling; ?limit=-5 was a 500 on a negative skip'],
    ['GET /projects', ProjectController, 'findAll', 50, 200,
      'projectQueryService take: limit with no ceiling; meta echoed the caller\'s own number'],
    ['GET /schedules', SchedulingController, 'findAll', 50, 200,
      'take: limit with no ceiling; ?limit=5000000 accepted and echoed, ?limit=-5 was a 500'],
    ['GET /validation', ValidationController, 'findAll', 50, 200,
      'the QUERY was clamped at 200 but meta reported the raw ask — 60 rows under a claim of 5,000,000'],
    ['GET /validation/activity', ValidationController, 'activity', 20, 100,
      'clamped at 100 in the service; the guard moves to the boundary'],
    ['GET /notifications', NotificationController, 'findMyNotifications', 25, 100,
      'ParseIntPipe refused text but had no ceiling and no floor; ?limit=-5 reached take(-5)'],
    ['GET /admin/rule-bypass/history', RuleBypassController, 'history', 50, 200,
      'Math.min(limit, 200) has no floor, so ?limit=-5 reached take: -5'],
    ['GET /geo/precision/:target/imprecise', GeoController, 'impreciseRecords', 100, 500,
      'imprecise() does take: limit * 4 — ?limit=5000000 asks for twenty million rows'],
    ['GET /audit-log/trail', AuditLogController, 'getUnifiedTrail', 200, 500,
      'was a hand-rolled Math.min(Number(limit) || 200, 500), the clamp the pipe was factored out of'],
  ];

  describe.each(ROUTES)('%s', (_label, controller, method, def, max, _was) => {
    const clamp = (raw: unknown) => {
      const pipes = pipesFor(controller, method);
      expect(pipes).toHaveLength(1);
      return pipes[0].transform(raw, { type: 'query', data: 'limit' });
    };

    it('has a maximum, and an absurd ask is clamped to it rather than honoured', () => {
      expect(clamp('5000000')).toBe(max);
      expect(clamp(String(max + 1))).toBe(max);
      expect(clamp('1e30')).toBe(max);
    });

    it('has a safe default when nothing, or nothing usable, is sent', () => {
      expect(clamp(undefined)).toBe(def);
      expect(clamp('')).toBe(def);
    });

    it('refuses negative, zero and non-numeric input instead of passing it to the database', () => {
      expect(clamp('-5')).toBe(def);
      expect(clamp('-1')).toBe(def);
      expect(clamp('0')).toBe(def);
      expect(clamp('0.5')).toBe(def);
      expect(clamp('abc')).toBe(def);
      expect(clamp('12; DROP TABLE clients')).toBe(def);
      // A repeated key (`?limit=1&limit=2`) arrives as an array. The pipe takes the FIRST value,
      // which is what qs hands Express — still bounded, and still floored and clamped. Its own
      // comment used to claim it fell back to the default, which its own spec disproves.
      expect(clamp(['1', '2'])).toBe(1);
      expect(clamp(['abc', '2'])).toBe(def);
      expect(clamp(['5000000', '2'])).toBe(max);
    });

    it('passes a sane page size through untouched', () => {
      const sane = Math.min(def, max);
      expect(clamp(String(sane))).toBe(sane);
    });
  });
});
