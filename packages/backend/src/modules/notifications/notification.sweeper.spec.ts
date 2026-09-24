import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationChannel, NotificationStatus } from '@fapoms/shared';
import { NotificationSweeper } from './notification.sweeper';
import { NotificationEntity } from './notification.entity';
import { NOTIFICATION_QUEUE } from './notification.constants';
import { FAILED_JOB_RETENTION } from '../../infrastructure/queue/queued-job';

/**
 * The sweeper — the thing that notices when the queue never heard about a notification.
 *
 * ## Why this is worth a spec of its own
 *
 * `NotificationDispatchService` enqueues non-fatally on purpose: if Redis is unavailable the row is
 * still written and the business action still succeeds. The class comment states the condition that
 * makes that trade safe — "That trade is only safe if something later notices the orphan —
 * otherwise 'we didn't lose it, we just never sent it' is a distinction without a difference." This
 * class IS that something, and until now nothing tested it. It sat at 20% of statements with 0% of
 * branches and 0% of functions, and all three of its call sites in the existing suite —
 * `email-delivery.spec.ts`, `notification-delivery.worker.spec.ts`, and the module wiring — provide
 * it as `{ requeueStranded: jest.fn(), … }`, so every test in the repo that mentions the sweeper is
 * a test of something else with the sweeper stubbed out.
 *
 * That is the worst possible shape for a safety net. A broken sweeper does not throw, does not
 * degrade a response, and does not show up on a dashboard: it returns 0, logs nothing (the log line
 * is inside `if (requeued)`), and every stranded row stays exactly as it was. The failure it is
 * supposed to catch and the failure of catching it look identical from the outside — an assignment
 * offer that never reached anyone's phone.
 *
 * ## What each test pins, in one line
 *
 * The four decisions that are not obvious from reading the method: the PENDING-with-no-push
 * contradiction is settled rather than swept forever; a Redis that is still down stops the loop
 * instead of grinding through 200 rows; the push sweep and the email sweep really do read different
 * columns; and the abandoned-send rescue keys off `emailed_at` rather than `updated_at`.
 */

