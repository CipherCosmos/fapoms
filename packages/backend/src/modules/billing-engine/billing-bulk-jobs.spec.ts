import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PaymentMethod } from '@fapoms/shared';
import { BillingBulkJobsService } from './billing-bulk-jobs.service';
import { BillingBulkJobsWorker } from './billing-bulk-jobs.worker';
import { BILLING_BULK_JOB, BILLING_BULK_JOB_OPTIONS, BILLING_BULK_MAX_PAYOUTS } from './billing-bulk-jobs.contract';
import { BillingEngineController } from './billing-engine.controller';
import { FAILED_JOB_RETENTION } from '../../infrastructure/queue/queued-job';
import { getRequestContext } from '../../core/context/request-context';
import { tenantFilterId } from '../../infrastructure/tenancy/ambient-tenant-context';

/**
 * BILLING BULK WRITES RUN IN THE BACKGROUND, ONCE, AS THE PERSON WHO STARTED THEM.
 *
 * Approving or paying a selection of payouts, and the invite-all assayer invoice round, ran one
 * transaction per row inside the HTTP request. At realistic sizes that outlived the web client's
 * 30 s: the screen reported a failure while the server kept writing money state, and a second press
 * started the same writes again. These pin what makes the move safe: the request still refuses what
 * it always refused and otherwise only accepts; a repeat press joins the run already going; the run
 * is never retried or restarted; one run at a time; and it runs as — and is readable only by — the
 * person who pressed the button.
 */

const ACTOR = { userId: 'fin-1', roleNames: ['OPERATIONS'], organizationId: 'org-1', displayName: 'Meera' };
const IDS = [
  '3c0f2a1e-6b1d-4c7e-9a52-0d4b8e2f7a13',
  '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
  '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e',
];
const SORTED = [...IDS].sort();
const PAYMENT = { paymentReference: 'UTR-9', method: PaymentMethod.NEFT };

function queueWith(jobs: any[] = []) {
  let n = 0;
  return {
    add: jest.fn(async (name: string, data: any) => {
      const job = { id: String(++n), name, data };
      jobs.push(job);
      return job;
    }),
    getJobs: jest.fn(async () => jobs),
    getJob: jest.fn(async (id: string) => jobs.find((j) => j.id === id) ?? null),
  };
}

