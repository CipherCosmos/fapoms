import { BillingFinalApproval1801200000000 } from './migrations/1801200000000-BillingFinalApproval';

/**
 * THE HOD'S FINAL BILLING APPROVAL — what the migration does to a live book (2026-09-24).
 *
 * The data rule is the part that matters: nothing is grandfathered. An APPROVED-but-unpaid payout
 * or an APPROVED assayer bill is waiting for the HOD from the moment this runs, so the migration
 * must never write `hod_approved_*`. PAID and ISSUED records are not touched at all. The schema
 * itself is proven from empty by `npm run verify:migrations`; this pins the rule and the grant.
 *
 * Lives beside `migrations/`, not in it: the runtime glob loads every `migrations/*.ts` as a migration.
 */
describe('BillingFinalApproval1801200000000', () => {
  const run = async (direction: 'up' | 'down') => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const queryRunner: any = {
      query: jest.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return []; }),
    };
    await new BillingFinalApproval1801200000000()[direction](queryRunner);
    return calls;
  };
  const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

  it('adds the final-approval columns to payables, assayer bills and client invoices', async () => {
    const sql = (await run('up')).map((c) => flat(c.sql));
    for (const table of ['assayer_payables', 'assayer_invoices', 'billing_invoices']) {
      for (const col of ['hod_approved_at', 'hod_approved_by', 'hod_rejected_at', 'hod_rejected_by', 'hod_reject_reason']) {
        expect(sql).toContainEqual(expect.stringContaining(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col}"`));
      }
    }
    expect(sql).toContainEqual(expect.stringContaining(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "hod_requested_by"`));
  });

  it('widens the client-invoice status check to the two new states, keeping the old four', async () => {
    const sql = (await run('up')).map((c) => flat(c.sql));
    expect(sql).toContainEqual(
      `ALTER TABLE "billing_invoices" ADD CONSTRAINT "CK_billing_invoices_status" CHECK (status IN ('DRAFT','AWAITING_HOD','HOD_APPROVED','ISSUED','PAID','CANCELLED'))`,
    );
  });

  it('backfills NO final approval — what was approved but unpaid at deploy waits for the HOD', async () => {
    const calls = await run('up');
    const writes = calls.map((c) => flat(c.sql)).filter((s) => /^(UPDATE|INSERT)/i.test(s));
    // The only writes are the permission catalogue and its description — never a billing row.
    for (const w of writes) {
      expect(w).not.toMatch(/assayer_payables|assayer_invoices|billing_invoices/);
      expect(w).not.toMatch(/hod_approved/);
    }
    // And no status is moved: PAID/ISSUED untouched, APPROVED stays APPROVED (it is what the queue lists).
    expect(calls.some((c) => /SET\s+status/i.test(c.sql))).toBe(false);
  });

  it('creates the permission and grants it to Admin and Developer — not to the office', async () => {
    const calls = await run('up');
    const created = calls.find((c) => c.sql.includes('INSERT INTO permissions') && c.params?.[0] === 'BILLING' && c.params?.[1] === 'FINAL_APPROVE');
    expect(created?.params?.slice(0, 3)).toEqual(['BILLING', 'FINAL_APPROVE', 'ORGANIZATION']);
    const granted = calls
      .filter((c) => c.sql.includes('INSERT INTO role_permissions') && c.params?.[1] === 'BILLING' && c.params?.[2] === 'FINAL_APPROVE')
      .map((c) => c.params?.[0]);
    expect(granted.sort()).toEqual(['ADMIN', 'DEVELOPER']);
    expect(calls.map((c) => flat(c.sql))).toContainEqual(expect.stringContaining(`SET description = 'Final billing approval (HOD)'`));
  });

  it('refuses a final approval on a payable the office has not approved (database check)', async () => {
    const sql = (await run('up')).map((c) => flat(c.sql));
    expect(sql).toContainEqual(expect.stringContaining(`CHECK (hod_approved_at IS NULL OR status IN ('APPROVED','PAID','VOIDED'))`));
  });

  it('down returns the new states to where the office left them and restores the old check', async () => {
    const sql = (await run('down')).map((c) => flat(c.sql));
    expect(sql).toContainEqual(`UPDATE "billing_invoices" SET status = 'DRAFT' WHERE status IN ('AWAITING_HOD','HOD_APPROVED')`);
    expect(sql).toContainEqual(`UPDATE "assayer_invoices" SET status = 'APPROVED' WHERE status = 'HOD_APPROVED'`);
    expect(sql).toContainEqual(`ALTER TABLE "billing_invoices" ADD CONSTRAINT "CK_billing_invoices_status" CHECK (status IN ('DRAFT','ISSUED','PAID','CANCELLED'))`);
  });
});
