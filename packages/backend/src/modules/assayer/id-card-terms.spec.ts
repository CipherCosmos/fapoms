import { AssayerLifecycleStatus, BackgroundCheckVerdict } from '@fapoms/shared';
import { RosterRecordsService } from './roster-records.service';

/**
 * Looking at a card is not issuing one.
 *
 * `idCardIssuance` used to be the only way to ask "may this card be issued", and it writes the
 * `ASSAYER_ID_CARD_ISSUED_WITH_GAPS` audit row as it answers. The on-screen preview asks the same
 * question every time the ID card tab opens — through `idCardIssuance` it would have filled the
 * register of "who holds a card on incomplete vetting" with people who were merely looked at. So
 * the judgement is `idCardTerms` (no writes), and `idCardIssuance` is that plus the audit row.
 */
describe('ID card terms vs issuance', () => {
  const serviceWith = (opts: {
    gateMode: string;
    lifecycleStatus?: AssayerLifecycleStatus;
    identityOk?: boolean;
    verdict?: BackgroundCheckVerdict | null;
    settings?: Record<string, unknown>;
    settingsThrow?: boolean;
  }) => {
    const svc: any = Object.create(RosterRecordsService.prototype);
    svc.assayers = {
      findOne: jest.fn().mockResolvedValue({ id: 'asr-1', lifecycleStatus: opts.lifecycleStatus ?? AssayerLifecycleStatus.ACTIVE }),
    };
    svc.identityStanding = jest.fn().mockResolvedValue({ ok: opts.identityOk ?? true, missing: [], verified: [], rejected: [] });
    svc.latestBackgroundVerdict = jest.fn().mockResolvedValue(opts.verdict === undefined ? BackgroundCheckVerdict.CLEAR : opts.verdict);
    const settings: Record<string, unknown> = { 'onboarding.identityGate.mode': opts.gateMode, ...(opts.settings ?? {}) };
    svc.platformSettings = {
      get: jest.fn(async (key: string) => {
        if (opts.settingsThrow && !key.startsWith('onboarding.')) throw new Error('settings table unreachable');
        return settings[key] ?? null;
      }),
    };
    svc.auditService = { recordEventSafe: jest.fn().mockResolvedValue(undefined) };
    return svc;
  };

  it('terms write nothing, even when the card would issue with gaps', async () => {
    const svc = serviceWith({ gateMode: 'warn', verdict: null });
    const terms = await svc.idCardTerms('asr-1');
    expect(terms.gated).toEqual(['no completed background check on file']);
    expect(terms.refusals).toEqual([]);
    expect(svc.auditService.recordEventSafe).not.toHaveBeenCalled();
  });

  it('issuance reaches the same judgement and records the gap exactly once', async () => {
    const svc = serviceWith({ gateMode: 'warn', verdict: null });
    const terms = await svc.idCardTerms('asr-1');
    const issuance = await svc.idCardIssuance('asr-1', 'user-9');
    expect({ ...issuance, issuedOn: undefined, validTill: undefined }).toEqual({ ...terms, issuedOn: undefined, validTill: undefined });
    expect(issuance.validTill).toEqual(terms.validTill);
    expect(svc.auditService.recordEventSafe).toHaveBeenCalledTimes(1);
    expect(svc.auditService.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'ASSAYER_ID_CARD_ISSUED_WITH_GAPS', entityId: 'asr-1', userId: 'user-9',
    }));
  });

  it('issuance records nothing when the card is refused or blocked, or has no gaps', async () => {
    for (const svc of [
      serviceWith({ gateMode: 'warn', verdict: null, lifecycleStatus: AssayerLifecycleStatus.INVITED }),
      serviceWith({ gateMode: 'enforce', verdict: null }),
      serviceWith({ gateMode: 'warn' }),
    ]) {
      await svc.idCardIssuance('asr-1', 'user-9');
      expect(svc.auditService.recordEventSafe).not.toHaveBeenCalled();
    }
  });

  it('reads the printed text from settings as single trimmed lines, blanks as null', async () => {
    const svc = serviceWith({
      gateMode: 'warn',
      settings: {
        'idCard.signatoryName': '  Anita Rao ',
        'idCard.signatoryTitle': '   ',
        'idCard.helplinePhone': null,
        'company.address': '12 MG Road,\r\nBengaluru 560001\n',
      },
    });
    await expect(svc.idCardPrintedText()).resolves.toEqual({
      signatoryName: 'Anita Rao',
      signatoryTitle: null,
      helplinePhone: null,
      officeAddress: '12 MG Road, Bengaluru 560001',
    });
  });

  it('degrades to no printed text, rather than failing, when settings cannot be read', async () => {
    const svc = serviceWith({ gateMode: 'warn', settingsThrow: true });
    await expect(svc.idCardPrintedText()).resolves.toEqual({
      signatoryName: null, signatoryTitle: null, helplinePhone: null, officeAddress: null,
    });
    const noStore: any = serviceWith({ gateMode: 'warn' });
    noStore.platformSettings = undefined;
    await expect(noStore.idCardPrintedText()).resolves.toEqual({
      signatoryName: null, signatoryTitle: null, helplinePhone: null, officeAddress: null,
    });
  });
});
