import { ID_CARD_JOB_TITLE, cardLine, idCardFace, idCardIssueVerdict, idCardLocation, type IdCardTerms } from './id-card';
import {
  LIVE_CODE_WINDOW_SECONDS, checkLiveCardCode, codeWindow, idCardKey, liveCardCode, signCardToken, verifyCardToken,
} from './id-card-verification';
import { IdCardService } from './id-card.service';
import { getRequestContext, runWithRequestContext } from '../../core/context/request-context';

/**
 * THE DIGITAL ID CARD (owner, 2026-09-23): no download, a live code in the assayer's own app, and a
 * public page that checks it against the record as it is now.
 */
describe('the ID card', () => {
  const terms = (over: Partial<IdCardTerms> = {}): IdCardTerms => ({
    refusals: [],
    gated: [],
    gateMode: 'warn',
    issuedOn: new Date('2026-09-16T06:00:00.000Z'),
    validTill: new Date('2026-12-31T00:00:00.000Z'),
    ...over,
  });
  const printedText = { signatoryName: 'Anita Rao', signatoryTitle: null, helplinePhone: '  ', officeAddress: 'Line one,\nLine two', organisation: 'Sumeru Global Pvt Ltd' };
  const person = { displayName: 'Ramesh Kulkarni', assayerCode: 'AS0009', department: '  ', city: '', state: 'Maharashtra' };

  it('is not issued on a refusal, in any mode, and says why', () => {
    for (const gateMode of ['warn', 'enforce']) {
      const v = idCardIssueVerdict(terms({ refusals: ['the record is invited, not active'], gateMode }));
      expect(v.issued).toBe(false);
      expect(v.blockedBecause).toContain('the record is invited, not active');
    }
  });

  it('under enforce, a gated item blocks; under warn it is a gap and the card issues', () => {
    const gated = ['no completed background check on file'];
    expect(idCardIssueVerdict(terms({ gated, gateMode: 'enforce' }))).toEqual({ issued: false, blockedBecause: gated, gaps: [] });
    expect(idCardIssueVerdict(terms({ gated, gateMode: 'warn' }))).toEqual({ issued: true, blockedBecause: [], gaps: gated });
  });

  it('shows only what is on file — blanks as null, no invented location, the organisation named', () => {
    expect(idCardFace(person, terms(), printedText)).toEqual({
      issued: true,
      blockedBecause: [],
      gaps: [],
      issuedOn: '2026-09-16T06:00:00.000Z',
      validTill: '2026-12-31T00:00:00.000Z',
      jobTitle: ID_CARD_JOB_TITLE,
      fullName: 'Ramesh Kulkarni',
      assayerCode: 'AS0009',
      department: null,
      location: 'Maharashtra',
      organisation: 'Sumeru Global Pvt Ltd',
      signatoryName: 'Anita Rao',
      signatoryTitle: null,
      helplinePhone: null,
      officeAddress: 'Line one, Line two',
    });
    expect(idCardLocation(null, undefined)).toBeNull();
    expect(cardLine('   ')).toBeNull();
  });
});

describe('the live code', () => {
  const key = idCardKey('test-secret');
  const t0 = 1_790_000_000;

  it('signs a QR token that names the person and lapses after two minutes', () => {
    const token = signCardToken(key, 'a-1', t0);
    expect(verifyCardToken(key, token, t0 + 30)).toEqual({ ok: true, assayerId: 'a-1' });
    expect(verifyCardToken(key, token, t0 + 121)).toEqual({ ok: false, why: 'expired' });
  });

  it('refuses a forged or altered token, one signed elsewhere, and a photo token used as a card token', () => {
    const token = signCardToken(key, 'a-1', t0);
    const [body] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ a: 'a-2', e: t0 + 100, p: 'c' })).toString('base64url');
    expect(verifyCardToken(key, `${forgedBody}.${token.split('.')[1]}`, t0)).toEqual({ ok: false, why: 'invalid' });
    expect(verifyCardToken(idCardKey('another-server'), token, t0)).toEqual({ ok: false, why: 'invalid' });
    expect(verifyCardToken(key, `${body}.`, t0)).toEqual({ ok: false, why: 'invalid' });
    expect(verifyCardToken(key, signCardToken(key, 'a-1', t0, 'p'), t0, 'c')).toEqual({ ok: false, why: 'invalid' });
  });

  it('gives six digits that change every minute, and accepts the minute just gone', () => {
    const code = liveCardCode(key, 'a-1', codeWindow(t0));
    expect(code).toMatch(/^\d{6}$/);
    expect(checkLiveCardCode(key, 'a-1', code, t0)).toBe(true);
    expect(checkLiveCardCode(key, 'a-1', code, t0 + LIVE_CODE_WINDOW_SECONDS)).toBe(true);
    expect(checkLiveCardCode(key, 'a-1', code, t0 + 2 * LIVE_CODE_WINDOW_SECONDS + 1)).toBe(false);
    // Somebody else's code is not yours.
    expect(checkLiveCardCode(key, 'a-2', code, t0)).toBe(false);
  });
});

