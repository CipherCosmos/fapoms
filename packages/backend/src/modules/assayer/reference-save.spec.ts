import { RosterRecordsService } from './roster-records.service';

/**
 * Writing a reference onto the record — the one door the correction form, "Add reference" and the
 * approval replay all go through.
 *
 * Nothing covered it before, which is how two faults sat in it unnoticed: an emptied phone box
 * silently put the old number back, and numbers were stored however they happened to be typed.
 */
describe('RosterRecordsService.saveReference', () => {
  type Row = Record<string, any>;

  const harness = (existing?: Row) => {
    const rows: Row[] = existing ? [{ ...existing }] : [];
    const references = {
      findOne: jest.fn(async ({ where }: { where: Row }) =>
        rows.find((r) => r.id === where.id && r.assayerId === where.assayerId) ?? null),
      create: jest.fn((v: Row) => ({ ...v })),
      save: jest.fn(async (r: Row) => r),
    };
    const service = new RosterRecordsService(
      { findOne: jest.fn(async () => null) } as never, references as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
    );
    return { service, references };
  };

  const onFile = {
    id: 'ref-1', assayerId: 'as-1', fullName: 'Old Manager',
    phone: '+919822014455', relationship: 'Former manager', email: 'old@example.com',
  };

  /**
   * The correction form sends `phone: null` on purpose — see the comment beside it in the vetting
   * tab. It was `dto.phone ?? row.phone`, and `??` cannot tell null from absent.
   */
  it('clears a phone and a relationship the clerk emptied, instead of putting the old ones back', async () => {
    const { service } = harness(onFile);

    const saved = await service.saveReference(
      'as-1', { fullName: 'Old Manager', phone: null, relationship: null } as never, 'hr-1', 'ref-1',
    );

    expect(saved.phone).toBeNull();
    expect(saved.relationship).toBeNull();
  });

  /** Absent still means "leave it" — the approval replay and a partial save rely on that. */
  it('keeps what the request did not mention', async () => {
    const { service } = harness(onFile);

    const saved = await service.saveReference('as-1', { fullName: 'Old Manager' } as never, 'hr-1', 'ref-1');

    expect(saved.phone).toBe('+919822014455');
    expect(saved.relationship).toBe('Former manager');
    expect(saved.email).toBe('old@example.com');
  });

  /** One spelling, like every other phone on the roster — so two spellings are one number. */
  it.each([
    ['9822014455'],
    ['98220 14455'],
    ['+91-9822014455'],
    ['09822014455'],
  ])('stores %s as +91XXXXXXXXXX', async (typed) => {
    const { service } = harness();

    const saved = await service.saveReference('as-1', { fullName: 'Meera Rao', phone: typed } as never, 'hr-1');

    expect(saved.phone).toBe('+919822014455');
  });

  /** A referee's office landline is still somebody the desk can ring. */
  it('keeps a number that is not a mobile as typed, rather than refusing the reference', async () => {
    const { service } = harness();

    const saved = await service.saveReference('as-1', { fullName: 'Branch Office', phone: '020 2612 3456' } as never, 'hr-1');

    expect(saved.phone).toBe('020 2612 3456');
  });

  it('stores an email lower-cased, and refuses one that is not an address', async () => {
    const { service } = harness();

    const saved = await service.saveReference('as-1', { fullName: 'Meera Rao', email: ' Meera@Example.COM ' } as never, 'hr-1');
    expect(saved.email).toBe('meera@example.com');

    await expect(
      service.saveReference('as-1', { fullName: 'Meera Rao', email: 'not-an-email' } as never, 'hr-1'),
    ).rejects.toThrow(/does not look like an email address/);
  });

  it('clears an email the clerk emptied', async () => {
    const { service } = harness(onFile);

    const saved = await service.saveReference('as-1', { fullName: 'Old Manager', email: null } as never, 'hr-1', 'ref-1');

    expect(saved.email).toBeNull();
  });
});

/**
 * Telling a referee that HR may call them — by email where there is an address, by text where there
 * is a mobile — and recording exactly what went.
 */
