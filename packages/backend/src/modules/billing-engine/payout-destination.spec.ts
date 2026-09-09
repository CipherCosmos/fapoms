import { DocumentVerification } from '@fapoms/shared';
import { resolvePayoutDestination, PayoutDestinationEvidence } from './payout-destination';

/**
 * The rule these tests hold: `destination_verified_at` is non-null ONLY where the evidence for it
 * exists, and it always carries the timestamp OF that evidence — never the moment of approval.
 *
 * Both writers used to end `?? new Date()`, so "nobody has ever verified this person or this
 * account" produced the same row as "a reviewer checked their passbook this morning".
 * Certification found five payables in that state covering money that had left the business.
 */
describe('resolvePayoutDestination', () => {
  const assayer = {
    bankAccountNumber: '  9876543210 ',
    ifscCode: ' hdfc0001234 ',
    bankName: ' HDFC Bank ',
    legalName: ' Deepak Sharma ',
    displayName: 'Deepak',
    identityVerifiedAt: null as Date | null,
  };

  describe('no evidence at all', () => {
    it('claims nothing — the timestamp is NULL, not now()', () => {
      const snapshot = resolvePayoutDestination({ ...assayer, identityVerifiedAt: null }, null);
      expect(snapshot.destinationVerifiedAt).toBeNull();
      expect(snapshot.destinationVerifiedSource).toBeNull();
      expect(snapshot.payoutEvidenceVersionId).toBeNull();
    });

    it('still freezes the destination itself — an unverified payout is allowed, an unfounded claim is not', () => {
      const snapshot = resolvePayoutDestination({ ...assayer, identityVerifiedAt: null }, null);
      expect(snapshot.destinationBankAccountNumber).toBe('9876543210');
      expect(snapshot.destinationIfsc).toBe('HDFC0001234');
      expect(snapshot.destinationBankName).toBe('HDFC Bank');
      expect(snapshot.destinationAccountHolderName).toBe('Deepak Sharma');
    });

    it('a PENDING or REJECTED passbook is not evidence', () => {
      for (const status of [DocumentVerification.PENDING, DocumentVerification.REJECTED]) {
        const snapshot = resolvePayoutDestination(
          { ...assayer, identityVerifiedAt: null },
          { verificationStatus: status, verifiedAt: new Date('2026-01-15T10:00:00Z'), currentVersionId: 'ver-1' },
        );
        expect(snapshot.destinationVerifiedAt).toBeNull();
        expect(snapshot.destinationVerifiedSource).toBeNull();
        expect(snapshot.payoutEvidenceVersionId).toBeNull();
      }
    });
  });

  describe('a verified bank passbook — the primary evidence', () => {
    it('records the document\'s own verification moment and points at its version', () => {
      const verifiedAt = new Date('2026-01-15T10:00:00Z');
      const snapshot = resolvePayoutDestination(
        { ...assayer, identityVerifiedAt: new Date('2025-06-01T00:00:00Z') },
        { verificationStatus: DocumentVerification.VERIFIED, verifiedAt, currentVersionId: 'ver-passbook-1' },
      );
      expect(snapshot.destinationVerifiedAt).toEqual(verifiedAt);
      expect(snapshot.destinationVerifiedSource).toBe(PayoutDestinationEvidence.BANK_PASSBOOK);
      expect(snapshot.payoutEvidenceVersionId).toBe('ver-passbook-1');
    });

    it('is still the passbook tier when the document pre-dates version records', () => {
      // `assayer_documents.current_version_id` is nullable and a document verified before
      // versioning has none. The document is the evidence; the version id is a finer pointer.
      const verifiedAt = new Date('2026-01-15T10:00:00Z');
      const snapshot = resolvePayoutDestination(
        { ...assayer, identityVerifiedAt: null },
        { verificationStatus: DocumentVerification.VERIFIED, verifiedAt, currentVersionId: null },
      );
      expect(snapshot.destinationVerifiedSource).toBe(PayoutDestinationEvidence.BANK_PASSBOOK);
      expect(snapshot.destinationVerifiedAt).toEqual(verifiedAt);
      expect(snapshot.payoutEvidenceVersionId).toBeNull();
    });

    it('falls through when the document reads VERIFIED but records no moment', () => {
      // `verifyDocument` always stamps `verified_at` on a non-PENDING verdict, so this shape can
      // only reach us from an import. There is no moment to record, and the old code answered
      // that with `new Date()` — the fabrication in its purest form.
      const identityVerifiedAt = new Date('2025-06-01T00:00:00Z');
      const snapshot = resolvePayoutDestination(
        { ...assayer, identityVerifiedAt },
        { verificationStatus: DocumentVerification.VERIFIED, verifiedAt: null, currentVersionId: 'ver-1' },
      );
      expect(snapshot.destinationVerifiedSource).toBe(PayoutDestinationEvidence.IDENTITY_DOCUMENT);
      expect(snapshot.destinationVerifiedAt).toEqual(identityVerifiedAt);
      expect(snapshot.payoutEvidenceVersionId).toBeNull();
    });
  });

  describe('an established identity — the documented fallback', () => {
    it('records when identity was established, not when the payout was approved', () => {
      const identityVerifiedAt = new Date('2025-06-01T00:00:00Z');
      const snapshot = resolvePayoutDestination({ ...assayer, identityVerifiedAt }, null);
      expect(snapshot.destinationVerifiedAt).toEqual(identityVerifiedAt);
      expect(snapshot.destinationVerifiedSource).toBe(PayoutDestinationEvidence.IDENTITY_DOCUMENT);
      expect(snapshot.payoutEvidenceVersionId).toBeNull();
    });
  });

  /**
   * The property, stated once: there is no input to this function that produces a timestamp
   * anywhere near "now". Every non-null answer is a value that came in with the evidence.
   */
  it('never invents a timestamp: every claim it makes is one of its inputs', () => {
    const cases: Array<[any, any]> = [
      [{ ...assayer, identityVerifiedAt: null }, null],
      [{ ...assayer, identityVerifiedAt: null }, { verificationStatus: DocumentVerification.PENDING, verifiedAt: new Date() }],
      [{ ...assayer, identityVerifiedAt: new Date('2020-01-01T00:00:00Z') }, null],
      [
        { ...assayer, identityVerifiedAt: null },
        { verificationStatus: DocumentVerification.VERIFIED, verifiedAt: new Date('2021-02-03T04:05:06Z'), currentVersionId: 'v' },
      ],
    ];
    for (const [person, doc] of cases) {
      const snapshot = resolvePayoutDestination(person, doc);
      if (snapshot.destinationVerifiedAt === null) {
        expect(snapshot.destinationVerifiedSource).toBeNull();
        continue;
      }
      const claimed = snapshot.destinationVerifiedAt.getTime();
      expect([person.identityVerifiedAt?.getTime(), doc?.verifiedAt?.getTime()]).toContain(claimed);
      // And it is never the current time, which is the only value the old code could produce
      // when there was nothing behind the claim.
      expect(Math.abs(Date.now() - claimed)).toBeGreaterThan(60_000);
    }
  });

  it('a source is present exactly when a timestamp is — the shape the CHECK constraint enforces', () => {
    const inputs: Array<[any, any]> = [
      [{ ...assayer, identityVerifiedAt: null }, null],
      [{ ...assayer, identityVerifiedAt: new Date() }, null],
      [{ ...assayer, identityVerifiedAt: null }, { verificationStatus: DocumentVerification.VERIFIED, verifiedAt: new Date(), currentVersionId: 'v' }],
      [{ ...assayer, identityVerifiedAt: null }, { verificationStatus: DocumentVerification.REJECTED, verifiedAt: new Date() }],
    ];
    for (const [person, doc] of inputs) {
      const s = resolvePayoutDestination(person, doc);
      expect(s.destinationVerifiedAt === null).toBe(s.destinationVerifiedSource === null);
      // And an evidence pointer never exists without a timestamp behind it.
      if (s.payoutEvidenceVersionId !== null) expect(s.destinationVerifiedAt).not.toBeNull();
    }
  });
});
