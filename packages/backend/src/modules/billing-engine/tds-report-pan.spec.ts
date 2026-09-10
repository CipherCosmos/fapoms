import { readFileSync } from 'fs';
import { join } from 'path';
import { SystemRole, maskTail } from '@fapoms/shared';

/**
 * A PAN is masked unless the caller is entitled to the whole number, and a whole one is audited.
 *
 * `GET /billing-engine/tds-report` returned every payee's PAN in the clear to anyone who could
 * open it. AUDITOR is the sharp case: `scopeAssayerForRoles` strips identity fields from that
 * role entirely, so an auditor reading the person's own record gets no `panNumber` key at all —
 * and could read five PANs off this report in a single call, with no audit row, while the
 * single-field reveal writes one per number.
 *
 * It slipped past the existing protection because that protection masks by key NAME over objects
 * shaped like an assayer, and these rows are hand-built with a key called `pan`. Redaction keyed
 * on names cannot cover a payload that renames the key.
 */
const SERVICE = join(__dirname, 'billing-engine.service.ts');
const CONTROLLER = join(__dirname, 'billing-engine.controller.ts');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the TDS report treats a PAN like a PAN', () => {
  const service = stripComments(readFileSync(SERVICE, 'utf8'));
  const controller = stripComments(readFileSync(CONTROLLER, 'utf8'));

  /** Scoped to `tdsReport` — the bank file legitimately emits whole numbers, see below. */
  const tdsBody = (() => {
    const i = service.indexOf('async tdsReport');
    return service.slice(i, service.indexOf('async assignmentMoneyLine', i));
  })();

  it('never returns the raw column straight from the entity', () => {
    // The defect, exactly: `pan: a?.panNumber ?? null`.
    expect(tdsBody).not.toMatch(/pan:\s*a\?\.panNumber\s*\?\?\s*null/);
  });

  it('masks unless the caller may see the whole number', () => {
    expect(tdsBody).toContain('maySeeWholePan');
    expect(tdsBody).toMatch(/pan:\s*pan\s*\?\s*\(maySeeWholePan\s*\?\s*pan\s*:\s*maskTail\(pan\)\)/);
  });

  /**
   * The same three roles `scopeAssayerForRoles` grants the whole value to. AUDITOR must not be
   * among them — it is stripped of the field on the record, and a report that hands it over
   * contradicts the record.
   */
  it('grants the whole number to the same roles the record does, and not the auditor', () => {
    const clause = service.slice(service.indexOf('const maySeeWholePan'), service.indexOf('const maySeeWholePan') + 320);
    for (const role of [SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DEVELOPER]) {
      expect(clause).toContain(role);
    }
    for (const role of [SystemRole.AUDITOR, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.CLIENT_USER]) {
      expect(clause).not.toContain(role);
    }
  });

  it('tells the caller which of the two it returned', () => {
    expect(tdsBody).toContain('panMasked');
  });

  /** A bulk reveal is still a reveal. */
  it('writes a reveal audit row when whole numbers are handed over, and names no value', () => {
    const block = service.slice(service.indexOf('const revealed = rows.filter'), service.indexOf('const revealed = rows.filter') + 1200);
    expect(block).toContain("eventType: 'ASSAYER_SENSITIVE_FIELD_REVEALED'");
    expect(block).toContain('count: revealed.length');
    // The audit records which field and whose, never the number itself.
    expect(block).not.toMatch(/pan:\s*revealed/);
    expect(block).toContain('assayerCodes');
  });

  it('does not audit when nothing was revealed', () => {
    expect(service).toMatch(/if \(revealed\.length && actor\?\.id\)/);
  });

  /** Without a caller the safe default applies, so an internal report cannot leak by omission. */
  it('treats an absent caller as not entitled', () => {
    expect(service).toMatch(/\(actor\?\.roles \?\? \[\]\)/);
  });

  it('passes the caller from the route', () => {
    const handler = controller.slice(controller.indexOf('async tdsReport'), controller.indexOf('async tdsReport') + 700);
    expect(handler).toContain('req?.user?.id');
    expect(handler).toContain('roles');
  });

  it('masks to a tail, not to a blank', () => {
    // Rows still have to be distinguishable from one another to be worth reading.
    expect(maskTail('ABCPD1234E')).toMatch(/234E$/);
    expect(maskTail('ABCPD1234E')).not.toBe('ABCPD1234E');
  });

  /**
   * The bank file is the deliberate exception and must stay one.
   *
   * It produces the payment instruction a bank consumes, so it needs the real account number,
   * IFSC and PAN — masking it would break the payment run rather than protect anybody. It is
   * limited to the disbursement roles, the same set entitled to a reveal, and it does leave a
   * trace: one `PAYABLE_BANK_FILE_EXPORTED` history row per payable, naming the actor and the
   * batch reference.
   *
   * I nearly added a second audit row here on the assumption it was unaudited. It is not — it
   * records the export in the billing history rather than in `audit_events`, and a duplicate row
   * would be noise, not protection. What this pins is that the trace exists.
   */
  it('leaves the bank file emitting whole numbers, and traced', () => {
    // Anchored on the bank-file row builder itself — `const account = p.destination...` — so the
    // slice cannot wander into an unrelated function that mentions the same column.
    const i = service.indexOf('const account = p.destinationBankAccountNumber ?? null');
    expect(i).toBeGreaterThan(-1);
    const bankFile = service.slice(i, i + 3000);
    expect(bankFile).toContain('pan: a?.panNumber ?? null');
    expect(bankFile).toContain("action: 'PAYABLE_BANK_FILE_EXPORTED'");
  });
});
