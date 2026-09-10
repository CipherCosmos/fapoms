import { DataSource, QueryRunner } from 'typeorm';
import * as crypto from 'crypto';
import { AppDataSource } from '../../infrastructure/database/data-source';
import { DocumentVerification } from '@fapoms/shared';
import {
  resolvePayoutDestination,
  PayoutDestinationEvidence,
  PayoutDestinationSnapshot,
} from './payout-destination';

/**
 * The database half of "a payout may not claim a verification that never happened".
 *
 * `payout-destination.spec.ts` proves the decision function returns the honest answer. It cannot
 * prove the two things that actually keep the defect from coming back:
 *
 *  1. that the database REFUSES the shape the old code produced — a `destination_verified_at`
 *     with nothing behind it — so a third writer, an import, or a hand-run UPDATE cannot
 *     reintroduce it the way the second writer did the first time;
 *  2. that what `resolvePayoutDestination` returns is actually storable. A rule enforced in two
 *     places can disagree with itself, and a CHECK the application routinely violates would be
 *     found in production rather than here.
 *
 * Both need real Postgres, so both are here. Everything runs inside one transaction that is
 * always rolled back, and the rows carry no foreign keys to anything real, so nothing is
 * committed and nothing collides with concurrent work.
 *
 * The constraints under test are `chk_assayer_payables_destination_evidence` and
 * `chk_billing_payments_destination_evidence`, added by migration 1797300000000 and corrected by
 * 1797600000000. The correction is why this file exists at all: as first written, the CHECK
 * accepted `destination_verified_at = now(), destination_verified_source = NULL` — the one row it
 * was added to refuse — because `NULL IN (...)` is NULL, `FALSE OR NULL` is NULL, and a CHECK
 * treats NULL as satisfied. Reading the constraint did not show that. Inserting the row did.
 */
