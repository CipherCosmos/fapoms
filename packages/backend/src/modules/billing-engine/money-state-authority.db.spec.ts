import { DataSource } from 'typeorm';
import { AppDataSource } from '../../infrastructure/database/data-source';
import { AssayerPayableStatus, BillingState, InvoiceStatus } from '@fapoms/shared';
import { DEAD_PAYABLE_STATUSES, DEAD_BILLING_STATES } from '@fapoms/shared';

/**
 * Which money states exist is answered in two places, and they must not drift.
 *
 * `packages/shared/src/state-machines.ts` used to carry a third answer — `BILLING_STATE_TRANSITIONS`,
 * `INVOICE_TRANSITIONS` and `PAYABLE_TRANSITIONS`, with no consumers in any package. They were
 * deleted rather than wired, and that file now says where each question about money actually lives.
 * The first of those homes is this pair: the TypeScript enum and the database CHECK constraint.
 *
 * A comment naming a home is only worth what enforces it. This is the enforcement. It reads the
 * constraints out of the live catalogue rather than out of a migration file, because the migration
 * is what was *intended* and the catalogue is what is *true* — and those parted company once
 * already, when a CHECK written to refuse a fabricated payout verification accepted the exact row
 * it was added to refuse.
 *
 * Set equality both ways, deliberately. A value in the enum and not the constraint is a write the
 * database will reject at runtime; a value in the constraint and not the enum is a row the
 * application cannot name, which is how a status ends up treated as live because no one remembered
 * it existed.
 */
describe('the money states the code names and the database permits are the same set', () => {
  jest.setTimeout(60000);

  let ds: DataSource;

  /** Pulls the allowed literals straight out of the constraint's own definition. */
  const allowedBy = async (constraint: string): Promise<string[]> => {
    const [row] = await ds.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraint],
    );
    if (!row?.def) throw new Error(`constraint ${constraint} does not exist`);
    return [...String(row.def).matchAll(/'([A-Z_]+)'::character varying/g)]
      .map((m) => m[1])
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort();
  };

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    ds = AppDataSource;
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it.each([
    ['CK_assayer_payables_status', AssayerPayableStatus],
    ['CK_billing_entries_state', BillingState],
    ['CK_billing_invoices_status', InvoiceStatus],
  ])('%s permits exactly the values its enum names', async (constraint, enumObject) => {
    const inCode = Object.values(enumObject as Record<string, string>).sort();
    const inDatabase = await allowedBy(constraint as string);

    expect(inDatabase).toEqual(inCode);
  });

  /**
   * `VOIDED` is here by name rather than by coverage.
   *
   * The deleted `PAYABLE_TRANSITIONS` omitted it entirely, while the enum, this constraint and
   * `voidPayable()` all had it — and it is the state the whole reopen-and-redo path turns on: a
   * voided payable is history, and treating it as a live booking is what stopped a redone audit
   * ever being paid for. If it disappears again, this says so in one line instead of leaving it to
   * be inferred from a set difference.
   */
  it('still permits VOIDED, which is the state a redone audit depends on', async () => {
    expect(await allowedBy('CK_assayer_payables_status')).toContain('VOIDED');
    expect(DEAD_PAYABLE_STATUSES).toContain(AssayerPayableStatus.VOIDED);
  });

  /** The same, for the client side of the ledger. */
  it('still permits CANCELLED on a client line, and still calls it dead', async () => {
    expect(await allowedBy('CK_billing_entries_state')).toContain('CANCELLED');
    expect(DEAD_BILLING_STATES).toContain(BillingState.CANCELLED);
  });

  /**
   * Every state the liveness rule calls dead must be a state the database will accept, or the rule
   * is filtering for something unwritable and the partial unique indexes built from it — migration
   * 1798000000000 — are indexing a predicate nothing can satisfy.
   */
  it('names no dead state the database would refuse to store', async () => {
    const payables = await allowedBy('CK_assayer_payables_status');
    const entries = await allowedBy('CK_billing_entries_state');

    for (const dead of DEAD_PAYABLE_STATUSES) expect(payables).toContain(dead);
    for (const dead of DEAD_BILLING_STATES) expect(entries).toContain(dead);
  });
});