describe('checking a card', () => {
  const build = (over: { lifecycle?: string; issued?: boolean; validTill?: string; blockers?: string[] } = {}) => {
    const person = {
      id: 'a-1', displayName: 'Ramesh Kulkarni', assayerCode: 'AS0009', lifecycleStatus: over.lifecycle ?? 'ACTIVE',
      photograph: 'uploads/face.jpg', city: 'Pune', state: 'Maharashtra',
    };
    const assayerService = { findOneForReading: jest.fn(async () => person), getProfile: jest.fn(async () => person) };
    const rosterRecords = {
      idCardTerms: jest.fn(async () => ({
        refusals: over.issued === false ? ['the record is suspended, not active'] : [], gated: [], gateMode: 'warn',
        issuedOn: new Date(), validTill: new Date(over.validTill ?? '2099-12-31'),
      })),
      idCardPrintedText: jest.fn(async () => ({ signatoryName: null, signatoryTitle: null, helplinePhone: null, officeAddress: null, organisation: 'Sumeru Global' })),
    };
    const audit = { recordEventSafe: jest.fn(async () => undefined) };
    const compliance = { workBlockers: jest.fn(async () => over.blockers ?? []) };
    const service = new IdCardService(
      assayerService as any, rosterRecords as any, audit as any, {} as any, { get: () => 'test-secret' } as any, compliance as any,
    );
    return { service, audit };
  };

  it('answers a scanned live code from the record as it is now, and puts the check on the trail', async () => {
    const { service, audit } = build();
    const live = await service.liveCode('a-1');
    const token = live.verifyUrl.split('/verify/card/')[1];
    const answer = await service.verifyByToken(token);

    expect(answer).toMatchObject({ result: 'VALID', fullName: 'Ramesh Kulkarni', assayerCode: 'AS0009', clearedForNewWork: true, organisation: 'Sumeru Global' });
    expect(answer.photoUrl).toMatch(/^\/api\/v1\/public\/id-card\/photo\//);
    expect(live.qr).toMatch(/^data:image\/png;base64,/);
    expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ASSAYER_ID_CARD_VERIFIED', entityId: 'a-1' }));
  });

  it('checks by ID number and the 6 digits, and says the same thing for a wrong code as for no such person', async () => {
    const { service } = build();
    const live = await service.liveCode('a-1');
    await expect(service.verifyByCode('as0009', live.code)).resolves.toMatchObject({ result: 'VALID' });
    await expect(service.verifyByCode('AS0009', '000000'.replace(/./g, (_, i) => String((Number(live.code[i]) + 1) % 10))))
      .resolves.toMatchObject({ result: 'NO_MATCH' });
  });

  it('says NOT VALID for somebody suspended — a live screenshot of yesterday\'s card counts for nothing', async () => {
    const { service } = build({ issued: false, lifecycle: 'SUSPENDED' });
    await expect(service.liveCode('a-1')).rejects.toThrow(/not issued yet/);
    const { service: live } = build();
    const token = (await live.liveCode('a-1')).verifyUrl.split('/verify/card/')[1];
    const { service: later } = build({ issued: false, lifecycle: 'SUSPENDED' });
    await expect(later.verifyByToken(token)).resolves.toMatchObject({ result: 'NOT_VALID', message: expect.stringMatching(/not currently an active appraiser/) });
  });

  it('tells the person checking when the card is valid but they are held from new work', async () => {
    const { service } = build({ blockers: ['Police verification overdue since 2026-06-15'] });
    const token = (await service.liveCode('a-1')).verifyUrl.split('/verify/card/')[1];
    await expect(service.verifyByToken(token)).resolves.toMatchObject({ result: 'VALID', clearedForNewWork: false });
  });

  it('turns away a code that is not ours', async () => {
    const { service } = build();
    await expect(service.verifyByToken('not.a-token')).resolves.toMatchObject({ result: 'NO_MATCH' });
  });

  /**
   * The bug the live check found: a signed-out request has no organisation, so every tenant-scoped
   * read refused it — and the refusal was swallowed into "not a code issued by us" for a genuine
   * card. The reads now run outside the request once the token has named the one person.
   */
  it('reads the named person even though the request is signed-out', async () => {
    const { service } = build();
    const token = (await service.liveCode('a-1')).verifyUrl.split('/verify/card/')[1];
    const lookups = (service as any).assayerService.findOneForReading as jest.Mock;
    lookups.mockImplementation(async () => {
      if (getRequestContext()) throw new Error('Your account is not linked to an organisation');
      return { id: 'a-1', displayName: 'Ramesh Kulkarni', assayerCode: 'AS0009', lifecycleStatus: 'ACTIVE', photograph: null };
    });
    const answer = await runWithRequestContext({ requestId: 'anon' } as any, () => service.verifyByToken(token));
    expect(answer.result).toBe('VALID');
  });
});
