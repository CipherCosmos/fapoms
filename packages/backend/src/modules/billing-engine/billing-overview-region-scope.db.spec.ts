import { DataSource, QueryRunner } from 'typeorm';
import * as crypto from 'crypto';
import { AppDataSource } from '../../infrastructure/database/data-source';
import { BillingEngineService } from './billing-engine.service';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingHistoryEntity } from './history.entity';
import { Region, BillingOverview } from '@fapoms/shared';

/**
 * The numeric half of the `GET /billing-engine/overview` region fix: every figure the endpoint
 * returns to a region-scoped caller, reconciled against an independent calculation over the base
 * tables.
 *
 * ## Why this cannot be a unit test
 *
 * The sibling `billing-overview-region-scope.spec.ts` proves the predicate is *present* on all
 * thirteen statements. It cannot prove the predicate is *right* — a mock manager returns whatever
 * it is told, so a join that double-counts, an `IN` that quietly matches nothing, or an invoice
 * rule that includes a row it should exclude all look identical to a correct one. The user's
 * instruction on this finding was explicit: an incorrect join would silently produce WRONG
 * FINANCIAL FIGURES, which is worse than returning too much data. Only real rows in real Postgres
 * can tell those apart, so this file builds a controlled dataset and checks the arithmetic.
 *
 * ## How the expectation is computed
 *
 * Never by calling the service, and never with the service's own SQL. The rule is re-implemented
 * here in TypeScript — resolve every assignment's region through `project_branches -> branches`,
 * decide membership row by row — and the money is then summed with plain `SUM(...) WHERE id =
 * ANY($1)` statements over the base tables. Two independent formulations of the same rule have to
 * agree on every figure, or something is wrong with one of them.
 *
 * ## Isolation
 *
 * Everything runs inside ONE `REPEATABLE READ` transaction that is always rolled back: the
 * service is constructed from that query runner's `EntityManager`, so its reads and this file's
 * reads see one immutable snapshot even while other work is committing to the same database, and
 * not a single fixture row is ever committed. Nothing to clean up, nothing to collide with.
 *
 * Region A is CENTRAL and region B is NORTH_EAST — regions no other data in this deployment uses,
 * so "region B contributes nothing" is a statement about rows this file can name.
 */