describe('BillingBulkJobsService', () => {
  it('accepts an approval run and returns a job id instead of approving anything', async () => {
    const queue = queueWith();
    const service = new BillingBulkJobsService(queue as any);

    const result = await service.enqueueApprovePayouts([...IDS, IDS[0]], ACTOR);

    expect(result).toEqual({ jobId: '1', deduplicated: false });
    expect(queue.add).toHaveBeenCalledWith(
      BILLING_BULK_JOB.APPROVE_PAYOUTS,
      expect.objectContaining({ payableIds: SORTED, requestedBy: 'fin-1', actor: ACTOR }),
      BILLING_BULK_JOB_OPTIONS,
    );
  });

  it('joins the approval run already going when the same person presses again, whatever the order', async () => {
    const queue = queueWith();
    const service = new BillingBulkJobsService(queue as any);

    const first = await service.enqueueApprovePayouts(IDS, ACTOR);
    const second = await service.enqueueApprovePayouts([...IDS].reverse(), ACTOR);

    expect(second).toEqual({ jobId: first.jobId, deduplicated: true });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  /**
   * The run is readable only by whoever started it, so joining somebody else's would hand the
   * second person a job id that answers them 404 — their press would appear to do nothing.
   */
  it("does not fold one person's press into another person's run over the same payouts", async () => {
    const queue = queueWith();
    const service = new BillingBulkJobsService(queue as any);

    const mine = await service.enqueueApprovePayouts(IDS, ACTOR);
    const theirs = await service.enqueueApprovePayouts(IDS, { ...ACTOR, userId: 'fin-2' });

    expect(theirs.deduplicated).toBe(false);
    expect(theirs.jobId).not.toBe(mine.jobId);
    expect(queue.add.mock.calls[1][1]).toMatchObject({ requestedBy: 'fin-2' });
  });

  it('does not let an approval press join a payment run over the same payouts', async () => {
    const queue = queueWith();
    const service = new BillingBulkJobsService(queue as any);

    await service.enqueuePayPayouts(IDS, PAYMENT, ACTOR);
    const approve = await service.enqueueApprovePayouts(IDS, ACTOR);

    expect(approve.deduplicated).toBe(false);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('joins a payment run under the same bank reference, but treats a different reference as its own instruction', async () => {
    const queue = queueWith();
    const service = new BillingBulkJobsService(queue as any);

    const first = await service.enqueuePayPayouts(IDS, PAYMENT, ACTOR);
    const again = await service.enqueuePayPayouts([...IDS].reverse(), { ...PAYMENT }, ACTOR);
    const other = await service.enqueuePayPayouts(IDS, { ...PAYMENT, paymentReference: 'UTR-10' }, ACTOR);

    expect(again).toEqual({ jobId: first.jobId, deduplicated: true });
    expect(other.deduplicated).toBe(false);
    expect(queue.add.mock.calls[0][1]).toMatchObject({ payableIds: SORTED, payment: PAYMENT });
  });

  it("joins the invite-all round already going for the same person and scope, but not one under a different scope", async () => {
    const queue = queueWith();
    const service = new BillingBulkJobsService(queue as any);

    const first = await service.enqueueInviteAllAssayerInvoices({ regions: ['NORTH'] } as any, ACTOR);
    const again = await service.enqueueInviteAllAssayerInvoices({ regions: ['NORTH'] } as any, ACTOR);
    const wider = await service.enqueueInviteAllAssayerInvoices(undefined, ACTOR);

    expect(again).toEqual({ jobId: first.jobId, deduplicated: true });
    expect(wider.deduplicated).toBe(false);
    // The ceiling resolved in the request travels with the job — the worker narrows the round to it.
    expect(queue.add.mock.calls[0][1]).toMatchObject({ scope: { regions: ['NORTH'] }, requestedBy: 'fin-1' });
    expect(queue.add.mock.calls[1][1]).toMatchObject({ scope: null });
  });

  it('never retries a run, and keeps what it finished and what failed for a bounded time', () => {
    // A retry walks the batch again from the top: re-approving, re-paying, re-inviting.
    expect(BILLING_BULK_JOB_OPTIONS.attempts).toBe(1);
    expect(BILLING_BULK_JOB_OPTIONS.removeOnFail).toBe(FAILED_JOB_RETENTION);
    expect(BILLING_BULK_JOB_OPTIONS.removeOnComplete).toEqual({ age: expect.any(Number), count: expect.any(Number) });
    expect(BILLING_BULK_JOB_OPTIONS.timeout).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('answers 404 to anybody but the person who started the run, and the result to them', async () => {
    const queue = queueWith();
    const service = new BillingBulkJobsService(queue as any);
    const { jobId } = await service.enqueueApprovePayouts(IDS, ACTOR);
    const job = (await queue.getJob(jobId)) as any;
    Object.assign(job, {
      getState: async () => 'completed', progress: () => 100, returnvalue: { done: SORTED, refused: [] },
      timestamp: Date.now(), processedOn: Date.now(), finishedOn: Date.now(),
    });

    await expect(service.status(jobId, 'fin-2')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.status(jobId, undefined)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.status(jobId, 'fin-1')).resolves.toMatchObject({ state: 'done', result: { done: SORTED, refused: [] } });
  });
});

describe('BillingBulkJobsWorker', () => {
  /** What the batch sees of who is running it — the org it is scoped to and the roles it holds. */
  const scopeSeen = () => {
    const ctx = getRequestContext();
    return { org: tenantFilterId(), userId: ctx?.userId, roleNames: ctx?.roleNames, displayName: ctx?.displayName };
  };
  const SCOPE = { org: 'org-1', userId: 'fin-1', roleNames: ['OPERATIONS'], displayName: 'Meera' };
  const jobOf = (name: string, data: any) => ({ id: '9', name, data, progress: jest.fn(async () => undefined) }) as any;

  it("approves inside the requester's scope, as the requester, and reports each payout's progress to the poller", async () => {
    let seen: ReturnType<typeof scopeSeen> | null = null;
    const billing = {
      approvePayouts: jest.fn(async (_ids: string[], _user: string, onProgress: any, _reason?: string) => {
        seen = scopeSeen();
        await onProgress(1, 2, 'Approving payouts');
        return { done: ['a'], refused: [] };
      }),
    };
    const worker = new BillingBulkJobsWorker(billing as any, {} as any);
    const job = jobOf(BILLING_BULK_JOB.APPROVE_PAYOUTS, { payableIds: SORTED, actor: ACTOR });

    const result = await worker.run(job);

    expect(result).toEqual({ done: ['a'], refused: [] });
    expect(billing.approvePayouts).toHaveBeenCalledWith(SORTED, 'fin-1', expect.any(Function), undefined);
    // Outside a request a background job is unscoped; this one must not be.
    expect(seen).toEqual(SCOPE);
    expect(tenantFilterId()).toBeNull();
    expect(job.progress).toHaveBeenCalledWith({ percent: 50, stage: 'Approving payouts (1/2)' });
  });

  /** The queue's other half: what the payload carries, the worker must pass on. */
  it('passes the without-a-bill reason from the job payload to the approval', async () => {
    const billing = { approvePayouts: jest.fn(async () => ({ done: ['a'], refused: [] })) };
    const worker = new BillingBulkJobsWorker(billing as any, {} as any);

    await worker.run(jobOf(BILLING_BULK_JOB.APPROVE_PAYOUTS, {
      payableIds: SORTED, actor: ACTOR, reason: 'Assayer has left; settling final dues',
    }));

    expect(billing.approvePayouts).toHaveBeenCalledWith(
      SORTED, 'fin-1', expect.any(Function), 'Assayer has left; settling final dues',
    );
  });

  it("pays with the payment details from the request, inside the requester's scope", async () => {
    let seen: ReturnType<typeof scopeSeen> | null = null;
    const billing = { payPayouts: jest.fn(async () => { seen = scopeSeen(); return { done: [], refused: [] }; }) };
    const worker = new BillingBulkJobsWorker(billing as any, {} as any);

    await worker.run(jobOf(BILLING_BULK_JOB.PAY_PAYOUTS, { payableIds: SORTED, payment: PAYMENT, actor: ACTOR }));

    expect(billing.payPayouts).toHaveBeenCalledWith(SORTED, PAYMENT, 'fin-1', expect.any(Function));
    expect(seen).toEqual(SCOPE);
  });

  it('runs the invite-all round under the scope captured at the request, after re-checking the rollout gate', async () => {
    let seen: ReturnType<typeof scopeSeen> | null = null;
    const order: string[] = [];
    const invoices = {
      assertEnabled: jest.fn(async () => { order.push('gate'); }),
      inviteAll: jest.fn(async () => { order.push('round'); seen = scopeSeen(); return { outcomes: [], invited: 0, skipped: 0 }; }),
    };
    const worker = new BillingBulkJobsWorker({} as any, invoices as any);

    await worker.run(jobOf(BILLING_BULK_JOB.INVITE_ALL_ASSAYER_INVOICES, { scope: { regions: ['NORTH'] }, actor: ACTOR }));

    expect(order).toEqual(['gate', 'round']);
    expect(invoices.inviteAll).toHaveBeenCalledWith('fin-1', { regions: ['NORTH'] }, expect.any(Function));
    expect(seen).toEqual(SCOPE);
  });

  /** A round that waited behind another must not start money reveals after the feature went dark. */
  it('starts no invitations when the feature was switched off while the round waited', async () => {
    const invoices = {
      assertEnabled: jest.fn(async () => { throw new NotFoundException('Assayer invoicing is not enabled on this deployment.'); }),
      inviteAll: jest.fn(),
    };
    const worker = new BillingBulkJobsWorker({} as any, invoices as any);

    await expect(worker.run(jobOf(BILLING_BULK_JOB.INVITE_ALL_ASSAYER_INVOICES, { scope: null, actor: ACTOR })))
      .rejects.toThrow(/not enabled/);
    expect(invoices.inviteAll).not.toHaveBeenCalled();
  });

  /**
   * Tenant scoping reads every role, not the first: a cross-tenant role anywhere in the list is
   * what widens the lookup. A context carrying only the first would confine this ADMIN to one
   * organisation in the background while the same press in the request reached every one.
   */
  it('gives a principal whose ADMIN role is not listed first the same reach it had in the request', async () => {
    let org: string | null | undefined = 'unset';
    const billing = { approvePayouts: jest.fn(async () => { org = tenantFilterId(); return { done: [], refused: [] }; }) };
    const worker = new BillingBulkJobsWorker(billing as any, {} as any);

    await worker.run(jobOf(BILLING_BULK_JOB.APPROVE_PAYOUTS, { payableIds: SORTED, actor: { ...ACTOR, roleNames: ['OPERATIONS', 'ADMIN'] } }));

    expect(org).toBeNull();
  });

  it('refuses a job name it does not know rather than completing it silently', async () => {
    const worker = new BillingBulkJobsWorker({} as any, {} as any);
    await expect(worker.run(jobOf('mystery', {}))).rejects.toThrow(/No handler/);
  });
});

describe('one billing bulk run at a time', () => {
  const stripped = (file: string) => readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /**
   * Bull's loops are per queue and take jobs of any name. Three `@Process` handlers at concurrency
   * 1 would be three loops, so an approval run and a payment run over the same payouts could overlap.
   */
  it('has exactly one processing loop on the queue', () => {
    const handlers = [...stripped('billing-bulk-jobs.worker.ts').matchAll(/@Process\(([^)]*)\)/g)].map((m) => m[1]);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatch(/name:\s*'\*'/);
    expect(handlers[0]).toMatch(/concurrency:\s*1\b/);
  });

  /** `attempts: 1` does not stop Bull re-running a job whose worker died; this setting does. */
  it('fails a run whose worker died instead of restarting it and re-approving, re-paying or re-inviting', () => {
    const module = stripped('billing-engine.module.ts');
    const registration = module.slice(module.indexOf('name: BILLING_BULK_QUEUE'));
    expect(registration.slice(0, registration.indexOf('})'))).toMatch(/maxStalledCount:\s*0\b/);
  });

  it('is not a handler on the billing-jobs queue, whose loops completion booking needs', () => {
    expect(stripped('billing-bulk-jobs.worker.ts')).toMatch(/@Processor\(BILLING_BULK_QUEUE\)/);
    expect(stripped('billing-bulk-jobs.contract.ts')).toMatch(/BILLING_BULK_QUEUE = 'billing-bulk-jobs'/);
  });
});

describe('the billing bulk routes', () => {
  const REQ = { user: { id: 'fin-1', roles: [{ name: 'OPERATIONS' }], organizationId: 'org-1', displayName: 'Meera' } };
  const SCOPE = { regions: ['NORTH'] } as any;

  const harness = () => {
    const service = { approvePayouts: jest.fn(), payPayouts: jest.fn() };
    const assayerInvoices = { assertEnabled: jest.fn(async () => undefined), inviteAll: jest.fn(), invite: jest.fn() };
    const regionGuard = { assertPayablesInScope: jest.fn(async () => undefined), assertAssayerInScope: jest.fn(async () => undefined) };
    const bulkJobs = {
      enqueueApprovePayouts: jest.fn(async () => ({ jobId: '1', deduplicated: false })),
      enqueuePayPayouts: jest.fn(async () => ({ jobId: '2', deduplicated: false })),
      enqueueInviteAllAssayerInvoices: jest.fn(async () => ({ jobId: '3', deduplicated: false })),
      status: jest.fn(async () => ({ state: 'running' })),
    };
    const controller = new BillingEngineController(
      service as any, assayerInvoices as any, {} as any, regionGuard as any, bulkJobs as any,
    );
    return { controller, service, assayerInvoices, regionGuard, bulkJobs };
  };

  it('queues an approval run instead of approving inside the request', async () => {
    const h = harness();

    const answer = await h.controller.approvePayouts({ payableIds: IDS } as any, REQ, SCOPE);

    expect(answer).toEqual({ jobId: '1', deduplicated: false });
    expect(h.service.approvePayouts).not.toHaveBeenCalled();
    expect(h.regionGuard.assertPayablesInScope).toHaveBeenCalledWith(IDS, SCOPE);
    expect(h.bulkJobs.enqueueApprovePayouts).toHaveBeenCalledWith(IDS, expect.objectContaining({ userId: 'fin-1', roleNames: ['OPERATIONS'] }), undefined);
  });

  /**
   * Approving a payout the assayer never confirmed is the exception the desk is allowed, and the
   * reason for it has to survive the hop onto the queue — the run happens minutes later, in
   * another process, and whatever is not carried in the job payload is gone by then. Without
   * this the reason was collected by the dialog and dropped at the controller, which is worse
   * than never asking: it looks recorded and is not.
   */
  it('carries the without-a-bill reason from the request onto the queued run', async () => {
    const h = harness();

    await h.controller.approvePayouts(
      { payableIds: IDS, reason: 'Assayer has no smartphone' } as any, REQ, SCOPE,
    );

    expect(h.bulkJobs.enqueueApprovePayouts).toHaveBeenCalledWith(
      IDS, expect.anything(), 'Assayer has no smartphone',
    );
  });

  it('queues a payment run with the payment details, instead of paying inside the request', async () => {
    const h = harness();

    await h.controller.payPayouts({ payableIds: IDS, ...PAYMENT } as any, REQ, SCOPE);

    expect(h.service.payPayouts).not.toHaveBeenCalled();
    expect(h.bulkJobs.enqueuePayPayouts).toHaveBeenCalledWith(IDS, PAYMENT, expect.objectContaining({ userId: 'fin-1' }));
  });

  it('still refuses a batch with an out-of-region payout in the request, queueing nothing', async () => {
    const h = harness();
    h.regionGuard.assertPayablesInScope.mockRejectedValue(new ForbiddenException('outside your region'));

    await expect(h.controller.approvePayouts({ payableIds: IDS } as any, REQ, SCOPE)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.controller.payPayouts({ payableIds: IDS, ...PAYMENT } as any, REQ, SCOPE)).rejects.toBeInstanceOf(ForbiddenException);

    expect(h.bulkJobs.enqueueApprovePayouts).not.toHaveBeenCalled();
    expect(h.bulkJobs.enqueuePayPayouts).not.toHaveBeenCalled();
  });

  it('queues the invite-all round with the caller’s scope, instead of inviting inside the request', async () => {
    const h = harness();

    const answer = await h.controller.inviteAllAssayerInvoices(REQ, SCOPE);

    expect(answer).toEqual({ jobId: '3', deduplicated: false });
    expect(h.assayerInvoices.inviteAll).not.toHaveBeenCalled();
    expect(h.bulkJobs.enqueueInviteAllAssayerInvoices).toHaveBeenCalledWith(SCOPE, expect.objectContaining({ userId: 'fin-1' }));
  });

  it('still answers "not enabled" in the request while the feature is dark, queueing nothing', async () => {
    const h = harness();
    h.assayerInvoices.assertEnabled.mockRejectedValue(new NotFoundException('Assayer invoicing is not enabled on this deployment.'));

    await expect(h.controller.inviteAllAssayerInvoices(REQ, SCOPE)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.bulkJobs.enqueueInviteAllAssayerInvoices).not.toHaveBeenCalled();
  });

  it('asks for a run by the id of the person polling, never one the client names', async () => {
    const h = harness();
    await h.controller.bulkJobStatus('7', REQ);
    expect(h.bulkJobs.status).toHaveBeenCalledWith('7', 'fin-1');
  });

  it('answers 202 on the three queued routes', () => {
    const accepted = (method: string) =>
      Reflect.getMetadata('__httpCode__', (BillingEngineController.prototype as any)[method]);
    expect(accepted('approvePayouts')).toBe(202);
    expect(accepted('payPayouts')).toBe(202);
    expect(accepted('inviteAllAssayerInvoices')).toBe(202);
  });

  describe('request validation, through the real pipe', () => {
    // Same options as the global pipe in main.ts.
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const bodyType = (method: string) =>
      Reflect.getMetadata('design:paramtypes', BillingEngineController.prototype, method)?.[0];
    const ids = (n: number) => Array.from({ length: n }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

    /** One queued run is sized for 500; a bigger batch is a 400 now, not a timed-out run later. */
    it.each(['approvePayouts', 'payPayouts', 'payoutBankFile'])('%s refuses more payouts than one run takes', async (method) => {
      const extra = method === 'payPayouts' ? PAYMENT : {};
      await expect(pipe.transform({ payableIds: ids(BILLING_BULK_MAX_PAYOUTS), ...extra }, { type: 'body', metatype: bodyType(method) } as never))
        .resolves.toBeDefined();
      await expect(pipe.transform({ payableIds: ids(BILLING_BULK_MAX_PAYOUTS + 1), ...extra }, { type: 'body', metatype: bodyType(method) } as never))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    /** The round has its own route; the old spelling must not quietly become a single invite. */
    it('refuses the old {all: true} body on the single-assayer invite route', async () => {
      await expect(pipe.transform({ all: true }, { type: 'body', metatype: bodyType('inviteAssayerInvoices') } as never))
        .rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