describe('RosterRecordsService.notifyReferee', () => {
  type Row = Record<string, any>;

  const harness = (ref: Row, opts: { smsRefusal?: string; noEmailService?: boolean; setting?: boolean } = {}) => {
    const rows: Row[] = [{ ...ref }];
    const references = {
      findOne: jest.fn(async ({ where }: { where: Row }) => rows.find((r) => r.id === where.id && r.assayerId === where.assayerId) ?? null),
      find: jest.fn(async ({ where }: { where: Row }) => rows.filter((r) => r.assayerId === where.assayerId
        && (where.isActive === undefined || (r.isActive ?? true) === where.isActive))),
      update: jest.fn(async (id: string, patch: Row) => { Object.assign(rows.find((r) => r.id === id)!, patch); return { affected: 1 }; }),
    };
    const assayers = { findOne: jest.fn(async () => ({ id: 'as-1', displayName: 'Ramesh Kulkarni' })) };
    const emails = { queue: jest.fn(async (r: Row) => ({ id: 'e-1', channel: 'EMAIL', status: 'QUEUED', to: r.to })) };
    const sms = {
      queue: jest.fn(async (r: Row) => (opts.smsRefusal
        ? { id: 's-1', channel: 'SMS', status: 'FAILED', to: r.to, error: opts.smsRefusal }
        : { id: 's-1', channel: 'SMS', status: 'QUEUED', to: r.to })),
    };
    const settings = {
      get: jest.fn(async (key: string) => {
        if (key === 'references.notifyOnApproval') return opts.setting ?? true;
        if (key === 'dpdp.grievanceOfficerName') return 'Priya Nair';
        if (key === 'dpdp.grievanceOfficerEmail') return 'privacy@sumeruglobal.com';
        return '';
      }),
    };
    const audit = { recordEventSafe: jest.fn(async () => undefined) };
    const service = new RosterRecordsService(
      assayers as never, references as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, undefined, audit as never, undefined, undefined, settings as never,
      (opts.noEmailService ? undefined : emails) as never, sms as never,
    );
    return { service, rows, emails, sms, audit };
  };

  const both = { id: 'ref-1', assayerId: 'as-1', fullName: 'Meera Rao', phone: '+919822014455', email: 'meera@example.com', notifiedAt: null };

  it('tells them both ways when both are on file, naming the candidate and who to object to', async () => {
    const ctx = harness(both);

    const out = await ctx.service.notifyReferee('as-1', 'ref-1', 'hr-1');

    expect(out).toEqual({ channels: ['EMAIL', 'SMS'], problem: null, alreadyTold: false });
    expect(ctx.emails.queue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'REFERENCE_NOTICE', to: 'meera@example.com', entityType: 'ASSAYER_REFERENCE', entityId: 'ref-1',
      content: { template: 'reference-notice', data: expect.objectContaining({
        refereeName: 'Meera Rao', candidateName: 'Ramesh Kulkarni',
        contactLine: 'Priya Nair — privacy@sumeruglobal.com',
      }) },
    }));
    expect(ctx.sms.queue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'REFERENCE_NOTICE', to: '+919822014455',
      content: { template: 'reference-notice', data: { candidateName: 'Ramesh Kulkarni' } },
    }));
    expect(ctx.rows[0]).toMatchObject({ notifiedVia: 'EMAIL,SMS', noticeProblem: null });
    expect(ctx.rows[0].notifiedAt).toBeInstanceOf(Date);
  });

  /** "Based on contact availability": a referee with only a phone gets only a text. */
  it('uses only the channels there are contact details for', async () => {
    const ctx = harness({ ...both, email: null });

    const out = await ctx.service.notifyReferee('as-1', 'ref-1', 'hr-1');

    expect(ctx.emails.queue).not.toHaveBeenCalled();
    expect(out.channels).toEqual(['SMS']);
    expect(out.problem).toMatch(/no email address/);
  });

  /**
   * The case live today: the referee text has no registered DLT template, so the gateway would
   * refuse it. It must be recorded as NOT texted, with the reason — never counted as sent.
   */
  it('records a text the gateway cannot carry as not sent, with its reason', async () => {
    const ctx = harness(both, { smsRefusal: 'This text has no DLT template id; add it under SMS templates in Platform Settings.' });

    const out = await ctx.service.notifyReferee('as-1', 'ref-1', 'hr-1');

    expect(out.channels).toEqual(['EMAIL']);
    expect(ctx.rows[0].notifiedVia).toBe('EMAIL');
    expect(ctx.rows[0].noticeProblem).toMatch(/not texted \(This text has no DLT template id/);
  });

  it('marks nobody as told when nothing could reach them, and says why', async () => {
    const ctx = harness({ ...both, email: null, phone: '020 2612 3456' });

    const out = await ctx.service.notifyReferee('as-1', 'ref-1', 'hr-1');

    expect(out.channels).toEqual([]);
    expect(ctx.rows[0].notifiedAt).toBeNull();
    expect(ctx.rows[0].noticeProblem).toMatch(/no email address; not a mobile number/);
    expect(ctx.audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ASSAYER_REFERENCE_NOT_NOTIFIED' }));
  });

  /** An approval retried after a failure part way must not message the same people twice. */
  it('does not tell somebody twice unless asked to', async () => {
    const ctx = harness({ ...both, notifiedAt: new Date('2026-09-20'), notifiedVia: 'EMAIL' });

    const out = await ctx.service.notifyReferee('as-1', 'ref-1', 'hr-1');
    expect(out).toMatchObject({ alreadyTold: true, channels: ['EMAIL'] });
    expect(ctx.emails.queue).not.toHaveBeenCalled();

    await ctx.service.notifyReferee('as-1', 'ref-1', 'hr-1', { force: true });
    expect(ctx.emails.queue).toHaveBeenCalledTimes(1);
  });

  it('tells only the untold at approval, and nobody when the setting is off', async () => {
    const on = harness(both);
    await on.service.notifyUntoldReferees('as-1', 'hr-1');
    expect(on.emails.queue).toHaveBeenCalledTimes(1);

    const off = harness(both, { setting: false });
    await off.service.notifyUntoldReferees('as-1', 'hr-1');
    expect(off.emails.queue).not.toHaveBeenCalled();
  });

  /** A reference HR removed is off the record; approval must not message them. */
  it('does not message a reference that was removed', async () => {
    const ctx = harness({ ...both, isActive: false });
    await ctx.service.notifyUntoldReferees('as-1', 'hr-1');
    expect(ctx.emails.queue).not.toHaveBeenCalled();
    expect(ctx.sms.queue).not.toHaveBeenCalled();
  });
});