describe('payout destination evidence, against the real constraints', () => {
  jest.setTimeout(120000);

  const CHECK_VIOLATION = '23514';
  let ds: DataSource;
  let qr: QueryRunner;

  const RUN = `PDE${Date.now().toString().slice(-9)}`;
  let seq = 0;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    ds = AppDataSource;
    qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
  });

  afterAll(async () => {
    if (qr) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      await qr.release();
    }
    if (ds?.isInitialized) await ds.destroy();
  });

  /**
   * What the six destination columns are allowed to hold. Every field is optional so a case can
   * state only what it is about; anything unstated is NULL, which is the unverified shape.
   */
  interface Destination {
    payoutEvidenceVersionId?: string | null;
    destinationVerifiedAt?: Date | null;
    destinationVerifiedSource?: string | null;
  }

  /**
   * Insert one row and report whether the database took it.
   *
   * A SAVEPOINT per attempt, because a failed statement aborts the surrounding transaction and
   * every later case would then fail for the wrong reason. Only a check-constraint violation is
   * reported as a refusal — a missing column or a bad enum value would be a broken test, and is
   * rethrown so it reads as one.
   */
  const attempt = async (table: 'assayer_payables' | 'billing_payments', d: Destination): Promise<string | 'ACCEPTED'> => {
    const savepoint = `sp_${(seq += 1)}`;
    await qr.query(`SAVEPOINT ${savepoint}`);
    const values = [d.payoutEvidenceVersionId ?? null, d.destinationVerifiedAt ?? null, d.destinationVerifiedSource ?? null];
    try {
      if (table === 'assayer_payables') {
        await qr.query(
          `INSERT INTO assayer_payables
             (id, payable_number, assayer_id, assignment_id, status, base_amount, travel_amount,
              tax_amount, tds_amount, total_amount, currency, paid_amount, on_hold, pre_invoicing_era,
              version, is_active, payout_evidence_version_id, destination_verified_at, destination_verified_source)
           VALUES ($4,$5,$6,$7,'PENDING',100,0,0,0,100,'INR',0,false,false,1,true,$1,$2,$3)`,
          [...values, crypto.randomUUID(), `${RUN}-${seq}`, crypto.randomUUID(), crypto.randomUUID()],
        );
      } else {
        await qr.query(
          `INSERT INTO billing_payments
             (id, payment_reference, direction, method, amount, currency, version, is_active,
              payout_evidence_version_id, destination_verified_at, destination_verified_source)
           VALUES ($4,$5,'OUTBOUND','BANK_TRANSFER',100,'INR',1,true,$1,$2,$3)`,
          [...values, crypto.randomUUID(), `${RUN}-${seq}`],
        );
      }
      await qr.query(`RELEASE SAVEPOINT ${savepoint}`);
      return 'ACCEPTED';
    } catch (err: any) {
      await qr.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      if (err?.code !== CHECK_VIOLATION) throw err;
      return String(err.constraint ?? 'unnamed check');
    }
  };

  const TABLES = ['assayer_payables', 'billing_payments'] as const;
  const constraintFor = (t: (typeof TABLES)[number]) =>
    t === 'assayer_payables'
      ? 'chk_assayer_payables_destination_evidence'
      : 'chk_billing_payments_destination_evidence';

  describe('the shape the defect produced is now unrepresentable', () => {
    it.each(TABLES)('%s refuses a verification timestamp with no evidence named', async (table) => {
      // This is exactly what `?? new Date()` wrote: "verified, this second", no source, no
      // pointer, for an assayer with no passbook and no established identity.
      expect(await attempt(table, { destinationVerifiedAt: new Date() })).toBe(constraintFor(table));
    });

    it.each(TABLES)('%s refuses an evidence pointer with no timestamp behind it', async (table) => {
      expect(await attempt(table, { payoutEvidenceVersionId: crypto.randomUUID() })).toBe(constraintFor(table));
    });

    it.each(TABLES)('%s refuses a source nobody can act on', async (table) => {
      // A free-text column: only the two rungs of the ladder are a claim anyone can check.
      expect(await attempt(table, { destinationVerifiedAt: new Date(), destinationVerifiedSource: 'TRUST_ME' }))
        .toBe(constraintFor(table));
      expect(await attempt(table, { destinationVerifiedAt: new Date(), destinationVerifiedSource: '' }))
        .toBe(constraintFor(table));
    });

    it.each(TABLES)('%s refuses a source with no timestamp, which claims evidence and dates nothing', async (table) => {
      expect(await attempt(table, { destinationVerifiedSource: PayoutDestinationEvidence.BANK_PASSBOOK }))
        .toBe(constraintFor(table));
    });

    it.each(TABLES)('%s refuses an identity-backed claim that also points at a document version', async (table) => {
      // The pointer means "this claim rests on that verified document version". An identity-tier
      // claim rests on `assayers.identity_verified_at` and points at no document, so a row
      // carrying both names two different pieces of evidence for one assertion.
      expect(await attempt(table, {
        destinationVerifiedAt: new Date(),
        destinationVerifiedSource: PayoutDestinationEvidence.IDENTITY_DOCUMENT,
        payoutEvidenceVersionId: crypto.randomUUID(),
      })).toBe(constraintFor(table));
    });
  });

  describe('every honest shape is still storable', () => {
    it.each(TABLES)('%s accepts a payout with no verification claim at all', async (table) => {
      // The point of the fix: unverified must be an ordinary, writable state. If the constraint
      // refused this, approval would break for everyone whose paperwork is incomplete.
      expect(await attempt(table, {})).toBe('ACCEPTED');
    });

    it.each(TABLES)('%s accepts a passbook-backed claim, with and without a version pointer', async (table) => {
      const verifiedAt = new Date('2026-03-04T05:06:07Z');
      expect(await attempt(table, {
        destinationVerifiedAt: verifiedAt,
        destinationVerifiedSource: PayoutDestinationEvidence.BANK_PASSBOOK,
        payoutEvidenceVersionId: crypto.randomUUID(),
      })).toBe('ACCEPTED');
      // Documents verified before versioning existed have no `current_version_id`. The document
      // is the evidence; requiring the pointer would refuse people whose paperwork is in order.
      expect(await attempt(table, {
        destinationVerifiedAt: verifiedAt,
        destinationVerifiedSource: PayoutDestinationEvidence.BANK_PASSBOOK,
      })).toBe('ACCEPTED');
    });

    it.each(TABLES)('%s accepts an identity-backed claim', async (table) => {
      expect(await attempt(table, {
        destinationVerifiedAt: new Date('2025-11-30T00:00:00Z'),
        destinationVerifiedSource: PayoutDestinationEvidence.IDENTITY_DOCUMENT,
      })).toBe('ACCEPTED');
    });
  });

  describe('the code and the constraint agree', () => {
    const store = (table: (typeof TABLES)[number], s: PayoutDestinationSnapshot) =>
      attempt(table, {
        payoutEvidenceVersionId: s.payoutEvidenceVersionId,
        destinationVerifiedAt: s.destinationVerifiedAt,
        destinationVerifiedSource: s.destinationVerifiedSource,
      });

    const bank = { bankAccountNumber: '123456789012', ifscCode: 'sbin0001234', displayName: 'A Person' };
    const verifiedAt = new Date('2026-01-02T03:04:05Z');

    /** The three rungs, and the two near-misses that must fall to the rung below. */
    const CASES: Array<{ name: string; snapshot: () => PayoutDestinationSnapshot; expectSource: string | null }> = [
      {
        name: 'a verified passbook',
        snapshot: () => resolvePayoutDestination(bank, {
          verificationStatus: DocumentVerification.VERIFIED, verifiedAt, currentVersionId: crypto.randomUUID(),
        }),
        expectSource: PayoutDestinationEvidence.BANK_PASSBOOK,
      },
      {
        name: 'no passbook, but an established identity',
        snapshot: () => resolvePayoutDestination({ ...bank, identityVerifiedAt: verifiedAt }, null),
        expectSource: PayoutDestinationEvidence.IDENTITY_DOCUMENT,
      },
      {
        name: 'a REJECTED passbook and an established identity',
        snapshot: () => resolvePayoutDestination(
          { ...bank, identityVerifiedAt: verifiedAt },
          { verificationStatus: DocumentVerification.REJECTED, verifiedAt, currentVersionId: crypto.randomUUID() },
        ),
        expectSource: PayoutDestinationEvidence.IDENTITY_DOCUMENT,
      },
      {
        name: 'a VERIFIED passbook with no verification date, and no identity',
        snapshot: () => resolvePayoutDestination(bank, {
          verificationStatus: DocumentVerification.VERIFIED, verifiedAt: null, currentVersionId: crypto.randomUUID(),
        }),
        expectSource: null,
      },
      {
        name: 'no evidence of any kind',
        snapshot: () => resolvePayoutDestination(bank, null),
        expectSource: null,
      },
    ];

    it.each(CASES)('$name is stored as it stands, in both tables', async ({ snapshot, expectSource }) => {
      const s = snapshot();
      expect(s.destinationVerifiedSource).toBe(expectSource);
      // The invariant the constraint encodes, checked on the function's own output first: a
      // timestamp exists exactly when a source does.
      expect(s.destinationVerifiedAt !== null).toBe(s.destinationVerifiedSource !== null);
      for (const table of TABLES) expect(await store(table, s)).toBe('ACCEPTED');
    });

    it('and what the old expression produced is refused, in both tables', async () => {
      // The pre-fix line, reconstructed: `?? new Date()` on the tier-2 branch, for an assayer
      // with no passbook and no identity. It is the only difference between this and the last
      // case above, and it is now a constraint violation rather than a stored assertion.
      const preFix = {
        ...resolvePayoutDestination(bank, null),
        destinationVerifiedAt: new Date(), // ?? new Date()
      };
      expect(preFix.destinationVerifiedSource).toBeNull();
      for (const table of TABLES) expect(await store(table, preFix)).toBe(constraintFor(table));
    });
  });
});
