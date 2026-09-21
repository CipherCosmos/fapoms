import { NotFoundException } from '@nestjs/common';
import { NotificationStatus } from '@fapoms/shared';
import { EMAIL_NOT_SET_UP_REASON, OutboundMessageService, OUTBOUND_MESSAGE_JOB } from './outbound-message.service';
import { NotificationEntity } from './notification.entity';
import { OutboundEmailWorker } from './outbound-email.worker';
import { OutboundMessageEntity } from './outbound-message.entity';
import { __resetKeyCacheForTests } from '../../infrastructure/security/field-encryption';

/**
 * EMAILS LEAVE THE REQUEST, AND THE SCREEN STILL KNOWS WHETHER THEY WENT.
 *
 * Before this an invite was sent inside the request that asked for it (4.95 s measured for one
 * interview), and a bulk credential run held one request for up to half an hour. These pin the
 * three promises that make moving it safe: the request never waits on or fails because of the mail
 * server; a credential in the message is never readable at rest nor in Redis; and every recorded
 * email ends SENT or FAILED with a reason, never "queued" for ever.
 */

const SECRET_LINK = 'https://fapoms.example/register/9f8e7d6c5b4a39281706f5e4d3c2b1a0';

function makeRepo() {
  const rows = new Map<string, OutboundMessageEntity>();
  let n = 0;
  return {
    rows,
    create: jest.fn((v: any) => ({ ...v })),
    save: jest.fn(async (v: any) => {
      const row = { ...v, id: v.id ?? `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
      rows.set(row.id, row);
      return row;
    }),
    findOne: jest.fn(async ({ where: { id } }: any) => rows.get(id) ?? null),
    find: jest.fn(async () => [...rows.values()]),
    update: jest.fn(async (criteria: any, patch: any) => {
      const row = rows.get(criteria.id);
      if (row && (!criteria.status || row.status === criteria.status)) Object.assign(row, patch);
    }),
    createQueryBuilder: jest.fn(),
  };
}

describe('OutboundMessageService.enqueue', () => {
  const savedKey = process.env.PII_ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.PII_ENCRYPTION_KEY = 'a'.repeat(64);
    __resetKeyCacheForTests();
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
    else process.env.PII_ENCRYPTION_KEY = savedKey;
    __resetKeyCacheForTests();
  });

  const request = {
    channel: 'EMAIL' as const,
    kind: 'REGISTRATION_INVITE' as const,
    to: 'candidate@example.com',
    subject: 'Your registration link',
    text: `Open ${SECRET_LINK}`,
    html: `<a href="${SECRET_LINK}">Open</a>`,
    entityType: 'ASSAYER_APPLICATION',
    entityId: 'app-1',
    requestedBy: 'desk-user',
  };

  it('answers at once with a receipt, having handed the sending to the queue', async () => {
    const repo = makeRepo();
    const queue = { add: jest.fn(async () => ({})) };
    const service = new OutboundMessageService(repo as any, queue as any, {} as any, {} as any);

    const receipt = await service.enqueue(request);

    expect(receipt).toMatchObject({ status: 'QUEUED', to: 'candidate@example.com' });
    expect(receipt.id).toBeTruthy();
    expect(queue.add).toHaveBeenCalledWith(
      OUTBOUND_MESSAGE_JOB,
      { outboundMessageId: receipt.id },
      expect.objectContaining({ jobId: `outbound-message:${receipt.id}`, attempts: 5 }),
    );
  });

  it('never puts the message — which may be a working link or a password — in Redis or readable in the table', async () => {
    const repo = makeRepo();
    const queue = { add: jest.fn(async () => ({})) };
    const service = new OutboundMessageService(repo as any, queue as any, {} as any, {} as any);

    const receipt = await service.enqueue(request);
    const stored = repo.rows.get(receipt.id!)!;

    expect(JSON.stringify(queue.add.mock.calls)).not.toContain('9f8e7d6c5b4a');
    expect(stored.payload).toMatch(/^enc:v1:/);
    expect(stored.payload).not.toContain('9f8e7d6c5b4a');
    expect(OutboundMessageService.open(stored)).toMatchObject({ to: 'candidate@example.com', text: `Open ${SECRET_LINK}` });
  });

  it('still records the email when Redis is down, for the sweep to queue later — and does not throw', async () => {
    const repo = makeRepo();
    const queue = { add: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) };
    const service = new OutboundMessageService(repo as any, queue as any, {} as any, {} as any);

    const receipt = await service.enqueue(request);

    expect(receipt.status).toBe('QUEUED');
    expect(repo.rows.get(receipt.id!)?.status).toBe('QUEUED');
  });

  it('says NOT_QUEUED rather than throwing when the row cannot be written, so the action that wanted it stands', async () => {
    const repo = makeRepo();
    repo.save.mockRejectedValueOnce(new Error('connection terminated'));
    const queue = { add: jest.fn() };
    const service = new OutboundMessageService(repo as any, queue as any, {} as any, {} as any);

    const receipt = await service.enqueue(request);

    expect(receipt).toMatchObject({ id: null, status: 'NOT_QUEUED', to: 'candidate@example.com' });
    expect(receipt.error).toBeTruthy();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('records nothing for an empty address', async () => {
    const repo = makeRepo();
    const service = new OutboundMessageService(repo as any, { add: jest.fn() } as any, {} as any, {} as any);

    const receipt = await service.enqueue({ ...request, to: '   ' });

    expect(receipt.status).toBe('NOT_QUEUED');
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('OutboundMessageService.receiptFor', () => {
  const row = (over: Partial<OutboundMessageEntity> = {}): OutboundMessageEntity => ({
    id: 'e1', channel: 'EMAIL', kind: 'ACCOUNT_SETUP_LINK', status: 'FAILED', recipient: 'x@example.com', subject: 's',
    payload: null, attempts: 5, lastError: 'Email is not set up on this system, so it was not sent.',
    entityType: null, entityId: null, requestedBy: 'owner', createdAt: new Date(), updatedAt: new Date(),
    sentAt: null, failedAt: new Date(), ...over,
  });

  it("answers the person who asked for it, with the reason it failed", async () => {
    const repo = makeRepo();
    repo.rows.set('e1', row());
    const service = new OutboundMessageService(repo as any, {} as any, {} as any, {} as any);

    await expect(service.receiptFor('e1', { id: 'owner', isAdmin: false })).resolves.toMatchObject({
      status: 'FAILED', error: 'Email is not set up on this system, so it was not sent.',
    });
  });

  it("answers 404 — not 403 — for somebody else's email, and lets an administrator read it", async () => {
    const repo = makeRepo();
    repo.rows.set('e1', row());
    const service = new OutboundMessageService(repo as any, {} as any, {} as any, {} as any);

    await expect(service.receiptFor('e1', { id: 'someone-else', isAdmin: false })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.receiptFor('e1', { id: 'someone-else', isAdmin: true })).resolves.toMatchObject({ id: 'e1' });
  });

  it("leaves somebody else's emails out of a batch read, and gives an administrator all of them", async () => {
    const repo = makeRepo();
    repo.rows.set('mine', row({ id: 'mine', requestedBy: 'owner' }));
    repo.rows.set('theirs', row({ id: 'theirs', requestedBy: 'someone-else' }));
    repo.rows.set('nobodys', row({ id: 'nobodys', requestedBy: null }));
    const service = new OutboundMessageService(repo as any, {} as any, {} as any, {} as any);

    const asOwner = await service.receiptsFor(['mine', 'theirs', 'nobodys'], { id: 'owner', isAdmin: false });
    const asAdmin = await service.receiptsFor(['mine', 'theirs', 'nobodys'], { id: 'admin', isAdmin: true });

    expect(asOwner.map((r) => r.id)).toEqual(['mine']);
    expect(asAdmin.map((r) => r.id).sort()).toEqual(['mine', 'nobodys', 'theirs']);
  });
});

/**
 * Records a query builder's terms so the WHERE clause is asserted, not merely run — the same
 * recorder `notification.sweeper.spec.ts` uses. A conditional UPDATE whose condition went missing
 * still "works" against a mock; only the recorded clause shows it.
 */
type BuilderCall = {
  op: 'update' | 'delete';
  target: any;
  set: any;
  where: Array<{ clause: string; params: any }>;
  returning: string[] | null;
  affected: number;
};
function builderRecorder() {
  const calls: BuilderCall[] = [];
  const affected: number[] = [];
  /** What each UPDATE … RETURNING hands back, in order — the rows it settled. */
  const returned: any[][] = [];
  const createQueryBuilder = jest.fn(() => {
    const call: BuilderCall = { op: 'update', target: null, set: null, where: [], returning: null, affected: 0 };
    const qb: any = {
      update: (target?: any) => { call.op = 'update'; call.target = target ?? null; return qb; },
      delete: () => { call.op = 'delete'; return qb; },
      from: () => qb,
      set: (patch: any) => { call.set = patch; return qb; },
      where: (clause: string, params: any) => { call.where.push({ clause, params }); return qb; },
      andWhere: (clause: string, params: any) => { call.where.push({ clause, params }); return qb; },
      returning: (columns: string[]) => { call.returning = columns; return qb; },
      execute: async () => {
        call.affected = affected.shift() ?? 0;
        calls.push(call);
        return { affected: call.affected, raw: call.returning ? (returned.shift() ?? []) : [] };
      },
    };
    return qb;
  });
  const whereOf = (call: BuilderCall) => Object.fromEntries(call.where.map((w) => [w.clause, w.params]));
  return { calls, affected, returned, createQueryBuilder, whereOf };
}

describe("OutboundMessageService — the worker's half", () => {
  const savedKey = process.env.PII_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.PII_ENCRYPTION_KEY = 'a'.repeat(64);
    __resetKeyCacheForTests();
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
    else process.env.PII_ENCRYPTION_KEY = savedKey;
    __resetKeyCacheForTests();
  });

  const request = {
    channel: 'EMAIL' as const,
    kind: 'ACCOUNT_SETUP_LINK' as const,
    to: 'staff@example.com',
    subject: 'Set your password',
    text: `Open ${SECRET_LINK}`,
    requestedBy: 'admin-1',
  };

  const queued = async () => {
    const repo = makeRepo();
    const recorder = builderRecorder();
    repo.createQueryBuilder = recorder.createQueryBuilder;
    const notifications = builderRecorder();
    const service = new OutboundMessageService(
      repo as any,
      { add: jest.fn(async () => ({})) } as any,
      { createQueryBuilder: notifications.createQueryBuilder } as any,
      {} as any,
    );
    const { id } = await service.enqueue(request);
    return { repo, recorder, notifications, service, id: id! };
  };

  it('claims only a row that is still QUEUED, in one conditional UPDATE, counting the attempt', async () => {
    const { service, recorder, id } = await queued();
    recorder.affected.push(1);

    const claimed = await service.claim(id);

    const [update] = recorder.calls;
    expect(recorder.whereOf(update)).toEqual({ 'id = :id': { id }, 'status = :queued': { queued: 'QUEUED' } });
    expect(update.set.status).toBe('SENDING');
    expect(typeof update.set.attempts).toBe('function');
    expect(update.set.attempts()).toBe('attempts + 1');
    expect(claimed?.message).toMatchObject({ to: 'staff@example.com', text: `Open ${SECRET_LINK}` });
  });

  it('hands back nothing when the conditional UPDATE matched no row — somebody else has it', async () => {
    const { service, repo, recorder, id } = await queued();
    recorder.affected.push(0);
    repo.findOne.mockClear();

    await expect(service.claim(id)).resolves.toBeNull();
    // Not even read: the message is opened only by the job that won the row.
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it.each([
    ['markSent', (s: OutboundMessageService, id: string) => s.markSent(id), 'SENT'],
    ['markFailed', (s: OutboundMessageService, id: string) => s.markFailed(id, 'refused'), 'FAILED'],
  ] as const)('%s erases the message, so a settled row no longer holds a working credential', async (_name, settle, status) => {
    const { service, repo, recorder, id } = await queued();
    expect(repo.rows.get(id)!.payload).toMatch(/^enc:v1:/);

    await settle(service, id);

    const [update] = recorder.calls;
    expect(recorder.whereOf(update)).toEqual({ 'id = :id': { id } });
    expect(update.set.status).toBe(status);
    expect(update.set.payload).toBeNull();
    expect(JSON.stringify(update.set)).not.toContain('9f8e7d6c5b4a');
  });

  it('releases only a row it is still SENDING — never resurrects one the sweep has already settled', async () => {
    const { service, repo, id } = await queued();
    Object.assign(repo.rows.get(id)!, { status: 'FAILED', payload: null, lastError: 'abandoned' });

    await service.release(id, 'Greeting never received');

    expect(repo.rows.get(id)!.status).toBe('FAILED');
    expect(repo.update).toHaveBeenCalledWith({ id, status: 'SENDING' }, expect.objectContaining({ status: 'QUEUED' }));
  });
});

/**
 * A NOTIFICATION'S EMAIL ENDS WHERE ITS SEND ENDED.
 *
 * The notification worker no longer sends: it hands the message to this queue and marks the
 * notification's `email_status` SENT ("with the mail queue"). Unless every settle writes the outcome
 * back, a notification whose email went, bounced, or was never possible reads "with the mail queue"
 * for ever — so each settle is pinned here: the row it settled (RETURNING, not a second guess), the
 * outcome, and the SENT condition that keeps an already-settled notification's answer.
 */
describe('OutboundMessageService — writing the outcome back onto the notification', () => {
  const NOTIFICATION_ID = '4b3c2d1e-0f9a-4b8c-9d7e-6f5a4b3c2d1e';
  const setup = (returnedRows: any[]) => {
    const recorder = builderRecorder();
    recorder.affected.push(1);
    recorder.returned.push(returnedRows);
    const notifications = builderRecorder();
    const service = new OutboundMessageService(
      { createQueryBuilder: recorder.createQueryBuilder } as any,
      {} as any,
      { createQueryBuilder: notifications.createQueryBuilder } as any,
      {} as any,
    );
    return { service, recorder, notifications };
  };
  const notificationRow = [{ entity_type: 'NOTIFICATION', entity_id: NOTIFICATION_ID }];

  it('asks the settling UPDATE which record the email was for', async () => {
    const { service, recorder } = setup(notificationRow);
    await service.markSent('e1');
    expect(recorder.calls[0].returning).toEqual(['channel', 'entityType', 'entityId']);
  });

  it('SENT → the notification is DELIVERED, stamped, with no failure reason — only if still SENT', async () => {
    const { service, notifications } = setup(notificationRow);

    await service.markSent('e1');

    const [write] = notifications.calls;
    expect(write.target).toBe(NotificationEntity);
    expect(notifications.whereOf(write)).toEqual({
      'id IN (:...ids)': { ids: [NOTIFICATION_ID] },
      'email_status = :handedOff': { handedOff: NotificationStatus.SENT },
    });
    expect(write.set).toEqual({
      emailStatus: NotificationStatus.DELIVERED,
      emailedAt: expect.any(Date),
      emailFailureReason: null,
    });
  });

  it('FAILED → the notification is FAILED, with the reason the email failed', async () => {
    const { service, notifications } = setup(notificationRow);

    await service.markFailed('e1', 'The mail server refused it: 550 no such user.');

    const [write] = notifications.calls;
    expect(write.set).toEqual({
      emailStatus: NotificationStatus.FAILED,
      emailFailureReason: 'The mail server refused it: 550 no such user.',
    });
    expect(notifications.whereOf(write)['email_status = :handedOff']).toEqual({ handedOff: NotificationStatus.SENT });
  });

  it('"email is not set up" → the notification is SUPPRESSED, not FAILED, as it always has been', async () => {
    const { service, notifications } = setup(notificationRow);

    await service.markFailed('e1', EMAIL_NOT_SET_UP_REASON, { notSetUp: true });

    const [write] = notifications.calls;
    expect(write.set.emailStatus).toBe(NotificationStatus.SUPPRESSED);
    expect(write.set.emailFailureReason).toMatch(/not configured/);
  });

  it.each([
    ['an email that is not for a notification', [{ entity_type: 'ASSAYER_APPLICATION', entity_id: NOTIFICATION_ID }]],
    ['an email for no record at all', [{ entity_type: null, entity_id: null }]],
    ['a malformed notification id', [{ entity_type: 'NOTIFICATION', entity_id: 'not-a-uuid' }]],
    ['an update that matched no row', []],
  ])('writes nothing back for %s', async (_case, rows) => {
    const { service, notifications } = setup(rows);
    await service.markSent('e1');
    expect(notifications.calls).toHaveLength(0);
  });

  it('never throws when the write-back fails — the email\'s own outcome is already recorded', async () => {
    const recorder = builderRecorder();
    recorder.returned.push(notificationRow);
    const service = new OutboundMessageService(
      { createQueryBuilder: recorder.createQueryBuilder } as any,
      {} as any,
      { createQueryBuilder: () => { throw new Error('connection terminated'); } } as any,
      {} as any,
    );
    await expect(service.markSent('e1')).resolves.toBeUndefined();
  });

  it.each([
    ['gives up on a day-old queued email', 'status = :queued', /given up/],
    ['abandons a send whose worker is gone', 'status = :sending', /may not have arrived/],
  ])('the sweep writes FAILED back when it %s', async (_case, clause, reason) => {
    const recorder = builderRecorder();
    const notifications = builderRecorder();
    // The give-up UPDATE runs first, then the abandon UPDATE; each settles one notification's email.
    const expiredId = '11111111-1111-4111-8111-111111111111';
    const abandonedId = '22222222-2222-4222-8222-222222222222';
    recorder.returned.push(
      [{ entity_type: 'NOTIFICATION', entity_id: expiredId }],
      [{ entity_type: 'NOTIFICATION', entity_id: abandonedId }],
    );
    const service = new OutboundMessageService(
      { createQueryBuilder: recorder.createQueryBuilder, find: jest.fn(async () => []) } as any,
      {} as any,
      { createQueryBuilder: notifications.createQueryBuilder } as any,
      {} as any,
    );

    await service.sweep(Date.parse('2026-09-17T10:00:00Z'));

    const settle = recorder.calls.find((c) => c.where.some((w) => w.clause === clause))!;
    expect(settle.returning).toEqual(['channel', 'entityType', 'entityId']);
    const id = clause === 'status = :queued' ? expiredId : abandonedId;
    const write = notifications.calls.find((c) => notifications.whereOf(c)['id IN (:...ids)']?.ids?.includes(id))!;
    expect(write).toBeDefined();
    expect(write.set.emailStatus).toBe(NotificationStatus.FAILED);
    expect(write.set.emailFailureReason).toMatch(reason);
    expect(notifications.whereOf(write)['email_status = :handedOff']).toEqual({ handedOff: NotificationStatus.SENT });
  });
});

/**
 * A NOTIFICATION'S TEXT ENDS WHERE ITS SEND ENDED — ON ITS OWN COLUMNS.
 *
 * The text leg is written back by the same helper as the email leg, keyed by each settled row's
 * `channel`. The failure this pins is the cross-write: a helper that wrote whatever columns it was
 * built for would record a delivered email as a delivered text (or overwrite a text's FAILED with
 * an email's DELIVERED), and each leg's SENT guard would then refuse the real outcome when it came.
 */
describe('OutboundMessageService — writing a text\'s outcome back onto the notification', () => {
  const NOTIFICATION_ID = '4b3c2d1e-0f9a-4b8c-9d7e-6f5a4b3c2d1e';
  const setup = (returnedRows: any[]) => {
    const recorder = builderRecorder();
    recorder.affected.push(1);
    recorder.returned.push(returnedRows);
    const notifications = builderRecorder();
    const service = new OutboundMessageService(
      { createQueryBuilder: recorder.createQueryBuilder } as any,
      {} as any,
      { createQueryBuilder: notifications.createQueryBuilder } as any,
      {} as any,
    );
    return { service, notifications };
  };
  const textRow = [{ channel: 'SMS', entity_type: 'NOTIFICATION', entity_id: NOTIFICATION_ID }];
  const emailRow = [{ channel: 'EMAIL', entity_type: 'NOTIFICATION', entity_id: NOTIFICATION_ID }];
  const columnsOf = (set: any) => Object.keys(set ?? {});

  it('SENT → the notification\'s text is DELIVERED and stamped, only if still SENT — and no email column is written', async () => {
    const { service, notifications } = setup(textRow);

    await service.markSent('s1');

    expect(notifications.calls).toHaveLength(1);
    const [write] = notifications.calls;
    expect(write.set).toEqual({
      smsStatus: NotificationStatus.DELIVERED,
      textedAt: expect.any(Date),
      smsFailureReason: null,
    });
    expect(notifications.whereOf(write)).toEqual({
      'id IN (:...ids)': { ids: [NOTIFICATION_ID] },
      'sms_status = :handedOff': { handedOff: NotificationStatus.SENT },
    });
  });

  it('an email settling never touches sms_status — the email leg writes only email columns', async () => {
    const { service, notifications } = setup(emailRow);

    await service.markSent('e1');

    expect(notifications.calls).toHaveLength(1);
    expect(columnsOf(notifications.calls[0].set).filter((c) => c.startsWith('sms') || c === 'textedAt')).toEqual([]);
    expect(Object.keys(notifications.whereOf(notifications.calls[0]))).not.toContain('sms_status = :handedOff');
  });

  it('FAILED → the notification\'s text is FAILED, with the reason the gateway gave', async () => {
    const { service, notifications } = setup(textRow);

    await service.markFailed('s1', 'The SMS gateway refused it: invalid number.');

    const [write] = notifications.calls;
    expect(write.set).toEqual({
      smsStatus: NotificationStatus.FAILED,
      smsFailureReason: 'The SMS gateway refused it: invalid number.',
    });
  });

  it('"SMS is not set up" → the notification\'s text is SUPPRESSED with SMS wording, not the email wording', async () => {
    const { service, notifications } = setup(textRow);

    await service.markFailed('s1', 'SMS is not set up on this system, so no text was sent.', { notSetUp: true });

    const [write] = notifications.calls;
    expect(write.set.smsStatus).toBe(NotificationStatus.SUPPRESSED);
    expect(write.set.smsFailureReason).toMatch(/SMS is not configured/);
    expect(write.set.emailStatus).toBeUndefined();
  });

  it('a sweep that gives up on an email and a text together writes each back on its own leg', async () => {
    const recorder = builderRecorder();
    const notifications = builderRecorder();
    const emailId = '11111111-1111-4111-8111-111111111111';
    const textId = '22222222-2222-4222-8222-222222222222';
    recorder.returned.push(
      [
        { channel: 'EMAIL', entity_type: 'NOTIFICATION', entity_id: emailId },
        { channel: 'SMS', entity_type: 'NOTIFICATION', entity_id: textId },
      ],
      [],
    );
    const service = new OutboundMessageService(
      { createQueryBuilder: recorder.createQueryBuilder, find: jest.fn(async () => []) } as any,
      {} as any,
      { createQueryBuilder: notifications.createQueryBuilder } as any,
      {} as any,
    );

    await service.sweep(Date.parse('2026-09-17T10:00:00Z'));

    const emailWrite = notifications.calls.find((c) => notifications.whereOf(c)['id IN (:...ids)']?.ids?.includes(emailId))!;
    const textWrite = notifications.calls.find((c) => notifications.whereOf(c)['id IN (:...ids)']?.ids?.includes(textId))!;
    expect(notifications.whereOf(emailWrite)['id IN (:...ids)']).toEqual({ ids: [emailId] });
    expect(emailWrite.set).toEqual({ emailStatus: NotificationStatus.FAILED, emailFailureReason: expect.stringMatching(/given up/) });
    expect(notifications.whereOf(textWrite)['id IN (:...ids)']).toEqual({ ids: [textId] });
    expect(textWrite.set).toEqual({ smsStatus: NotificationStatus.FAILED, smsFailureReason: expect.stringMatching(/given up/) });
    expect(notifications.whereOf(textWrite)['sms_status = :handedOff']).toEqual({ handedOff: NotificationStatus.SENT });
  });
});

describe('OutboundMessageService.sweep', () => {
  const NOW = Date.parse('2026-09-17T10:00:00Z');

  const setup = (opts: { stranded?: string[]; jobs?: Record<string, any>; getJob?: jest.Mock; add?: jest.Mock } = {}) => {
    const recorder = builderRecorder();
    const repo = {
      createQueryBuilder: recorder.createQueryBuilder,
      find: jest.fn(async () => (opts.stranded ?? []).map((id) => ({ id }))),
    };
    const queue = {
      getJob: opts.getJob ?? jest.fn(async (jobId: string) => opts.jobs?.[jobId] ?? null),
      add: opts.add ?? jest.fn(async () => ({})),
    };
    const service = new OutboundMessageService(repo as any, queue as any, {} as any, {} as any);
    return { recorder, repo, queue, service };
  };
  const job = (state: string) => ({ getState: jest.fn(async () => state), remove: jest.fn(async () => undefined) });
  const callWhere = (recorder: ReturnType<typeof builderRecorder>, clause: string) =>
    recorder.calls.find((c) => c.where.some((w) => w.clause === clause))!;

  it('gives up on a QUEUED email older than a day: FAILED, with a reason, and the message erased', async () => {
    const { service, recorder } = setup();
    recorder.affected.push(3);

    const summary = await service.sweep(NOW);

    const expired = callWhere(recorder, 'status = :queued');
    expect(expired.op).toBe('update');
    expect(recorder.whereOf(expired)).toEqual({
      'status = :queued': { queued: 'QUEUED' },
      'created_at < :cutoff': { cutoff: new Date(NOW - 24 * 60 * 60_000) },
    });
    expect(expired.set.status).toBe('FAILED');
    expect(expired.set.payload).toBeNull();
    expect(expired.set.lastError).toMatch(/given up/);
    expect(summary.expired).toBe(3);
  });

  it('fails a SENDING email whose worker has been gone for fifteen minutes, erasing the message', async () => {
    const { service, recorder } = setup();
    recorder.affected.push(0, 2);

    const summary = await service.sweep(NOW);

    const abandoned = callWhere(recorder, 'status = :sending');
    expect(recorder.whereOf(abandoned)).toEqual({
      'status = :sending': { sending: 'SENDING' },
      'updated_at < :cutoff': { cutoff: new Date(NOW - 15 * 60_000) },
    });
    expect(abandoned.set.status).toBe('FAILED');
    expect(abandoned.set.payload).toBeNull();
    expect(abandoned.set.lastError).toMatch(/may not have arrived/);
    expect(summary.abandoned).toBe(2);
  });

  it('looks for stranded rows only among QUEUED ones untouched for the grace period', async () => {
    const { service, repo } = setup();
    await service.sweep(NOW);

    const [{ where }] = (repo.find.mock.calls as any[])[0];
    expect(where.status).toBe('QUEUED');
    expect(where.updatedAt.value).toEqual(new Date(NOW - 2 * 60_000));
  });

  it.each(['failed', 'completed'])(
    'replaces a stranded row\'s %s job — Bull will not add a second job under a kept id — and queues it again',
    async (state) => {
      const old = job(state);
      const { service, queue } = setup({ stranded: ['e1'], jobs: { 'outbound-message:e1': old } });

      const summary = await service.sweep(NOW);

      expect(old.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        OUTBOUND_MESSAGE_JOB,
        { outboundMessageId: 'e1' },
        expect.objectContaining({ jobId: 'outbound-message:e1', attempts: 5 }),
      );
      expect(old.remove.mock.invocationCallOrder[0]).toBeLessThan(queue.add.mock.invocationCallOrder[0]);
      expect(summary.requeued).toBe(1);
    },
  );

  it('queues a stranded row that has no job at all (Redis was down when it was written)', async () => {
    const { service, queue } = setup({ stranded: ['e1'] });

    const summary = await service.sweep(NOW);

    expect(queue.add).toHaveBeenCalledWith(OUTBOUND_MESSAGE_JOB, { outboundMessageId: 'e1' }, expect.objectContaining({ jobId: 'outbound-message:e1' }));
    expect(summary.requeued).toBe(1);
  });

  it.each(['delayed', 'waiting', 'active'])('leaves a stranded row alone while its job is %s', async (state) => {
    const live = job(state);
    const { service, queue } = setup({ stranded: ['e1'], jobs: { 'outbound-message:e1': live } });

    const summary = await service.sweep(NOW);

    expect(live.remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(summary.requeued).toBe(0);
  });

  it('stops the loop at the first Redis failure instead of grinding through the batch — and still purges', async () => {
    const getJob = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    const { service, queue, recorder } = setup({ stranded: ['e1', 'e2', 'e3'], getJob });

    const summary = await service.sweep(NOW);

    expect(getJob).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(summary.requeued).toBe(0);
    expect(recorder.calls.some((c) => c.op === 'delete')).toBe(true);
  });

  it('stops the loop when re-adding fails, too', async () => {
    const add = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    const { service, queue } = setup({ stranded: ['e1', 'e2', 'e3'], add });

    const summary = await service.sweep(NOW);

    expect(add).toHaveBeenCalledTimes(1);
    expect(queue.getJob).toHaveBeenCalledTimes(1);
    expect(summary.requeued).toBe(0);
  });

  it('deletes settled rows only once they are past the ninety-day retention', async () => {
    const { service, recorder } = setup();
    recorder.affected.push(0, 0, 7);

    const summary = await service.sweep(NOW);

    const purge = recorder.calls.find((c) => c.op === 'delete')!;
    expect(recorder.whereOf(purge)).toEqual({
      'status IN (:...settled)': { settled: ['SENT', 'FAILED'] },
      'updated_at < :cutoff': { cutoff: new Date(NOW - 90 * 24 * 60 * 60_000) },
    });
    expect(summary.purged).toBe(7);
  });
});

describe('OutboundEmailWorker', () => {
  const message = { channel: 'EMAIL' as const, to: 'candidate@example.com', subject: 's', text: 't' };

  const setup = (opts: {
    claimed?: any;
    send?: { success: boolean; permanent?: boolean; error?: string };
    enabled?: boolean;
  }) => {
    const outbound = {
      claim: jest.fn(async () => (opts.claimed === undefined ? { row: { id: 'e1' }, message } : opts.claimed)),
      markSent: jest.fn(async () => undefined),
      markFailed: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      sweep: jest.fn(async () => undefined),
    };
    const email = {
      send: jest.fn(async () => opts.send ?? { success: true }),
      isEnabled: jest.fn(() => opts.enabled ?? true),
    };
    return { outbound, email, worker: new OutboundEmailWorker(outbound as any, email as any) };
  };
  const job = (attemptsMade = 0) => ({ data: { outboundMessageId: 'e1' }, attemptsMade, opts: { attempts: 5 } }) as any;

  it('sends a claimed email and records it SENT', async () => {
    const { worker, outbound, email } = setup({});
    await worker.send(job());
    expect(email.send).toHaveBeenCalledWith(message);
    expect(outbound.markSent).toHaveBeenCalledWith('e1');
  });

  it('sends nothing when the row is already taken or settled — a retry racing the sweep cannot double-send', async () => {
    const { worker, email, outbound } = setup({ claimed: null });
    await worker.send(job());
    expect(email.send).not.toHaveBeenCalled();
    expect(outbound.markSent).not.toHaveBeenCalled();
  });

  it('fails an unreadable message without sending it', async () => {
    const { worker, email, outbound } = setup({ claimed: { row: { id: 'e1' }, message: null } });
    await worker.send(job());
    expect(email.send).not.toHaveBeenCalled();
    expect(outbound.markFailed).toHaveBeenCalledWith('e1', expect.any(String));
  });

  it('says plainly when email is not set up, instead of passing on a transport error', async () => {
    const { worker, outbound } = setup({ send: { success: false, permanent: true, error: 'Email is not configured.' }, enabled: false });
    await worker.send(job());
    // Flagged, so a notification's email records it as SUPPRESSED rather than FAILED.
    expect(outbound.markFailed).toHaveBeenCalledWith('e1', 'Email is not set up on this system, so it was not sent.', { notSetUp: true });
  });

  it('does not retry an address the mail server refused', async () => {
    const { worker, outbound } = setup({ send: { success: false, permanent: true, error: '550 no such user' } });
    await expect(worker.send(job())).resolves.toBeUndefined();
    expect(outbound.markFailed).toHaveBeenCalledWith('e1', expect.stringContaining('550 no such user'));
    // A refusal is a real failure, not "email is switched off".
    expect(outbound.markFailed.mock.calls[0]).toHaveLength(2);
    expect(outbound.release).not.toHaveBeenCalled();
  });

  it('puts a transient failure back for Bull to retry', async () => {
    const { worker, outbound } = setup({ send: { success: false, error: 'Greeting never received' } });
    await expect(worker.send(job(1))).rejects.toThrow('Greeting never received');
    expect(outbound.release).toHaveBeenCalledWith('e1', 'Greeting never received');
    expect(outbound.markFailed).not.toHaveBeenCalled();
  });

  it('settles FAILED on the last attempt instead of throwing, so it never reads as still sending', async () => {
    const { worker, outbound } = setup({ send: { success: false, error: 'Greeting never received' } });
    await expect(worker.send(job(4))).resolves.toBeUndefined();
    expect(outbound.markFailed).toHaveBeenCalledWith('e1', expect.stringContaining('tried 5 times'));
    expect(outbound.release).not.toHaveBeenCalled();
  });
});

describe('the queue the action emails travel on', () => {
  const { readFileSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');
  const stripped = (file: string) => readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /**
   * Bull's loops are per queue and take jobs of any name, so a job name on notification-delivery
   * would let a 540-email credential run hold the loops push offers and SLA alert emails need.
   */
  it('is its own queue, not a job name on the notification queue', () => {
    const { NOTIFICATION_QUEUE, OUTBOUND_EMAIL_QUEUE } = require('./notification.constants');
    expect(OUTBOUND_EMAIL_QUEUE).not.toBe(NOTIFICATION_QUEUE);
    expect(stripped('outbound-email.worker.ts')).toMatch(/@Processor\(OUTBOUND_EMAIL_QUEUE\)/);
    expect(stripped('outbound-message.service.ts')).toMatch(/@InjectQueue\(OUTBOUND_EMAIL_QUEUE\)/);
    // …and texts on theirs, so a slow SMS gateway cannot hold the loops emails need.
    expect(stripped('outbound-message.service.ts')).toMatch(/@InjectQueue\(OUTBOUND_SMS_QUEUE\)/);
    expect(stripped('outbound-sms.worker.ts')).toMatch(/@Processor\(OUTBOUND_SMS_QUEUE\)/);
    expect(stripped('notifications.module.ts')).toMatch(/registerQueue\(\{\s*name:\s*OUTBOUND_EMAIL_QUEUE/);
  });
});
