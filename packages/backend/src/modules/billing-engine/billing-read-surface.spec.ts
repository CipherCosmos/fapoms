import * as fs from 'fs';
import * as path from 'path';
import { BILLING_ROLES, BILLING_READ_ROLES, DISBURSEMENT_ROLES } from './billing-roles';
import { SystemRole } from '@fapoms/shared';

/**
 * Every READ on the billing engine admits the same set, and that set includes the auditor.
 *
 * The failure this pins is not hypothetical and has now happened twice. First on the export route,
 * recorded in `billing-roles.ts`: the auditor could read every billing figure on screen and got a
 * 403 the moment they pressed Export. Then on the assayer statement, found by signing in as an
 * AUDITOR and clicking the link the billing page offers unconditionally: the picker filled with
 * the whole roster, the auditor chose somebody, and the page rendered nothing at all — a blank
 * money screen, which for an auditor reads as "never paid anything" rather than "you were
 * refused".
 *
 * Both were one constant, on one route, out of step with its siblings. A grep is what catches
 * that, because the mistake is invisible in any single file.
 */
const CONTROLLER = path.join(__dirname, 'billing-engine.controller.ts');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the billing read surface admits one set of roles', () => {
  const src = stripComments(fs.readFileSync(CONTROLLER, 'utf8'));

  it('includes the auditor in the read set and not in the write set', () => {
    expect(BILLING_READ_ROLES).toContain(SystemRole.AUDITOR);
    expect(BILLING_ROLES).not.toContain(SystemRole.AUDITOR);
    expect(DISBURSEMENT_ROLES).not.toContain(SystemRole.AUDITOR);
  });

  /**
   * A GET gated on the narrower write set has to be a decision, not an oversight.
   *
   * Deliberately a deny-list with reasons rather than an allow-list of the routes somebody
   * remembered. An allow-list cannot see a route nobody added to it, which is precisely how the
   * statement stayed broken while every check around it passed. Here, a **new** GET on
   * `BILLING_ROLES` fails until somebody writes down why.
   *
   * The three below are reads of an action the auditor cannot perform, so there is nothing for
   * them to read. This is the same reasoning `reports.controller.ts` gives for polling exports
   * under `STAFF_ROLES`: "a staff member outside BILLING_READ_ROLES has no billing job to poll,
   * because they were refused one."
   */
  const NARROW_BY_DESIGN: Record<string, string> = {
    "@Get('reconcile/preview')":
      'the preview of a reconcile, which is an ADMIN/OPERATIONS write — an auditor has nothing to preview',
    "@Get('jobs/:jobId')":
      'polls a billing-engine job, and the only thing that creates one is POST /reconcile, which the auditor cannot call',
    "@Get('assayers/:assayerId/invoice-invitation')":
      "part of the assayer's own invoicing-consent flow, paired with ASSAYER on the same decorator",
  };

  it('gates every GET on BILLING_READ_ROLES, except the ones written down as narrow by design', () => {
    const offenders: string[] = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*@Get\(/.test(lines[i])) continue;
      const route = lines[i].trim();
      // The @Roles line for this handler is the next one that mentions @Roles before the method.
      for (let k = i + 1; k < Math.min(i + 8, lines.length); k++) {
        if (/^\s*async\s+\w+\s*\(/.test(lines[k])) break;
        if (!/@Roles\(/.test(lines[k])) continue;
        if (/\.\.\.BILLING_ROLES\b/.test(lines[k]) && !(route in NARROW_BY_DESIGN)) {
          offenders.push(`${route}  ->  ${lines[k].trim()}`);
        }
        break;
      }
    }
    expect(offenders).toEqual([]);
  });

  /** An exemption for a route that no longer exists is a comment pretending to be a decision. */
  it('has no stale exemptions', () => {
    for (const route of Object.keys(NARROW_BY_DESIGN)) {
      expect(src).toContain(route);
    }
  });

  /**
   * The statement route forks its audience off the caller's roles: staff get the full book, an
   * assayer principal gets the earnings-gated shape. Widening only the decorator would admit the
   * auditor at the door and then refuse them inside with "You may only view your own statement" —
   * an answer that accuses rather than explains. The fork has to read the same list as the gate.
   */
  it('decides the statement audience against the same list the statement gate uses', () => {
    const start = src.indexOf("@Get('assayers/:assayerId/statement')");
    expect(start).toBeGreaterThan(-1);
    const handler = src.slice(start, start + 1800);
    expect(handler).toContain('@Roles(...BILLING_READ_ROLES');
    expect(handler).toContain('isBillingStaff');
    expect(handler).toMatch(/isBillingStaff\s*=\s*roles\.some\(\(r\) => \(BILLING_READ_ROLES as string\[\]\)/);
    // and the ownership check for a non-staff principal must still be there
    expect(handler).toContain('You may only view your own statement.');
  });
});
