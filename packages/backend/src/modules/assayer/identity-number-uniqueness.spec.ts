import { ConflictException } from '@nestjs/common';
import { RosterRecordsService } from './roster-records.service';

/**
 * ONE AADHAAR, ONE PERSON.
 *
 * The paperwork screen writes a PAN or an Aadhaar straight onto `assayers.pan_number` /
 * `aadhaar_number` — and asked nothing about whether that number was already on somebody else. The
 * duplicate check existed the whole time (`findIdentifierMatches`, comparing keyed fingerprints
 * because the columns are encrypted and no equality search can match them), wired only to the
 * advisory lookup the registration wizard calls. The path that actually writes the column never
 * asked it, so one person's Aadhaar could be recorded against a second roster record.
 *
 * That is not a tidy-data problem. Two records sharing an Aadhaar means assignments, payouts and a
 * client's KYC file attach to the wrong human being, and the repair afterwards is a merge.
 */
describe('recording an identity number that belongs to somebody else', () => {
  const VALID_AADHAAR = '234567890124';
  const OTHER = {
    id: 'a-2',
    assayerCode: 'AS-77',
    displayName: 'Ramesh Iyer',
    lifecycleStatus: 'ACTIVE',
    matchedOn: 'aadhaarNumber' as const,
  };

  const serviceWith = (matches: unknown[]) => {
    const person = { id: 'a-1', aadhaarNumber: null as string | null, panNumber: null as string | null };
    const row = {
      id: 'doc-1', requirement: 'AADHAAR_FRONT', assayerId: 'a-1',
      documentNumber: null, expiryDate: null, isActive: true,
      verificationStatus: null, verifiedAt: null, verifiedBy: null,
    };
    const assayers = {
      findOne: jest.fn().mockResolvedValue(person),
      save: jest.fn().mockImplementation(async (p: unknown) => p),
    };
    const onboarding = {
      findOne: jest.fn().mockResolvedValue(row),
      save: jest.fn().mockImplementation(async (r: unknown) => r),
      create: jest.fn().mockImplementation((r: unknown) => r),
    };
    const findIdentifierMatches = jest.fn().mockResolvedValue(matches);
    const service = new RosterRecordsService(
      assayers as never, {} as never, {} as never, {} as never, onboarding as never,
      {} as never, {} as never, undefined, undefined,
      { findIdentifierMatches } as never,
    );
    return { service, person, findIdentifierMatches, assayers };
  };

  it('refuses it, and says whose it is', async () => {
    const { service, findIdentifierMatches, assayers } = serviceWith([OTHER]);

    await expect(
      service.setDocument('a-1', 'AADHAAR_FRONT' as never, { documentNumber: VALID_AADHAAR }, 'u-1'),
    ).rejects.toBeInstanceOf(ConflictException);

    // Named, because "duplicate" alone leaves a clerk with nowhere to go.
    await expect(
      service.setDocument('a-1', 'AADHAAR_FRONT' as never, { documentNumber: VALID_AADHAAR }, 'u-1'),
    ).rejects.toThrow(/Ramesh Iyer \(AS-77\)/);

    // …and the number is never written.
    expect(assayers.save).not.toHaveBeenCalled();
    expect(findIdentifierMatches).toHaveBeenCalledWith(
      expect.objectContaining({ aadhaarNumber: VALID_AADHAAR, excludeId: 'a-1' }),
    );
  });

  it('lets a number through when it belongs to nobody else', async () => {
    const { service, person } = serviceWith([]);

    await service.setDocument('a-1', 'AADHAAR_FRONT' as never, { documentNumber: VALID_AADHAAR }, 'u-1');

    expect(person.aadhaarNumber).toBe(VALID_AADHAAR);
  });

  /** A person's own number is not a clash with themselves — hence `excludeId`. */
  it('does not read a person’s own number as a duplicate', async () => {
    const { service, findIdentifierMatches } = serviceWith([]);

    await service.setDocument('a-1', 'AADHAAR_FRONT' as never, { documentNumber: VALID_AADHAAR }, 'u-1');

    expect(findIdentifierMatches.mock.calls[0][0].excludeId).toBe('a-1');
  });

  /** A phone match is a different question and must not block an identity number. */
  it('ignores a match on something other than this number', async () => {
    const { service, person } = serviceWith([{ ...OTHER, matchedOn: 'phone' }]);

    await service.setDocument('a-1', 'AADHAAR_FRONT' as never, { documentNumber: VALID_AADHAAR }, 'u-1');

    expect(person.aadhaarNumber).toBe(VALID_AADHAAR);
  });
});
