import { HttpException } from '@nestjs/common';
import { IdCardService, ID_CARD_CODE_MAX_FAILURES } from './id-card.service';

/**
 * THE TYPED ID-CARD CHECK CANNOT BE GUESSED THROUGH.
 *
 * `POST /public/id-card/verify` takes an ID number and six digits, with no sign-in. The per-IP
 * throttle bounds one address; several addresses, or a patient one, could still work through the
 * 6-digit space for one person. A counter per ID number, in Redis, closes the typed route for that
 * number after a handful of wrong codes. Scanning the QR is unaffected.
 */
describe('wrong-code lockout on the typed ID card check', () => {
  const person = {
    id: 'a-1', displayName: 'Ramesh Kulkarni', assayerCode: 'AS0009', lifecycleStatus: 'ACTIVE',
    photograph: null, city: 'Pune', state: 'Maharashtra',
  };

  /** An in-memory stand-in for CacheService with the same semantics the service relies on. */
  const fakeCache = () => {
    const store = new Map<string, any>();
    return {
      store,
      getJson: jest.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
      setJson: jest.fn(async (k: string, v: any) => { store.set(k, v); }),
      del: jest.fn(async (...ks: string[]) => { ks.forEach((k) => store.delete(k)); }),
      incrWithTtl: jest.fn(async (k: string) => { const n = (store.get(k) ?? 0) + 1; store.set(k, n); return n; }),
    };
  };

  const build = () => {
    const cache = fakeCache();
    const assayerService = {
      findOneForReading: jest.fn(async () => person),
      getProfile: jest.fn(async (code: string) => (code === 'AS0009' ? person : null)),
    };
    const rosterRecords = {
      idCardTerms: jest.fn(async () => ({ refusals: [], gated: [], gateMode: 'warn', issuedOn: new Date(), validTill: new Date('2099-12-31') })),
      idCardPrintedText: jest.fn(async () => ({ signatoryName: null, signatoryTitle: null, helplinePhone: null, officeAddress: null, organisation: 'Sumeru Global' })),
    };
    const service = new IdCardService(
      assayerService as any, rosterRecords as any, { recordEventSafe: jest.fn() } as any, {} as any,
      { get: () => 'test-secret' } as any, { workBlockers: jest.fn(async () => []) } as any, cache as any,
    );
    return { service, cache, assayerService };
  };

  const wrongFor = (live: string) => live.replace(/./g, (d) => String((Number(d) + 1) % 10));

  it(`locks an ID number after ${ID_CARD_CODE_MAX_FAILURES} wrong codes — even the right code is then refused`, async () => {
    const { service } = build();
    const live = (await service.liveCode('a-1')).code;
    for (let i = 0; i < ID_CARD_CODE_MAX_FAILURES; i++) {
      await expect(service.verifyByCode('AS0009', wrongFor(live))).resolves.toMatchObject({ result: 'NO_MATCH' });
    }
    const refused = service.verifyByCode('as0009', live);
    await expect(refused).rejects.toBeInstanceOf(HttpException);
    await expect(service.verifyByCode('AS0009', live)).rejects.toMatchObject({ status: 429 });
  });

  it('allows honest typos below the limit, and a right code clears the count', async () => {
    const { service, cache } = build();
    const live = (await service.liveCode('a-1')).code;
    for (let i = 0; i < ID_CARD_CODE_MAX_FAILURES - 1; i++) await service.verifyByCode('AS0009', wrongFor(live));
    await expect(service.verifyByCode('AS0009', live)).resolves.toMatchObject({ result: 'VALID' });
    expect(cache.store.get('idcard:verify-fail:AS0009')).toBeUndefined();
    // And the count starts again from nothing.
    await service.verifyByCode('AS0009', wrongFor(live));
    await expect(service.verifyByCode('AS0009', live)).resolves.toMatchObject({ result: 'VALID' });
  });

  it('counts an ID number nobody holds the same way, so the lock cannot reveal which numbers are real', async () => {
    const { service, assayerService } = build();
    for (let i = 0; i < ID_CARD_CODE_MAX_FAILURES; i++) await service.verifyByCode('AS9999', '123456');
    assayerService.getProfile.mockClear();
    await expect(service.verifyByCode('AS9999', '123456')).rejects.toMatchObject({ status: 429 });
    // Locked means not looked up at all.
    expect(assayerService.getProfile).not.toHaveBeenCalled();
  });

  it('keeps one number\'s lock off every other number', async () => {
    const { service } = build();
    for (let i = 0; i < ID_CARD_CODE_MAX_FAILURES; i++) await service.verifyByCode('AS9999', '123456');
    const live = (await service.liveCode('a-1')).code;
    await expect(service.verifyByCode('AS0009', live)).resolves.toMatchObject({ result: 'VALID' });
  });

  it('leaves the QR scan open while the typed check is locked', async () => {
    const { service } = build();
    const live = await service.liveCode('a-1');
    for (let i = 0; i < ID_CARD_CODE_MAX_FAILURES; i++) await service.verifyByCode('AS0009', wrongFor(live.code));
    const token = live.verifyUrl.split('/verify/card/')[1];
    await expect(service.verifyByToken(token)).resolves.toMatchObject({ result: 'VALID' });
  });
});
