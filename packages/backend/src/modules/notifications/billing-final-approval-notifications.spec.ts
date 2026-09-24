import { NOTIFICATION_CATALOG, renderTemplate } from './notification-catalog';

/**
 * THE HOD'S FINAL APPROVAL (2026-09-24) — who hears what.
 *
 *  - Something waits for the HOD → the HOD: Admins by name, and a custom "HOD" role only when it
 *    holds BOTH the final-approval permission and the billing read its page needs. Never the office
 *    that approved it (the actor is skipped). Bursts collapse, so a bulk approval is one line.
 *  - The HOD sends it back → whoever did the office's part, by name, with the reason.
 *  - The assayer hears "approved for payment" only when the HOD approves — no amount on it.
 */
describe('notifications for the final approval', () => {
  const cat = NOTIFICATION_CATALOG as Record<string, any>;

  it('BILLING_FINAL_APPROVAL_NEEDED reaches the HODs, and only them', () => {
    const def = cat.BILLING_FINAL_APPROVAL_NEEDED;
    expect(def.roles).toEqual(['ADMIN']);
    expect(def.fallbackPermissions).toEqual(['BILLING:FINAL_APPROVE:ORGANIZATION', 'BILLING:VIEW:ORGANIZATION']);
    expect(def.special).toBeUndefined();
    expect(def.skipActor).toBe(true);
    expect(def.channels).toEqual(expect.arrayContaining(['IN_APP', 'EMAIL']));
    expect(def.link).toBe('/billing?tab=final');
    expect(def.collapse).toMatchObject({ link: '/billing?tab=final' });
    expect(renderTemplate(def.body, { what: 'Assayer bill AINV-7 (3 lines)', amount: 5400, officeName: 'Priya Menon' }))
      .toBe('Assayer bill AINV-7 (3 lines) (₹5400) was approved by Priya Menon and is waiting for your final approval.');
  });

  it('BILLING_FINAL_APPROVAL_REJECTED goes to the office person who did it, with the reason, back to the right tab', () => {
    const def = cat.BILLING_FINAL_APPROVAL_REJECTED;
    expect(def.roles).toEqual([]);
    expect(def.special).toEqual(['RECORD_OWNER']);
    expect(def.skipActor).toBe(true);
    expect(renderTemplate(def.link, { tab: 'bills' })).toBe('/billing?tab=bills');
    expect(renderTemplate(def.body, { hodName: 'Ravi', what: 'Payout PY-9', reason: 'Twice the rate card.' }))
      .toContain('"Twice the rate card."');
  });

  it("the assayer's bill notice says approved FOR PAYMENT and carries no amount", () => {
    const def = cat.ASSAYER_INVOICE_APPROVED;
    expect(def.special).toEqual(['ASSIGNED_ASSAYER']);
    expect(def.title).toBe('Your bill is approved for payment');
    expect(`${def.title} ${def.body}`).not.toMatch(/₹|\$\{(total|amount)\}/);
  });
});