describe('NotificationSweeper', () => {
  let sweeper: NotificationSweeper;
  let found: any[];
  let updates: Array<{ id: string; patch: any }>;
  let queued: Array<{ name: string; data: any }>;

  const find = jest.fn();
  const update = jest.fn();
  const queueAdd = jest.fn();

  /** Records the update query builder's terms so the WHERE clause can be asserted, not just run. */
  let builderCalls: Array<{ set: any; where: any[]; affected: number }>;
  let affectedQueue: number[];

  const makeBuilder = () => {
    const call: { set: any; where: any[]; affected: number } = { set: null, where: [], affected: 0 };
    const qb: any = {
      update: () => qb,
      set: (patch: any) => { call.set = patch; return qb; },
      where: (clause: string, params: any) => { call.where.push({ clause, params }); return qb; },
      andWhere: (clause: string, params: any) => { call.where.push({ clause, params }); return qb; },
      execute: async () => {
        call.affected = affectedQueue.shift() ?? 0;
        builderCalls.push(call);
        return { affected: call.affected };
      },
    };
    return qb;
  };

  const queueGetJob = jest.fn();
  let existingJobs: Record<string, { getState: () => Promise<string>; remove: jest.Mock }> = {};

  const row = (over: Partial<any> = {}) => ({
    id: over.id ?? 'n-1',
    channels: [NotificationChannel.PUSH],
    status: NotificationStatus.PENDING,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  });

  beforeEach(async () => {
    found = [];
    updates = [];
    queued = [];
    builderCalls = [];
    affectedQueue = [];

    find.mockReset().mockImplementation(async () => found);
    update.mockReset().mockImplementation(async (id: string, patch: any) => {
      updates.push({ id, patch });
      return { affected: 1 };
    });
    queueGetJob.mockReset().mockImplementation(async (id: string) => existingJobs[id] ?? null);
    existingJobs = {};
    queueAdd.mockReset().mockImplementation(async (name: string, data: any) => {
      queued.push({ name, data });
      return { id: String(queued.length) };
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationSweeper,
        {
          provide: getRepositoryToken(NotificationEntity),
          useValue: { find, update, createQueryBuilder: makeBuilder },
        },
        { provide: getQueueToken(NOTIFICATION_QUEUE), useValue: { add: queueAdd, getJob: queueGetJob } },
      ],
    }).compile();

    sweeper = module.get(NotificationSweeper);
  });

  describe('requeueStranded — the push leg', () => {
    it('re-queues a row the enqueue never reached, with the same retry terms a fresh send gets', async () => {
      found = [row({ id: 'n-1' })];

      const count = await sweeper.requeueStranded();

      expect(count).toBe(1);
      expect(queued).toEqual([{ name: 'deliver', data: { notificationId: 'n-1' } }]);
      // The job options are the reason a swept row is not second-class: five attempts with
      // exponential backoff is what the original enqueue would have asked for, so a notification
      // rescued by the sweeper has exactly the delivery odds of one that was never stranded.
      expect(queueAdd).toHaveBeenCalledWith(
        'deliver',
        { notificationId: 'n-1' },
        expect.objectContaining({ attempts: 5, backoff: { type: 'exponential', delay: 5000 }, jobId: 'deliver:n-1' }),
      );
    });

    it('leaves a row whose delivery job is still waiting or running alone — one push, not two', async () => {
      found = [row({ id: 'n-1' })];
      existingJobs['deliver:n-1'] = { getState: async () => 'delayed', remove: jest.fn() };
      expect(await sweeper.requeueStranded()).toBe(0);
      expect(queueAdd).not.toHaveBeenCalled();
    });

    it('replaces a finished job kept under the id, since Bull will not add a second one', async () => {
      found = [row({ id: 'n-1' })];
      const old = { getState: async () => 'failed', remove: jest.fn(async () => undefined) };
      existingJobs['deliver:n-1'] = old;
      expect(await sweeper.requeueStranded()).toBe(1);
      expect(old.remove).toHaveBeenCalled();
    });

    it('looks only at rows older than the grace period, oldest first, in a bounded batch', async () => {
      const before = Date.now();
      await sweeper.requeueStranded();
      const after = Date.now();

      const [args] = find.mock.calls;
      expect(args[0].where.status).toBe(NotificationStatus.PENDING);
      expect(args[0].order).toEqual({ createdAt: 'ASC' });
      // Bounded, because a Redis outage of any length leaves an unbounded backlog and a sweep that
      // tried to drain all of it in one pass would hold the connection until it timed out.
      expect(args[0].take).toBe(200);

      // The five-minute grace is what stops the sweeper re-queueing a job that is at this moment
      // being processed normally — a double send is survivable, but a sweep that fights the worker
      // on every pass is a permanent duplicate generator.
      const cutoff: Date = args[0].where.createdAt._value ?? args[0].where.createdAt.value;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 5 * 60_000 - 50);
      expect(cutoff.getTime()).toBeLessThanOrEqual(after - 5 * 60_000 + 50);
    });

    /**
     * An in-app-only row is delivered the moment it is inserted, so PENDING on a row with no PUSH
     * channel is a state that cannot be resolved by sending anything. Left alone it is not
     * harmless: it matches the sweep's WHERE clause forever, so it occupies one of the 200 slots on
     * every pass, and enough of them starve the rows that genuinely are waiting on Redis.
     */
    it('settles a pending row that has no push channel instead of sweeping it forever', async () => {
      found = [row({ id: 'n-inapp', channels: [NotificationChannel.IN_APP] })];

      const count = await sweeper.requeueStranded();

      expect(count).toBe(0);
      expect(queued).toEqual([]);
      expect(updates).toHaveLength(1);
      expect(updates[0].id).toBe('n-inapp');
      expect(updates[0].patch.status).toBe(NotificationStatus.DELIVERED);
      expect(updates[0].patch.deliveredAt).toBeInstanceOf(Date);
    });

    it('treats a row with no channels at all the same way, rather than reading through a null', async () => {
      found = [row({ id: 'n-null', channels: null })];

      await expect(sweeper.requeueStranded()).resolves.toBe(0);
      expect(updates[0]).toEqual(
        expect.objectContaining({ id: 'n-null' }),
      );
    });

    /**
     * The break, not a continue — and this is the test that would have caught it going the other
     * way. The sweeper runs because Redis was unavailable; the overwhelmingly likely reason the
     * first `add` throws is that it still is. Continuing would mean 199 more failed round trips and
     * 199 more warn lines every sweep interval, against a Redis that is not going to answer, while
     * the rows end up in exactly the same place either way.
     */
    it('stops at the first re-queue failure rather than hammering a Redis that is still down', async () => {
      found = [row({ id: 'n-1' }), row({ id: 'n-2' }), row({ id: 'n-3' })];
      queueAdd.mockRejectedValue(new Error('ECONNREFUSED'));

      const count = await sweeper.requeueStranded();

      expect(count).toBe(0);
      expect(queueAdd).toHaveBeenCalledTimes(1);
    });

    it('keeps the rows it managed to re-queue before the failure', async () => {
      found = [row({ id: 'n-1' }), row({ id: 'n-2' }), row({ id: 'n-3' })];
      queueAdd
        .mockImplementationOnce(async (name: string, data: any) => { queued.push({ name, data }); return { id: '1' }; })
        .mockRejectedValue(new Error('ECONNREFUSED'));

      const count = await sweeper.requeueStranded();

      // Partial progress is real progress: the row that made it through is delivered, and the two
      // that did not are still PENDING and still older than the cutoff, so the next sweep sees them.
      expect(count).toBe(1);
      expect(queued.map((j) => j.data.notificationId)).toEqual(['n-1']);
    });

    it('does nothing and asks nothing of the queue when there is nothing stranded', async () => {
      found = [];

      expect(await sweeper.requeueStranded()).toBe(0);
      expect(queueAdd).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });
  });

  /**
   * Failed-job retention on both re-queues.
   *
   * The sweeper re-queues exactly the notifications most likely to be failing (they were stranded
   * once already), and its `deliver` / `deliver-email` jobs carried no `removeOnFail` — so each one
   * that exhausted its five attempts stayed in Redis forever, one more per sweep. The original
   * enqueue in NotificationDispatchService already bounds this with FAILED_JOB_RETENTION; a rescued
   * notification must not be the one that leaks. (`removeOnFail.spec.ts` only refuses a literal
   * `false`; an option that is simply absent slips past it, which is how these two did.)
   */
  describe('failed-job retention on re-queued jobs', () => {
    it('bounds failed deliver jobs with the shared retention, not Bull’s keep-forever default', async () => {
      found = [row({ id: 'n-1' })];

      await sweeper.requeueStranded();

      expect(queueAdd).toHaveBeenCalledWith(
        'deliver',
        { notificationId: 'n-1' },
        expect.objectContaining({ removeOnFail: FAILED_JOB_RETENTION }),
      );
    });

    it('bounds failed deliver-email jobs the same way', async () => {
      found = [row({ id: 'n-e1', status: NotificationStatus.DELIVERED, emailStatus: NotificationStatus.PENDING })];

      await sweeper.requeueStrandedMessages('EMAIL');

      expect(queueAdd).toHaveBeenCalledWith(
        'deliver-email',
        { notificationId: 'n-e1' },
        expect.objectContaining({ removeOnFail: FAILED_JOB_RETENTION }),
      );
    });
  });

  describe('requeueStrandedEmails — the email leg', () => {
    it('re-queues only emails not yet handed to the mail queue — PENDING, never SENT', async () => {
      await sweeper.requeueStrandedMessages('EMAIL');
      expect(find.mock.calls[0][0].where.emailStatus).toBe(NotificationStatus.PENDING);
    });

    /**
     * The two sweeps are not duplicates and merging them would silently drop the email leg. An
     * IN_APP+EMAIL row is born with row-status DELIVERED because the bell already has it, so the
     * push sweep's `status: PENDING` predicate never matches it no matter how long the email is
     * owed. Only `email_status` knows.
     */
    it('selects on emailStatus, which is the only column that knows an email is still owed', async () => {
      found = [row({ id: 'n-e1', status: NotificationStatus.DELIVERED, emailStatus: NotificationStatus.PENDING })];

      const count = await sweeper.requeueStrandedMessages('EMAIL');

      expect(find.mock.calls[0][0].where.emailStatus).toBe(NotificationStatus.PENDING);
      expect(find.mock.calls[0][0].where.status).toBeUndefined();
      expect(count).toBe(1);
      expect(queued).toEqual([{ name: 'deliver-email', data: { notificationId: 'n-e1' } }]);
    });

    it('does not apply the push leg’s channel rule — an email row has no PUSH channel by definition', async () => {
      found = [row({ id: 'n-e1', channels: [NotificationChannel.EMAIL] })];

      const count = await sweeper.requeueStrandedMessages('EMAIL');

      // If this ever starts settling rows to DELIVERED the way the push leg does, every stranded
      // email on the deployment is marked delivered without being sent.
      expect(count).toBe(1);
      expect(updates).toEqual([]);
    });

    it('stops at the first failure, for the same reason the push leg does', async () => {
      found = [row({ id: 'n-e1' }), row({ id: 'n-e2' })];
      queueAdd.mockRejectedValue(new Error('ECONNREFUSED'));

      expect(await sweeper.requeueStrandedMessages('EMAIL')).toBe(0);
      expect(queueAdd).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The text leg of the same guarantee, through the same parameterised method. A text whose enqueue
   * missed Redis is otherwise PENDING for ever — and, exactly as for email, an IN_APP+SMS row is born
   * DELIVERED, so only `sms_status` knows a text is still owed.
   */
  describe('requeueStrandedMessages — the text leg', () => {
    it('selects on smsStatus alone and re-queues deliver-sms on the same retry and retention terms', async () => {
      found = [row({ id: 'n-s1', status: NotificationStatus.DELIVERED, emailStatus: null, smsStatus: NotificationStatus.PENDING })];

      const count = await sweeper.requeueStrandedMessages('SMS');

      const { where } = find.mock.calls[0][0];
      expect(where.smsStatus).toBe(NotificationStatus.PENDING);
      // Not the email column, not the push column: a stranded email must not be re-queued as a text.
      expect(where.emailStatus).toBeUndefined();
      expect(where.status).toBeUndefined();
      expect(count).toBe(1);
      expect(queueAdd).toHaveBeenCalledWith(
        'deliver-sms',
        { notificationId: 'n-s1' },
        { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: FAILED_JOB_RETENTION },
      );
    });

    it('never re-queues a text as an email, nor an email as a text', async () => {
      found = [row({ id: 'n-e1' })];
      await sweeper.requeueStrandedMessages('EMAIL');
      found = [row({ id: 'n-s1' })];
      await sweeper.requeueStrandedMessages('SMS');

      expect(queued).toEqual([
        { name: 'deliver-email', data: { notificationId: 'n-e1' } },
        { name: 'deliver-sms', data: { notificationId: 'n-s1' } },
      ]);
    });

    it('stops at the first failure, for the same reason the other legs do', async () => {
      found = [row({ id: 'n-s1' }), row({ id: 'n-s2' })];
      queueAdd.mockRejectedValue(new Error('ECONNREFUSED'));

      expect(await sweeper.requeueStrandedMessages('SMS')).toBe(0);
      expect(queueAdd).toHaveBeenCalledTimes(1);
    });
  });

  describe('failAbandonedSends', () => {
    /**
     * SENT is a claim, not an outcome: the row is flipped to SENT immediately before the provider
     * call so that two jobs cannot send the same message. A process killed mid-call leaves it
     * there, and SENT reads as success on every screen. Without this, a notification nobody ever
     * received is indistinguishable from one that arrived.
     *
     * For the email leg, SENT means "with the mail queue", and the mail queue's own sweep settles
     * everything it holds and writes the outcome back. What is left for this rescue is only the
     * email that never reached the queue: claimed, and then the process died before the hand-off.
     */
    it('marks a push send abandoned after an hour, with a reason a human can read', async () => {
      affectedQueue = [3, 0];

      const count = await sweeper.failAbandonedSends();

      expect(count).toBe(3);
      const push = builderCalls[0];
      expect(push.set.status).toBe(NotificationStatus.FAILED);
      expect(push.set.failedAt).toBeInstanceOf(Date);
      expect(push.set.failureReason).toContain('did not complete');
      expect(push.where.map((w: any) => w.clause)).toEqual([
        'status = :sent',
        'sent_at < :cutoff',
      ]);
    });

    /**
     * `emailed_at`, not `updated_at`, and the comment in the method says what went wrong before:
     * `updated_at` is bumped by every write to the row — including the push settle two statements
     * earlier in the same sweep — so keying off it let an unrelated write reset the clock and hide
     * a stranded email for another full hour, repeatedly.
     */
    it('keys the email rescue off emailed_at, so an unrelated write cannot hide a stranded send', async () => {
      affectedQueue = [0, 2];

      const count = await sweeper.failAbandonedSends();

      expect(count).toBe(2);
      const email = builderCalls[1];
      expect(email.where.map((w: any) => w.clause).slice(0, 2)).toEqual([
        'email_status = :sent',
        'emailed_at < :cutoff',
      ]);
      expect(email.set.emailStatus).toBe(NotificationStatus.FAILED);
      expect(email.set.emailFailureReason).toMatch(/email never reached the message queue/);
      // The push leg's `status` must not be touched here: an email that never sent says nothing
      // about whether the push did.
      expect(email.set.status).toBeUndefined();
    });

    /**
     * The one thing that stops this rescue from lying. An email the mail queue holds may be waiting
     * out a retry for hours, or already sent and about to be written back; failing it here would
     * record a delivered email as failed. Only a notification with no email row at all is this
     * sweep's to settle.
     */
    it('leaves alone every email the mail queue has a row for — that queue settles those', async () => {
      affectedQueue = [0, 0];

      await sweeper.failAbandonedSends();

      const email = builderCalls[1];
      const guard = email.where[2];
      expect(guard.clause).toMatch(/^NOT EXISTS \(SELECT 1 FROM outbound_messages o WHERE o\.channel = :channel AND o\.entity_type = :entityType AND o\.entity_id = "notifications"\."id"::text\)$/);
      expect(guard.params).toEqual({ channel: 'EMAIL', entityType: 'NOTIFICATION' });
    });

    it('uses an hour’s cutoff — far longer than any provider round trip', async () => {
      affectedQueue = [0, 0];
      const before = Date.now();

      await sweeper.failAbandonedSends();

      const cutoff: Date = builderCalls[0].where[1].params.cutoff;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 60 * 60_000 - 50);
      expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - 60 * 60_000 + 50);
    });

    /**
     * The text leg's rescue: claimed SENT, then the process died before `SmsService.queue` wrote
     * its row. It keys off `texted_at` for the reason email keys off `emailed_at`, and its guard
     * looks only for a message row of ITS channel — an email row for the same notification says
     * nothing about whether the text reached the queue.
     */
    it('rescues a text that never reached the message queue, on the SMS columns only', async () => {
      affectedQueue = [0, 0, 2];

      const count = await sweeper.failAbandonedSends();

      expect(count).toBe(2);
      const sms = builderCalls[2];
      expect(sms.where.map((w: any) => w.clause).slice(0, 2)).toEqual([
        'sms_status = :sent',
        'texted_at < :cutoff',
      ]);
      expect(sms.where[2].clause).toMatch(/FROM outbound_messages o WHERE o\.channel = :channel AND/);
      expect(sms.where[2].params).toEqual({ channel: 'SMS', entityType: 'NOTIFICATION' });
      expect(sms.set).toEqual({
        smsStatus: NotificationStatus.FAILED,
        smsFailureReason: expect.stringMatching(/text never reached the message queue/),
      });
    });

    it('reports every leg added together, so one sweep gives one number', async () => {
      affectedQueue = [4, 5, 6];

      expect(await sweeper.failAbandonedSends()).toBe(15);
    });

    it('survives a driver that reports no affected count', async () => {
      affectedQueue = [];

      // `result.affected` is optional on TypeORM's UpdateResult and is undefined on some drivers.
      // `?? 0` is the guard; without it this returns NaN and the log line reads "Marked NaN".
      expect(await sweeper.failAbandonedSends()).toBe(0);
    });
  });
});