describe('billing overview region scoping, reconciled against the real schema', () => {
  jest.setTimeout(180000);

  const A = Region.CENTRAL;
  const B = Region.NORTH_EAST;
  /** A region with no financial records anywhere — the empty-result case. */
  const EMPTY = Region.SOUTH;

  let ds: DataSource;
  let qr: QueryRunner;
  let service: BillingEngineService;

  const RUN = `FOSDB${Date.now().toString().slice(-9)}`;
  const id: Record<string, string> = {};
  const uid = (tag: string) => (id[tag] ??= crypto.randomUUID());

  /** Rounded the way the service rounds, so a float artefact is never mistaken for a leak. */
  const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
  const num = (v: unknown) => Number(v ?? 0);

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    ds = AppDataSource;
    qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction('REPEATABLE READ');
    await assertRegionsAreEmpty();
    await seed();

    const stagedEnforce: any = { get: async () => 'enforce' };
    const regionGuard: any = {
      stagedMode: async () => (await stagedEnforce.get()) as 'enforce',
    };
    const nil: any = undefined;
    service = new BillingEngineService(
      qr.manager.getRepository(BillingEntryEntity) as any,
      nil, nil, nil,
      qr.manager.getRepository(BillingHistoryEntity) as any,
      nil, nil, nil, nil, regionGuard, nil, nil, nil, nil, nil,
    );
  });

  afterAll(async () => {
    if (qr) {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      await qr.release();
    }
    if (ds?.isInitialized) await ds.destroy();
  });

  /**
   * Refuse to run at all if anything else already has money in region A or B.
   *
   * Several cases below assert ABSOLUTE amounts — `receivables.unbilled` is 10800 for region A,
   * full stop — because a figure built from round thousands is unmistakable in a way a computed
   * expectation is not. That only holds while this file's fixture is the ONLY thing in those two
   * regions, which is why CENTRAL and NORTH_EAST were chosen. It is an assumption about the
   * database, and it was silently untrue the first time somebody put three CENTRAL billing rows
   * in this database for an unrelated reason: three arithmetic assertions failed with numbers
   * 47,200 apart, which reads exactly like the region predicate having broken.
   *
   * So the assumption is now checked, and a violation says what it is. The reconciliation cases —
   * the ones that compute their expectation from the same rows — are unaffected either way; it is
   * only the fixed numbers that need the regions to themselves.
   */
  async function assertRegionsAreEmpty(): Promise<void> {
    const rows = await qr.query(
      `SELECT b.region, count(*)::int AS n
         FROM billing_entries e
         JOIN assignments a ON a.id = e.assignment_id
         JOIN project_branches pb ON pb.id = a.project_branch_id
         JOIN branches b ON b.id = pb.branch_id
        WHERE b.region = ANY($1::text[])
        GROUP BY b.region`,
      [[A, B]],
    );
    if (rows.length > 0) {
      const found = rows.map((r: any) => `${r.n} in ${r.region}`).join(', ');
      throw new Error(
        `This suite needs ${A} and ${B} to itself — its fixed amounts are only unmistakable while ` +
          `nothing else has money there — and found ${found}. Clear those rows, or point the suite ` +
          `at a database that does not have them. (Its reconciliation cases would still be valid; ` +
          `the fixed-amount ones would not.)`,
      );
    }
  }

  // ── The controlled dataset ────────────────────────────────────────────────
  //
  // Amounts are chosen so every figure is unmistakable: region A is built from round thousands,
  // region B from 7x/8x/9x thousands, and the two "attributable to nobody" cases from 5x/6x
  // thousands. No two of the three groups can be confused for one another in a sum.
  //
  //   branches   A: three (two states) — proves multiple branches in one region
  //              B: two
  //              X: one with region NULL — attributable to nobody
  //   projects   A: two — proves multiple projects in one region
  //              B: one
  //              M: one spanning A, B and X — proves the region comes from the BRANCH, never
  //                 from the project or the client
  //   clients    N (region A only), E (region B only), M (both, plus the unattributable rows)
  //   assignment ORPH has project_branch_id NULL — the second shape of "cannot be attributed"

  async function seed(): Promise<void> {
    const q = (sql: string, params: unknown[] = []) => qr.query(sql, params);

    const branch = async (tag: string, region: string | null, state: string) => {
      await q(
        `INSERT INTO branches (id, sol_id, name, address, state, district, city, region, version, is_active,
                               risk_score, complexity, estimated_duration_hours)
         VALUES ($1,$2,$3,'1 Test Rd',$4,$5,$5,$6,1,true,0,'MEDIUM',4)`,
        [uid(tag), `${RUN}-${tag}`, `${RUN} ${tag}`, state, 'City', region],
      );
    };
    await branch('brA1', A, 'Madhya Pradesh');
    await branch('brA2', A, 'Madhya Pradesh');
    await branch('brA3', A, 'Chhattisgarh');
    await branch('brB1', B, 'Assam');
    await branch('brB2', B, 'Meghalaya');
    await branch('brX1', null, 'Goa');

    for (const [tag, code] of [['clN', 'N'], ['clE', 'E'], ['clM', 'M']] as const) {
      await q(
        `INSERT INTO clients (id, client_code, name, display_name, client_type, lifecycle_status, priority, version, is_active)
         VALUES ($1,$2,$3,$3,'BANK','ACTIVE','MEDIUM',1,true)`,
        [uid(tag), `${RUN}${code}`, `${RUN} client ${code}`],
      );
    }

    const project = async (tag: string, client: string) => {
      await q(
        `INSERT INTO projects (id, project_number, name, client_id, status, priority, version, is_active)
         VALUES ($1,$2,$3,$4,'EXECUTION','MEDIUM',1,true)`,
        [uid(tag), `${RUN}-${tag}`, `${RUN} ${tag}`, uid(client)],
      );
    };
    await project('prA1', 'clN');
    await project('prA2', 'clN');
    await project('prB1', 'clE');
    await project('prM1', 'clM');

    const pb = async (tag: string, project: string, br: string) => {
      await q(
        `INSERT INTO project_branches (id, project_id, branch_id, status, priority, version, is_active)
         VALUES ($1,$2,$3,'SCHEDULED','MEDIUM',1,true)`,
        [uid(tag), uid(project), uid(br)],
      );
    };
    await pb('pbA1', 'prA1', 'brA1');
    await pb('pbA2', 'prA1', 'brA2');
    await pb('pbA3', 'prA2', 'brA3');
    await pb('pbB1', 'prB1', 'brB1');
    await pb('pbB2', 'prB1', 'brB2');
    await pb('pbMA1', 'prM1', 'brA1');
    await pb('pbMA2', 'prM1', 'brA2');
    await pb('pbMB1', 'prM1', 'brB1');
    await pb('pbMB2', 'prM1', 'brB2');
    await pb('pbMX1', 'prM1', 'brX1');

    for (const [tag, code] of [['as1', '1'], ['as2', '2']] as const) {
      await q(
        `INSERT INTO assayers (id, assayer_code, first_name, last_name, display_name, address, state, district, city,
                               status, lifecycle_status, version, is_active)
         VALUES ($1,$2,'Fos','Db',$3,'1 Field Rd','Madhya Pradesh','City','City','ACTIVE','ACTIVE',1,true)`,
        [uid(tag), `${RUN}-AS${code}`, `${RUN} assayer ${code}`],
      );
    }

    /** `fee` is what a payable's snapshot will claim; a different `agreed` raises FEE_CHANGED. */
    const asg = async (tag: string, project: string, branchTag: string | null, assayer: string, agreed: number) => {
      await q(
        `INSERT INTO assignments (id, assignment_number, project_id, project_branch_id, assayer_id, status, priority,
                                  agreed_fee, proposed_fee, completion_date, version, entity_version, negotiation_count,
                                  auto_schedule, sla_status, is_active)
         VALUES ($1,$2,$3,$4,$5,'COMPLETED','MEDIUM',$6,$6,CURRENT_DATE-20,1,1,0,false,'ON_TRACK',true)`,
        [uid(tag), `${RUN}-${tag}`, uid(project), branchTag ? uid(branchTag) : null, uid(assayer), agreed],
      );
    };
    await asg('aA1', 'prA1', 'pbA1', 'as1', 1000);
    await asg('aA2', 'prA1', 'pbA2', 'as1', 2500); // snapshot says 2000 -> FEE_CHANGED
    await asg('aA3', 'prA2', 'pbA3', 'as1', 3000);
    await asg('aMA', 'prM1', 'pbMA1', 'as1', 4000);
    await asg('aA5', 'prA2', 'pbA3', 'as1', 0);
    await asg('aA6', 'prA1', 'pbA1', 'as1', 0);   // entry but no payable -> UNBOOKED
    await asg('aA4', 'prM1', 'pbMA2', 'as1', 0);
    await asg('aB1', 'prB1', 'pbB1', 'as2', 7000);
    await asg('aB2', 'prB1', 'pbB2', 'as2', 0);   // neither entry nor payable -> UNBOOKED (B)
    await asg('aMB', 'prM1', 'pbMB1', 'as2', 9000); // snapshot says 8000 -> FEE_CHANGED (B)
    await asg('aB3', 'prM1', 'pbMB2', 'as2', 0);
    await asg('aB4', 'prB1', 'pbB2', 'as2', 0);
    await asg('aMX', 'prM1', 'pbMX1', 'as1', 5000); // branch has a NULL region
    await asg('aOR', 'prM1', null, 'as1', 6000);    // no project_branch at all

    const payable = async (
      tag: string, asgTag: string, client: string, status: string, onHold: boolean,
      base: number, travel: number, tds: number, total: number, paid: number,
      snapshot: { settled: boolean; feeAmount: number },
    ) => {
      await q(
        `INSERT INTO assayer_payables (id, payable_number, assayer_id, client_id, assignment_id, status,
                                       base_amount, travel_amount, tax_amount, tds_amount, total_amount, currency,
                                       paid_amount, on_hold, rate_snapshot, pre_invoicing_era, version, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,'INR',$11,$12,$13::jsonb,false,1,true)`,
        [uid(tag), `${RUN}-${tag}`, uid('as1'), uid(client), uid(asgTag), status,
          base, travel, tds, total, paid, onHold, JSON.stringify(snapshot)],
      );
    };
    await payable('pA1', 'aA1', 'clN', 'PENDING', false, 1000, 100, 110, 990, 0, { settled: false, feeAmount: 1000 });
    await payable('pA2', 'aA2', 'clN', 'APPROVED', false, 2000, 200, 220, 1980, 0, { settled: true, feeAmount: 2000 });
    await payable('pA3', 'aA3', 'clN', 'PAID', false, 3000, 300, 330, 2970, 2970, { settled: true, feeAmount: 3000 });
    await payable('pMA', 'aMA', 'clM', 'PENDING', true, 4000, 400, 440, 3960, 0, { settled: true, feeAmount: 4000 });
    await payable('pB1', 'aB1', 'clE', 'PENDING', false, 7000, 700, 770, 6930, 0, { settled: false, feeAmount: 7000 });
    await payable('pMB', 'aMB', 'clM', 'PAID', false, 8000, 800, 880, 7920, 7920, { settled: true, feeAmount: 8000 });
    // The two unattributable assignments each raise ONE attention item, and they have to: the
    // "region A names nothing unattributable" test below asserts their absence, and an absence is
    // only evidence when the row would otherwise be there. `aMX`'s snapshot disagrees with its
    // 5000 agreed fee (FEE_CHANGED) and `aOR`'s says the fee was never agreed (UNSETTLED_FEE).
    // Neither field is summed into any figure — `rate_snapshot` is read by the attention queries
    // and by nothing else — so this changes what the list names and no amount anywhere.
    await payable('pMX', 'aMX', 'clM', 'PENDING', false, 5000, 500, 550, 4950, 0, { settled: true, feeAmount: 4500 });
    await payable('pOR', 'aOR', 'clM', 'PENDING', false, 6000, 600, 660, 5940, 0, { settled: false, feeAmount: 6000 });

    const invoice = async (
      tag: string, client: string, status: string, subtotal: number, tax: number, tds: number,
      total: number, paid: number, outstanding: number, dueOffsetDays: number,
    ) => {
      await q(
        `INSERT INTO billing_invoices (id, invoice_number, client_id, status, issue_date, due_date, currency,
                                       subtotal, tax_amount, tds_amount, total, paid_amount, outstanding_amount,
                                       version, is_active)
         VALUES ($1,$2,$3,$4,(CURRENT_DATE - ($5::int) - 10),(CURRENT_DATE - ($5::int)),'INR',$6,$7,$8,$9,$10,$11,1,true)`,
        [uid(tag), `${RUN}-${tag}`, uid(client), status, dueOffsetDays, subtotal, tax, tds, total, paid, outstanding],
      );
    };
    await invoice('invA', 'clN', 'ISSUED', 30000, 5400, 3000, 32400, 12400, 20000, 10);   // d1_30
    await invoice('invB', 'clM', 'ISSUED', 80000, 14400, 8000, 86400, 6400, 80000, 40);   // d31_60
    await invoice('invX', 'clM', 'ISSUED', 50000, 9000, 5000, 54000, 4000, 50000, 100);   // d90_plus, unattributable
    await invoice('invMIX', 'clM', 'ISSUED', 23000, 4140, 2300, 24840, 840, 24000, 70);   // d61_90, spans A and B
    await invoice('invPAID', 'clN', 'PAID', 5000, 900, 500, 5400, 5400, 0, 20);
    await invoice('invEMPTY', 'clN', 'ISSUED', 3000, 0, 0, 3000, 0, 3000, 5);             // no lines at all
    await invoice('invCANC', 'clN', 'CANCELLED', 6000, 1080, 600, 6480, 0, 6480, 15);

    const entry = async (
      tag: string, asgTag: string, client: string, state: string, onHold: boolean,
      taxable: number, tax: number, tds: number, total: number, invoiceTag: string | null,
    ) => {
      await q(
        `INSERT INTO billing_entries (id, entry_number, client_id, assignment_id, assayer_id, state, service_date,
                                      base_amount, travel_amount, adjustment_amount, tax_rate, taxable_amount, tax_amount,
                                      tds_rate, tds_amount, total_amount, currency, paid_amount, outstanding_amount,
                                      invoice_id, on_hold, version, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE-20,$7,0,0,18,$7,$8,10,$9,$10,'INR',0,$10,$11,$12,1,true)`,
        [uid(tag), `${RUN}-${tag}`, uid(client), uid(asgTag), uid('as1'), state,
          taxable, tax, tds, total, invoiceTag ? uid(invoiceTag) : null, onHold],
      );
    };
    await entry('eA1', 'aA1', 'clN', 'UNBILLED', false, 10000, 1800, 1000, 10800, null);
    await entry('eA2', 'aA2', 'clN', 'UNBILLED', true, 20000, 3600, 2000, 21600, null);
    await entry('eA3', 'aA3', 'clN', 'INVOICED', false, 30000, 5400, 3000, 32400, 'invA');
    await entry('eMA', 'aMA', 'clM', 'CANCELLED', false, 40000, 7200, 4000, 43200, null);
    await entry('eA5', 'aA5', 'clN', 'INVOICED', false, 5000, 900, 500, 5400, 'invPAID');
    await entry('eA6', 'aA6', 'clN', 'INVOICED', false, 6000, 1080, 600, 6480, 'invCANC');
    await entry('eA4', 'aA4', 'clM', 'INVOICED', false, 11000, 1980, 1100, 11880, 'invMIX');
    await entry('eB1', 'aB1', 'clE', 'UNBILLED', false, 70000, 12600, 7000, 75600, null);
    await entry('eMB', 'aMB', 'clM', 'INVOICED', false, 80000, 14400, 8000, 86400, 'invB');
    await entry('eB3', 'aB3', 'clM', 'INVOICED', false, 12000, 2160, 1200, 12960, 'invMIX');
    await entry('eB4', 'aB4', 'clE', 'UNBILLED', true, 90000, 16200, 9000, 99000, null);
    await entry('eMX', 'aMX', 'clM', 'INVOICED', false, 50000, 9000, 5000, 54000, 'invX');
    await entry('eOR', 'aOR', 'clM', 'UNBILLED', false, 60000, 10800, 6000, 64800, null);

    const payment = async (
      tag: string, direction: string, amount: number, payableTag: string | null, invoiceTag: string | null,
    ) => {
      await q(
        `INSERT INTO billing_payments (id, payment_reference, direction, method, amount, currency, received_date,
                                       payable_id, invoice_id, version, is_active)
         VALUES ($1,$2,$3,'BANK_TRANSFER',$4,'INR',CURRENT_DATE-9,$5,$6,1,true)`,
        [uid(tag), `${RUN}-${tag}`, direction, amount,
          payableTag ? uid(payableTag) : null, invoiceTag ? uid(invoiceTag) : null],
      );
    };
    await payment('mOutA', 'OUTBOUND', 2970, 'pA3', null);
    await payment('mOutB', 'OUTBOUND', 7920, 'pMB', null);
    await payment('mInA', 'INBOUND', 12400, null, 'invA');
    await payment('mInAP', 'INBOUND', 5400, null, 'invPAID');
    await payment('mInB', 'INBOUND', 6400, null, 'invB');
    await payment('mInMIX', 'INBOUND', 840, null, 'invMIX');
    await payment('mInX', 'INBOUND', 4000, null, 'invX');
    await payment('mOrphan', 'OUTBOUND', 1234, null, null);

    const history = async (tag: string, asgTag: string | null, action: string, entityTag: string) => {
      await q(
        `INSERT INTO billing_history (id, assignment_id, entity_type, entity_id, action, user_name, version, is_active)
         VALUES ($1,$2,'ENTRY',$3,$4,$5,1,true)`,
        [uid(tag), asgTag ? uid(asgTag) : null, uid(entityTag), action, `${RUN} fixture`],
      );
    };
    await history('hA1', 'aA1', `${RUN}_A1_BOOKED`, 'eA1');
    await history('hA2', 'aA2', `${RUN}_A2_HELD`, 'eA2');
    await history('hA3', 'aA3', `${RUN}_A3_PAID`, 'eA3');
    await history('hB1', 'aB1', `${RUN}_B1_BOOKED`, 'eB1');
    await history('hB2', 'aMB', `${RUN}_MB_PAID`, 'eMB');
    await history('hX', 'aMX', `${RUN}_X_BOOKED`, 'eMX');
    await history('hNone', null, `${RUN}_NO_ASSIGNMENT`, 'eOR');
  }

  // ── The independent calculation ───────────────────────────────────────────

  interface Membership {
    assignments: string[];
    payables: string[];
    entries: string[];
    invoices: string[];
    payments: string[];
    history: string[];
  }

  /**
   * The region rule, re-implemented from the schema rather than from the service's SQL: resolve
   * each assignment's region through its project branch's branch, then decide each row.
   */
  async function membership(regions: string[]): Promise<Membership> {
    const asgRows: any[] = await qr.query(
      `SELECT a.id, b.region
         FROM assignments a
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         LEFT JOIN branches b ON b.id = pb.branch_id`,
    );
    const regionOf = new Map<string, string | null>(asgRows.map((r) => [r.id, r.region ?? null]));
    const inRegion = (assignmentId: string | null): boolean => {
      if (!assignmentId) return false;
      const region = regionOf.get(assignmentId) ?? null;
      return !!region && regions.includes(region);
    };

    const payableRows: any[] = await qr.query(
      `SELECT id, assignment_id FROM assayer_payables WHERE is_active = true`,
    );
    const entryRows: any[] = await qr.query(`SELECT id, assignment_id, invoice_id FROM billing_entries`);
    const invoiceRows: any[] = await qr.query(`SELECT id FROM billing_invoices WHERE is_active = true`);
    const paymentRows: any[] = await qr.query(
      `SELECT id, payable_id, invoice_id FROM billing_payments WHERE is_active = true`,
    );
    const historyRows: any[] = await qr.query(`SELECT id, assignment_id FROM billing_history`);

    // An invoice's regions are the distinct, non-null regions of its lines. It is in scope when
    // there is at least one AND every one of them is held. (`billing_entries` is not filtered by
    // is_active here, matching `assertInvoiceInScope`/`findInvoicesPage`.)
    const linesOf = new Map<string, Array<string | null>>();
    for (const e of entryRows) {
      if (!e.invoice_id) continue;
      const list = linesOf.get(e.invoice_id) ?? [];
      list.push(e.assignment_id ? regionOf.get(e.assignment_id) ?? null : null);
      linesOf.set(e.invoice_id, list);
    }
    const invoiceInScope = (invoiceId: string): boolean => {
      const resolved = (linesOf.get(invoiceId) ?? []).filter((x): x is string => !!x);
      return resolved.length > 0 && resolved.every((region) => regions.includes(region));
    };

    const payables = payableRows.filter((p) => inRegion(p.assignment_id)).map((p) => p.id);
    const invoices = invoiceRows.filter((i) => invoiceInScope(i.id)).map((i) => i.id);
    const payableSet = new Set(payables);
    const invoiceSet = new Set(invoices);

    return {
      assignments: asgRows.filter((a) => inRegion(a.id)).map((a) => a.id),
      payables,
      entries: entryRows.filter((e) => inRegion(e.assignment_id)).map((e) => e.id),
      invoices,
      payments: paymentRows
        .filter((m) => (m.payable_id && payableSet.has(m.payable_id)) || (m.invoice_id && invoiceSet.has(m.invoice_id)))
        .map((m) => m.id),
      history: historyRows.filter((h) => inRegion(h.assignment_id)).map((h) => h.id),
    };
  }

  /** `SUM(expr)` over exactly the named rows. The independent figure, straight from the table. */
  async function sumOf(table: string, ids: string[], expr: string, where = 'true'): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await qr.query(
      `SELECT COALESCE(SUM(${expr}), 0) AS v FROM ${table} WHERE id = ANY($1::uuid[]) AND (${where})`,
      [ids],
    );
    return r2(num(rows[0].v));
  }

  async function countOf(table: string, ids: string[], where = 'true'): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await qr.query(
      `SELECT COUNT(*)::int AS v FROM ${table} WHERE id = ANY($1::uuid[]) AND (${where})`,
      [ids],
    );
    return num(rows[0].v);
  }

  const scoped = (regions: string[]) => service.overview({ regions: regions as Region[] });

  // ── Query 1 — assayer_payables ────────────────────────────────────────────

  describe('query 1 of 8 — payouts, from assayer_payables', () => {
    it('every payout figure equals the independent sum over region A payables', async () => {
      const m = await membership([A]);
      const out = await scoped([A]);
      const live = 'is_active = true';
      expect(out.payouts.due).toBe(await sumOf('assayer_payables', m.payables, 'total_amount - paid_amount', `${live} AND status = 'PENDING' AND on_hold = false`));
      expect(out.payouts.approved).toBe(await sumOf('assayer_payables', m.payables, 'total_amount - paid_amount', `${live} AND status = 'APPROVED' AND on_hold = false`));
      expect(out.payouts.paid).toBe(await sumOf('assayer_payables', m.payables, 'paid_amount', live));
      expect(out.payouts.held).toBe(await sumOf('assayer_payables', m.payables, 'total_amount - paid_amount', `${live} AND on_hold = true`));
      expect(out.payouts.dueCount).toBe(await countOf('assayer_payables', m.payables, `${live} AND status = 'PENDING' AND on_hold = false`));
      expect(out.payouts.approvedCount).toBe(await countOf('assayer_payables', m.payables, `${live} AND status = 'APPROVED' AND on_hold = false`));
      expect(out.payouts.heldCount).toBe(await countOf('assayer_payables', m.payables, `${live} AND on_hold = true`));
      expect(out.margin.cost).toBe(await sumOf('assayer_payables', m.payables, 'base_amount + travel_amount', live));
      expect(out.tax.tdsWithheldFromAssayers).toBe(await sumOf('assayer_payables', m.payables, 'tds_amount', live));
    });

    it('matches the amounts this fixture was built to produce', async () => {
      const out = await scoped([A]);
      expect(out.payouts).toEqual({
        due: 990, approved: 1980, paid: 2970, held: 3960,
        dueCount: 1, approvedCount: 1, heldCount: 1,
      });
      expect(out.margin.cost).toBe(11000);            // 1100 + 2200 + 3300 + 4400
      expect(out.tax.tdsWithheldFromAssayers).toBe(1100);
    });

    it('region B payables contribute nothing', async () => {
      const out = await scoped([A]);
      // 6930 (B pending) and 7920 (B paid) are the only two amounts region B could add.
      expect(out.payouts.due).not.toBe(990 + 6930);
      expect(out.payouts.paid).not.toBe(2970 + 7920);
      expect(out.margin.cost).not.toBe(11000 + 7700 + 8800);
    });

    it('a payable with no project branch and one on a null-region branch are excluded', async () => {
      const out = await scoped([A]);
      // 4950 (null-region branch) + 5940 (no project_branch at all) would land in `due`.
      expect(out.payouts.due).toBe(990);
      const both = await scoped([A, B]);
      expect(both.payouts.due).toBe(990 + 6930);      // still neither of the two unattributable ones
    });
  });

  // ── Query 2 — billing_entries ─────────────────────────────────────────────

  describe('query 2 of 8 — receivables and revenue, from billing_entries', () => {
    it('every client-line figure equals the independent sum over region A entries', async () => {
      const m = await membership([A]);
      const out = await scoped([A]);
      const live = 'is_active = true';
      expect(out.receivables.unbilled).toBe(await sumOf('billing_entries', m.entries, 'total_amount', `${live} AND state = 'UNBILLED' AND on_hold = false`));
      expect(out.receivables.held).toBe(await sumOf('billing_entries', m.entries, 'total_amount', `${live} AND on_hold = true AND state <> 'CANCELLED'`));
      expect(out.margin.revenue).toBe(await sumOf('billing_entries', m.entries, 'taxable_amount', `${live} AND state <> 'CANCELLED'`));
      expect(out.tax.gstCollected).toBe(await sumOf('billing_entries', m.entries, 'tax_amount', `${live} AND state <> 'CANCELLED'`));
      expect(out.tax.tdsWithheldByClients).toBe(await sumOf('billing_entries', m.entries, 'tds_amount', `${live} AND state <> 'CANCELLED'`));
    });

    it('matches the amounts this fixture was built to produce', async () => {
      const out = await scoped([A]);
      expect(out.receivables.unbilled).toBe(10800);
      expect(out.receivables.held).toBe(21600);
      expect(out.margin.revenue).toBe(82000);        // 10000+20000+30000+5000+6000+11000, cancelled excluded
      expect(out.tax.gstCollected).toBe(14760);
      expect(out.tax.tdsWithheldByClients).toBe(8200);
    });

    it('region B lines contribute nothing, and margin is the two scoped figures', async () => {
      const out = await scoped([A]);
      expect(out.receivables.unbilled).not.toBe(10800 + 75600);
      expect(out.receivables.held).not.toBe(21600 + 99000);
      expect(out.margin.margin).toBe(r2(out.margin.revenue - out.margin.cost));
      expect(out.margin.margin).toBe(82000 - 11000);
    });
  });

  // ── Query 3 — billing_invoices ────────────────────────────────────────────

  describe('query 3 of 8 — invoiced, collected and outstanding, from billing_invoices', () => {
    it('every invoice figure equals the independent sum over region A invoices', async () => {
      const m = await membership([A]);
      const out = await scoped([A]);
      const live = 'is_active = true';
      expect(out.receivables.invoiced).toBe(await sumOf('billing_invoices', m.invoices, 'total', `${live} AND status IN ('ISSUED','PAID')`));
      expect(out.receivables.collected).toBe(await sumOf('billing_invoices', m.invoices, 'paid_amount', `${live} AND status <> 'CANCELLED'`));
      expect(out.receivables.outstanding).toBe(await sumOf('billing_invoices', m.invoices, 'outstanding_amount', `${live} AND status = 'ISSUED'`));
    });

    it('matches the amounts this fixture was built to produce', async () => {
      const out = await scoped([A]);
      expect(out.receivables.invoiced).toBe(37800);    // 32400 ISSUED + 5400 PAID
      expect(out.receivables.collected).toBe(17800);   // 12400 + 5400, the cancelled one excluded by status
      expect(out.receivables.outstanding).toBe(20000);
    });

    it('an invoice spanning A and B belongs to neither alone, and to both together', async () => {
      const onlyA = await scoped([A]);
      const onlyB = await scoped([B]);
      const both = await scoped([A, B]);
      expect(onlyA.receivables.invoiced).toBe(37800);          // 24840 (mixed) not included
      expect(onlyB.receivables.invoiced).toBe(86400);          // nor here
      expect(both.receivables.invoiced).toBe(37800 + 86400 + 24840);
      expect(both.receivables.outstanding).toBe(20000 + 80000 + 24000);
    });

    it('an invoice with no lines, and one whose lines resolve to no region, belong to nobody', async () => {
      const both = await scoped([A, B]);
      // invEMPTY (3000 outstanding, no lines) and invX (50000 outstanding, null-region line)
      // would each add to `outstanding` if an unresolvable invoice were treated as everyone's.
      expect(both.receivables.outstanding).toBe(124000);
      expect(both.receivables.collected).toBe(25040);          // no 4000 from invX
    });
  });

  // ── Query 4 — billing_invoices, ageing ────────────────────────────────────

  describe('query 4 of 8 — the ageing buckets, from billing_invoices', () => {
    it('every bucket equals the independent calculation over region A invoices', async () => {
      const m = await membership([A]);
      const out = await scoped([A]);
      const rows = await qr.query(
        `SELECT
           COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date IS NULL OR due_date >= CURRENT_DATE), 0) AS current,
           COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date < CURRENT_DATE AND due_date >= CURRENT_DATE - 30), 0) AS d1_30,
           COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date < CURRENT_DATE - 30 AND due_date >= CURRENT_DATE - 60), 0) AS d31_60,
           COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date < CURRENT_DATE - 60 AND due_date >= CURRENT_DATE - 90), 0) AS d61_90,
           COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date < CURRENT_DATE - 90), 0) AS d90_plus
         FROM billing_invoices
        WHERE id = ANY($1::uuid[]) AND is_active = true AND status = 'ISSUED' AND outstanding_amount > 0`,
        [m.invoices.length ? m.invoices : [crypto.randomUUID()]],
      );
      const e = rows[0];
      expect(out.receivables.aging.current).toBe(r2(num(e.current)));
      expect(out.receivables.aging.d1_30).toBe(r2(num(e.d1_30)));
      expect(out.receivables.aging.d31_60).toBe(r2(num(e.d31_60)));
      expect(out.receivables.aging.d61_90).toBe(r2(num(e.d61_90)));
      expect(out.receivables.aging.d90_plus).toBe(r2(num(e.d90_plus)));
    });

    it('the buckets add up to the outstanding figure beside them — the same rows, the same rule', async () => {
      for (const regions of [[A], [B], [A, B]]) {
        const out = await scoped(regions);
        const a = out.receivables.aging;
        expect(r2(a.current + a.d1_30 + a.d31_60 + a.d61_90 + a.d90_plus)).toBe(out.receivables.outstanding);
      }
    });

    it('matches the amounts this fixture was built to produce', async () => {
      expect((await scoped([A])).receivables.aging).toEqual({ current: 0, d1_30: 20000, d31_60: 0, d61_90: 0, d90_plus: 0 });
      expect((await scoped([B])).receivables.aging).toEqual({ current: 0, d1_30: 0, d31_60: 80000, d61_90: 0, d90_plus: 0 });
      // The 90+ bucket holds only the unattributable invoice, so no scoped caller ever sees it.
      expect((await scoped([A, B])).receivables.aging).toEqual({ current: 0, d1_30: 20000, d31_60: 80000, d61_90: 24000, d90_plus: 0 });
    });
  });

  // ── Query 5 — billing_payments ────────────────────────────────────────────

  describe('query 5 of 8 — cashflow, from billing_payments', () => {
    it('both directions equal the independent sum over region A payments', async () => {
      const m = await membership([A]);
      const out = await scoped([A]);
      const live = 'is_active = true';
      expect(out.cashflow.in).toBe(await sumOf('billing_payments', m.payments, 'amount', `${live} AND direction = 'INBOUND'`));
      expect(out.cashflow.out).toBe(await sumOf('billing_payments', m.payments, 'amount', `${live} AND direction = 'OUTBOUND'`));
      expect(out.cashflow.net).toBe(r2(out.cashflow.in - out.cashflow.out));
    });

    it('matches the amounts this fixture was built to produce', async () => {
      const out = await scoped([A]);
      expect(out.cashflow).toEqual({ in: 17800, out: 2970, net: 14830 });
    });

    it('reconciles with the two queries it settles, which is what proves the rule is the same one', async () => {
      for (const regions of [[A], [B], [A, B]]) {
        const out = await scoped(regions);
        // Every payment in this fixture matches its parent row exactly, so a payment scoped by a
        // DIFFERENT rule than its parent would break one of these two identities.
        expect(out.cashflow.in).toBe(out.receivables.collected);
        expect(out.cashflow.out).toBe(out.payouts.paid);
      }
    });

    it('a payment settling nothing, and one settling an unattributable invoice, reach no region', async () => {
      const both = await scoped([A, B]);
      expect(both.cashflow.out).toBe(10890);   // 2970 + 7920, never the orphan's 1234
      expect(both.cashflow.in).toBe(25040);    // never invX's 4000
    });
  });

  // ── Query 6 — clients, with all three sub-aggregates ──────────────────────

  describe('query 6 of 8 — the by-client table', () => {
    const mine = (out: BillingOverview) => out.byClient.filter((c) => c.clientName.startsWith(RUN));

    it('each client row equals the independent sums over that client\'s region A rows', async () => {
      const m = await membership([A]);
      const out = await scoped([A]);
      for (const row of mine(out)) {
        const live = 'is_active = true';
        const forClient = (where: string) => `${where} AND client_id = '${row.clientId}'::uuid`;
        expect(row.unbilled).toBe(await sumOf('billing_entries', m.entries, 'total_amount', forClient(`${live} AND state = 'UNBILLED' AND on_hold = false`)));
        expect(row.revenue).toBe(await sumOf('billing_entries', m.entries, 'taxable_amount', forClient(`${live} AND state <> 'CANCELLED'`)));
        expect(row.assignmentCount).toBe(await countOf('billing_entries', m.entries, forClient(live)));
        expect(row.invoiced).toBe(await sumOf('billing_invoices', m.invoices, 'total', forClient(`${live} AND status IN ('ISSUED','PAID')`)));
        expect(row.outstanding).toBe(await sumOf('billing_invoices', m.invoices, 'outstanding_amount', forClient(`${live} AND status = 'ISSUED'`)));
        expect(row.cost).toBe(await sumOf('assayer_payables', m.payables, 'base_amount + travel_amount', forClient(live)));
        expect(row.margin).toBe(r2(row.revenue - row.cost));
      }
    });

    it('the region A rows add up to the region A headline figures', async () => {
      const out = await scoped([A]);
      const rows = mine(out);
      expect(r2(rows.reduce((t, c) => t + c.unbilled, 0))).toBe(out.receivables.unbilled);
      expect(r2(rows.reduce((t, c) => t + c.revenue, 0))).toBe(out.margin.revenue);
      expect(r2(rows.reduce((t, c) => t + c.cost, 0))).toBe(out.margin.cost);
      expect(r2(rows.reduce((t, c) => t + c.invoiced, 0))).toBe(out.receivables.invoiced);
      expect(r2(rows.reduce((t, c) => t + c.outstanding, 0))).toBe(out.receivables.outstanding);
    });

    it('a client with nothing in the caller\'s region disappears rather than showing zeros', async () => {
      const onlyA = mine(await scoped([A])).map((c) => c.clientName);
      const onlyB = mine(await scoped([B])).map((c) => c.clientName);
      expect(onlyA).toEqual([`${RUN} client M`, `${RUN} client N`]);
      expect(onlyB).toEqual([`${RUN} client E`, `${RUN} client M`]);
      // Naming a client at all discloses that it exists; a zero row would still do that.
      expect(onlyA).not.toContain(`${RUN} client E`);
      expect(onlyB).not.toContain(`${RUN} client N`);
    });

    it('matches the amounts this fixture was built to produce', async () => {
      const rows = mine(await scoped([A]));
      const N = rows.find((c) => c.clientName.endsWith('client N'))!;
      const M = rows.find((c) => c.clientName.endsWith('client M'))!;
      expect({ unbilled: N.unbilled, revenue: N.revenue, invoiced: N.invoiced, outstanding: N.outstanding, cost: N.cost, assignmentCount: N.assignmentCount })
        .toEqual({ unbilled: 10800, revenue: 71000, invoiced: 37800, outstanding: 20000, cost: 6600, assignmentCount: 5 });
      expect({ unbilled: M.unbilled, revenue: M.revenue, invoiced: M.invoiced, outstanding: M.outstanding, cost: M.cost, assignmentCount: M.assignmentCount })
        .toEqual({ unbilled: 0, revenue: 11000, invoiced: 0, outstanding: 0, cost: 4400, assignmentCount: 2 });
    });
  });

  // ── Query 7 — billing_history ─────────────────────────────────────────────

  describe('query 7 of 8 — recent activity, from billing_history', () => {
    it('returns exactly the region A history rows the independent calculation names', async () => {
      const m = await membership([A]);
      const allowed = new Set(m.history);
      const out = await scoped([A]);
      for (const item of out.recentActivity) expect(allowed.has(item.id)).toBe(true);
      const mineOut = out.recentActivity.filter((h) => h.action.startsWith(RUN)).map((h) => h.action).sort();
      expect(mineOut).toEqual([`${RUN}_A1_BOOKED`, `${RUN}_A2_HELD`, `${RUN}_A3_PAID`]);
    });

    it('region B events, a null-region event and an event with no assignment are all absent', async () => {
      const actions = (await scoped([A])).recentActivity.map((h) => h.action);
      expect(actions).not.toContain(`${RUN}_B1_BOOKED`);
      expect(actions).not.toContain(`${RUN}_MB_PAID`);
      expect(actions).not.toContain(`${RUN}_X_BOOKED`);
      expect(actions).not.toContain(`${RUN}_NO_ASSIGNMENT`);
    });

    it('keeps the same shape as the unscoped path — id, action, entity and timestamp', async () => {
      const item = (await scoped([A])).recentActivity.find((h) => h.action === `${RUN}_A1_BOOKED`)!;
      expect(item.id).toBe(uid('hA1'));
      expect(item.entityType).toBe('ENTRY');
      expect(item.entityId).toBe(uid('eA1'));
      expect(item.userName).toBe(`${RUN} fixture`);
      expect(item.occurredAt).toBeTruthy();
    });
  });

  // ── Query 8 — the attention list ──────────────────────────────────────────

  describe('query 8 of 8 — the attention list, six sub-queries', () => {
    const mineOf = (out: BillingOverview, kind: string) =>
      out.attention.filter((i: any) => i.kind === kind && String(i.assignmentNumber ?? i.invoiceNumber ?? '').startsWith(RUN));

    it('is not silently empty — every kind this fixture raises is present for region A', async () => {
      const out = await scoped([A]);
      // `aMA` belongs here as well as under HELD below, and one assignment raising two kinds is
      // how this list already works — `aA2` is both FEE_CHANGED and HELD a few lines down. It is
      // COMPLETED, and its only billing entry (`eMA`) is CANCELLED, so it has no LIVE entry:
      // UNBOOKED reads "completed, with nothing live booked against it", and a cancelled entry is
      // dead by `billing-liveness.ts`'s not-dead rule. Its payable `pMA` is live and on hold, so
      // the money out is booked while the money in is not — exactly what this kind exists to
      // surface. The list was short because no one had ever seen this query's real output: every
      // region-scoped case in this file raised `invalid reference to FROM-clause entry` until the
      // alias fix, so the enumeration was written by hand and never checked against a run.
      expect(mineOf(out, 'UNBOOKED').map((i: any) => i.assignmentNumber).sort())
        .toEqual([`${RUN}-aA4`, `${RUN}-aA5`, `${RUN}-aA6`, `${RUN}-aMA`]);
      expect(mineOf(out, 'UNSETTLED_FEE').map((i: any) => i.assignmentNumber)).toEqual([`${RUN}-aA1`]);
      expect(mineOf(out, 'FEE_CHANGED').map((i: any) => i.assignmentNumber)).toEqual([`${RUN}-aA2`]);
      // A held payout and a held client line are both `HELD` — `BillingAttentionItem` has no
      // separate kind for the second — and are told apart by which id the item carries. Both
      // sub-queries are narrowed, by different fragments (`rg.payable` and `rg.entry`), so both
      // are checked separately here rather than as one set.
      const held = mineOf(out, 'HELD');
      expect(held.filter((i: any) => i.payableId).map((i: any) => i.assignmentNumber)).toEqual([`${RUN}-aMA`]);
      expect(held.filter((i: any) => i.entryId).map((i: any) => i.assignmentNumber)).toEqual([`${RUN}-aA2`]);
      expect(mineOf(out, 'OVERDUE_INVOICE').map((i: any) => i.invoiceNumber)).toEqual([`${RUN}-invA`]);
    });

    it('names nothing from region B, and nothing unattributable', async () => {
      const out = await scoped([A]);
      const text = JSON.stringify(out.attention);
      for (const tag of ['aB1', 'aB2', 'aB3', 'aB4', 'aMB', 'aMX', 'aOR', 'invB', 'invX', 'invMIX', 'invEMPTY']) {
        expect(text).not.toContain(`${RUN}-${tag}`);
      }
    });

    it('a caller holding both regions sees both regions\' items and still nothing unattributable', async () => {
      const out = await scoped([A, B]);
      const numbers = out.attention.map((i: any) => i.assignmentNumber ?? i.invoiceNumber);
      expect(numbers).toContain(`${RUN}-aA1`);
      expect(numbers).toContain(`${RUN}-aB1`);
      expect(numbers).toContain(`${RUN}-aMB`);
      expect(numbers).not.toContain(`${RUN}-aMX`);
      expect(numbers).not.toContain(`${RUN}-aOR`);
      expect(numbers).not.toContain(`${RUN}-invX`);
    });
  });

  // ── The unscoped path is unchanged ────────────────────────────────────────

  describe('a caller with no region assignment still gets the organisation-wide figures', () => {
    /**
     * The pre-fix queries, frozen character-for-character from git HEAD
     * (`1c90d94c:packages/backend/src/modules/billing-engine/billing-engine.service.ts`). If the
     * unrestricted path had changed at all, these would disagree with it.
     */
    const AGEING_SELECT = `
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND (due_date IS NULL OR $OD <= 0)), 0) AS current,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 0  AND $OD <= 30), 0) AS d1_30,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 30 AND $OD <= 60), 0) AS d31_60,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 60 AND $OD <= 90), 0) AS d61_90,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 90), 0) AS d90_plus
  `.replace(/\$OD/g, `FLOOR(EXTRACT(EPOCH FROM (NOW() - ((due_date::text || ' 00:00:00+00')::timestamptz))) / 86400)`);

    const ORIGINAL = {
      payables: `
        SELECT COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE status = 'PENDING'  AND on_hold = false), 0) AS due,
               COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE status = 'APPROVED' AND on_hold = false), 0) AS approved,
               COALESCE(SUM(paid_amount), 0)                                                                    AS paid,
               COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE on_hold = true), 0)                        AS held,
               COUNT(*) FILTER (WHERE status = 'PENDING'  AND on_hold = false)::int                              AS due_count,
               COUNT(*) FILTER (WHERE status = 'APPROVED' AND on_hold = false)::int                              AS approved_count,
               COUNT(*) FILTER (WHERE on_hold = true)::int                                                       AS held_count,
               COALESCE(SUM(base_amount + travel_amount), 0)                                                     AS gross_cost,
               COALESCE(SUM(tds_amount), 0)                                                                      AS tds_from_assayers
          FROM assayer_payables WHERE is_active = true`,
      entries: `
        SELECT COALESCE(SUM(total_amount) FILTER (WHERE state = 'UNBILLED' AND on_hold = false), 0) AS unbilled,
               COALESCE(SUM(total_amount) FILTER (WHERE on_hold = true AND state <> 'CANCELLED'), 0) AS held,
               COALESCE(SUM(taxable_amount) FILTER (WHERE state <> 'CANCELLED'), 0)                AS revenue,
               COALESCE(SUM(tax_amount) FILTER (WHERE state <> 'CANCELLED'), 0)                    AS gst,
               COALESCE(SUM(tds_amount) FILTER (WHERE state <> 'CANCELLED'), 0)                    AS tds_by_clients
          FROM billing_entries WHERE is_active = true`,
      invoices: `
        SELECT COALESCE(SUM(total) FILTER (WHERE status IN ('ISSUED','PAID')), 0)            AS invoiced,
               COALESCE(SUM(paid_amount) FILTER (WHERE status <> 'CANCELLED'), 0)            AS collected,
               COALESCE(SUM(outstanding_amount) FILTER (WHERE status = 'ISSUED'), 0)         AS outstanding
          FROM billing_invoices WHERE is_active = true`,
      ageing: `SELECT ${AGEING_SELECT} FROM billing_invoices WHERE is_active = true AND status = 'ISSUED'`,
      cash: `
        SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'INBOUND'), 0)  AS cash_in,
               COALESCE(SUM(amount) FILTER (WHERE direction = 'OUTBOUND'), 0) AS cash_out
          FROM billing_payments WHERE is_active = true`,
      byClient: `
        SELECT c.id AS client_id, c.name AS client_name,
               COALESCE(e.unbilled, 0) AS unbilled, COALESCE(e.revenue, 0) AS revenue, COALESCE(e.assignment_count, 0) AS assignment_count,
               COALESCE(i.invoiced, 0) AS invoiced, COALESCE(i.outstanding, 0) AS outstanding,
               COALESCE(p.cost, 0) AS cost
          FROM clients c
          LEFT JOIN (SELECT client_id,
                            SUM(total_amount) FILTER (WHERE state = 'UNBILLED' AND on_hold = false) AS unbilled,
                            SUM(taxable_amount) FILTER (WHERE state <> 'CANCELLED') AS revenue,
                            COUNT(*) AS assignment_count
                       FROM billing_entries WHERE is_active = true GROUP BY client_id) e ON e.client_id = c.id
          LEFT JOIN (SELECT client_id,
                            SUM(total) FILTER (WHERE status IN ('ISSUED','PAID')) AS invoiced,
                            SUM(outstanding_amount) FILTER (WHERE status = 'ISSUED') AS outstanding
                       FROM billing_invoices WHERE is_active = true GROUP BY client_id) i ON i.client_id = c.id
          LEFT JOIN (SELECT client_id, SUM(base_amount + travel_amount) AS cost
                       FROM assayer_payables WHERE is_active = true GROUP BY client_id) p ON p.client_id = c.id
         WHERE c.is_active = true AND (e.client_id IS NOT NULL OR i.client_id IS NOT NULL OR p.client_id IS NOT NULL)
         ORDER BY c.name`,
    };

    it('every headline figure equals the pre-fix query run directly', async () => {
      const out = await service.overview();
      const [pay] = await qr.query(ORIGINAL.payables);
      const [ent] = await qr.query(ORIGINAL.entries);
      const [inv] = await qr.query(ORIGINAL.invoices);
      const [age] = await qr.query(ORIGINAL.ageing);
      const [cash] = await qr.query(ORIGINAL.cash);

      expect(out.payouts).toEqual({
        due: r2(num(pay.due)), approved: r2(num(pay.approved)), paid: r2(num(pay.paid)), held: r2(num(pay.held)),
        dueCount: num(pay.due_count), approvedCount: num(pay.approved_count), heldCount: num(pay.held_count),
      });
      expect(out.margin.cost).toBe(r2(num(pay.gross_cost)));
      expect(out.tax.tdsWithheldFromAssayers).toBe(r2(num(pay.tds_from_assayers)));
      expect(out.receivables.unbilled).toBe(r2(num(ent.unbilled)));
      expect(out.receivables.held).toBe(r2(num(ent.held)));
      expect(out.margin.revenue).toBe(r2(num(ent.revenue)));
      expect(out.tax.gstCollected).toBe(r2(num(ent.gst)));
      expect(out.tax.tdsWithheldByClients).toBe(r2(num(ent.tds_by_clients)));
      expect(out.receivables.invoiced).toBe(r2(num(inv.invoiced)));
      expect(out.receivables.collected).toBe(r2(num(inv.collected)));
      expect(out.receivables.outstanding).toBe(r2(num(inv.outstanding)));
      expect(out.receivables.aging).toEqual({
        current: r2(num(age.current)), d1_30: r2(num(age.d1_30)), d31_60: r2(num(age.d31_60)),
        d61_90: r2(num(age.d61_90)), d90_plus: r2(num(age.d90_plus)),
      });
      expect(out.cashflow).toEqual({
        in: r2(num(cash.cash_in)), out: r2(num(cash.cash_out)),
        net: r2(num(cash.cash_in) - num(cash.cash_out)),
      });
    });

    it('the by-client table is the pre-fix table, client for client and figure for figure', async () => {
      const out = await service.overview();
      const rows: any[] = await qr.query(ORIGINAL.byClient);
      expect(out.byClient.map((c) => c.clientId)).toEqual(rows.map((r) => r.client_id));
      for (const r of rows) {
        const got = out.byClient.find((c) => c.clientId === r.client_id)!;
        expect(got.unbilled).toBe(r2(num(r.unbilled)));
        expect(got.revenue).toBe(r2(num(r.revenue)));
        expect(got.invoiced).toBe(r2(num(r.invoiced)));
        expect(got.outstanding).toBe(r2(num(r.outstanding)));
        expect(got.cost).toBe(r2(num(r.cost)));
        expect(got.assignmentCount).toBe(num(r.assignment_count));
      }
    });

    it('still shows the national caller the rows no region can claim', async () => {
      const out = await service.overview();
      const actions = out.recentActivity.map((h) => h.action);
      expect(actions).toContain(`${RUN}_X_BOOKED`);
      expect(actions).toContain(`${RUN}_NO_ASSIGNMENT`);
      // The three shapes of "cannot be attributed", each reaching the list through a different
      // one of the six sub-queries: an invoice whose only line sits on a null-region branch, an
      // assignment on that same branch, and an assignment with no project branch at all. A
      // scoped caller sees none of them (asserted above); the national caller sees all three,
      // which is what makes those absences a filter rather than a fixture that raises nothing.
      const named = (kind: string) =>
        out.attention.filter((i: any) => i.kind === kind).map((i: any) => i.assignmentNumber ?? i.invoiceNumber);
      expect(named('OVERDUE_INVOICE')).toContain(`${RUN}-invX`);
      expect(named('FEE_CHANGED')).toContain(`${RUN}-aMX`);
      expect(named('UNSETTLED_FEE')).toContain(`${RUN}-aOR`);
    });

    it('the national figures are strictly larger than any one region\'s', async () => {
      const all = await service.overview();
      const a = await scoped([A]);
      expect(all.margin.revenue).toBeGreaterThan(a.margin.revenue);
      expect(all.receivables.outstanding).toBeGreaterThan(a.receivables.outstanding);
      expect(all.cashflow.in).toBeGreaterThan(a.cashflow.in);
    });
  });

  // ── The staged rollout, and the empty case ────────────────────────────────

  describe('the rollout modes, against real rows', () => {
    const withMode = (mode: 'off' | 'log' | 'enforce') => {
      const regionGuard: any = { stagedMode: async () => mode };
      const nil: any = undefined;
      return new BillingEngineService(
        qr.manager.getRepository(BillingEntryEntity) as any, nil, nil, nil,
        qr.manager.getRepository(BillingHistoryEntity) as any,
        nil, nil, nil, nil, regionGuard, nil, nil, nil, nil, nil,
      );
    };

    it('off and log leave a restricted caller with the national figures', async () => {
      const national = await service.overview();
      for (const mode of ['off', 'log'] as const) {
        const out = await withMode(mode).overview({ regions: [A] });
        expect(out.margin.revenue).toBe(national.margin.revenue);
        expect(out.receivables.outstanding).toBe(national.receivables.outstanding);
        expect(out.payouts.due).toBe(national.payouts.due);
      }
    });

    it('enforce narrows the same caller', async () => {
      const national = await service.overview();
      const out = await withMode('enforce').overview({ regions: [A] });
      expect(out.margin.revenue).toBeLessThan(national.margin.revenue);
    });
  });

  describe('a region with no financial records at all', () => {
    it('returns zeros and empty lists, never nulls and never an error', async () => {
      const out = await scoped([EMPTY]);
      expect(out.payouts).toEqual({ due: 0, approved: 0, paid: 0, held: 0, dueCount: 0, approvedCount: 0, heldCount: 0 });
      expect(out.receivables).toEqual({
        unbilled: 0, invoiced: 0, collected: 0, outstanding: 0, held: 0,
        aging: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 },
      });
      expect(out.margin).toEqual({ revenue: 0, cost: 0, margin: 0, marginPct: null });
      expect(out.tax).toEqual({ gstCollected: 0, tdsWithheldByClients: 0, tdsWithheldFromAssayers: 0 });
      expect(out.cashflow).toEqual({ in: 0, out: 0, net: 0 });
      expect(out.byClient).toEqual([]);
      expect(out.attention).toEqual([]);
      expect(out.recentActivity).toEqual([]);
      expect(out.currency).toBe('INR');
      for (const value of Object.values(out.payouts)) expect(value).not.toBeNull();
    });
  });

  // ── Cross-query agreement ─────────────────────────────────────────────────

  describe('all eight queries agree about what a region is', () => {
    it('no figure counts a row that cannot be attributed to a region, in any combination', async () => {
      // Every unattributable amount in this fixture. If ANY of the eight queries treated an
      // unresolvable row as belonging to everyone, one of these would show up in a scoped total.
      const orphans = [4950, 5940, 54000, 3000, 4000, 1234, 64800];
      for (const regions of [[A], [B], [A, B], [EMPTY]]) {
        const out = await scoped(regions);
        const totals = [
          out.payouts.due, out.payouts.paid, out.payouts.held, out.margin.cost, out.margin.revenue,
          out.receivables.unbilled, out.receivables.invoiced, out.receivables.collected,
          out.receivables.outstanding, out.cashflow.in, out.cashflow.out,
        ];
        for (const orphan of orphans) expect(totals).not.toContain(orphan);
      }
    });

    it('the regions partition the attributable money — A plus B equals A-and-B', async () => {
      const a = await scoped([A]);
      const b = await scoped([B]);
      const both = await scoped([A, B]);
      // Payables and client lines resolve to exactly one region, so these add exactly.
      expect(r2(a.payouts.due + b.payouts.due)).toBe(both.payouts.due);
      expect(r2(a.payouts.paid + b.payouts.paid)).toBe(both.payouts.paid);
      expect(r2(a.margin.cost + b.margin.cost)).toBe(both.margin.cost);
      expect(r2(a.margin.revenue + b.margin.revenue)).toBe(both.margin.revenue);
      expect(r2(a.receivables.unbilled + b.receivables.unbilled)).toBe(both.receivables.unbilled);
      // An invoice may span regions, so the mixed invoice appears only in the two-region call.
      // That gap IS the mixed invoice and nothing else — asserted rather than waved at.
      expect(r2(both.receivables.invoiced - a.receivables.invoiced - b.receivables.invoiced)).toBe(24840);
      expect(r2(both.receivables.outstanding - a.receivables.outstanding - b.receivables.outstanding)).toBe(24000);
      expect(r2(both.cashflow.in - a.cashflow.in - b.cashflow.in)).toBe(840);
    });
  });
});
