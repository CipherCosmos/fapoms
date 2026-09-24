import {
  AWAITING_HOD_MESSAGE, BILLING_FINAL_APPROVE_PERMISSION, FINAL_APPROVAL_KINDS, FINAL_APPROVAL_KIND_LABELS,
  hodRejectReasonProblem,
} from './billing-final-approval';
import { AssayerInvoiceStatus, InvoiceStatus, PermissionAction, PermissionResource, AuthorizationScope } from './enums';
import { ASSAYER_SENT_INVOICE_STATUSES } from './assayer-invoicing';
import { INVOICE_STATUS_LABELS } from './labels';
import { API_ERROR_CODES } from './error-codes';

/** THE HOD'S FINAL BILLING APPROVAL (2026-09-24) — the shared vocabulary the three apps agree on. */
describe('billing final approval', () => {
  it('names a permission that exists in the stored RESOURCE:ACTION:SCOPE form', () => {
    const [resource, action, scope] = BILLING_FINAL_APPROVE_PERMISSION.split(':');
    expect(resource).toBe(PermissionResource.BILLING);
    expect(action).toBe(PermissionAction.FINAL_APPROVE);
    expect(scope).toBe(AuthorizationScope.ORGANIZATION);
  });

  it('labels every kind in plain words', () => {
    for (const k of FINAL_APPROVAL_KINDS) expect(FINAL_APPROVAL_KIND_LABELS[k]).toMatch(/\w/);
  });

  it('a send-back needs a reason the office can act on', () => {
    expect(hodRejectReasonProblem('')).not.toBeNull();
    expect(hodRejectReasonProblem('   no   ')).not.toBeNull();
    expect(hodRejectReasonProblem('Twice the rate card for travel.')).toBeNull();
    expect(hodRejectReasonProblem('x'.repeat(1001))).toMatch(/under 1000/);
  });

  it('the refusal every payment path gives is one stable code and one plain sentence', () => {
    expect(API_ERROR_CODES.AWAITING_HOD_APPROVAL).toBe('AWAITING_HOD_APPROVAL');
    expect(AWAITING_HOD_MESSAGE).toBe('Waiting for HOD approval');
  });

  it('an HOD-approved bill is still a bill the assayer has sent (their Money shows it)', () => {
    expect(ASSAYER_SENT_INVOICE_STATUSES).toContain(AssayerInvoiceStatus.HOD_APPROVED);
    expect(ASSAYER_SENT_INVOICE_STATUSES).toContain(AssayerInvoiceStatus.APPROVED);
  });

  it('the client invoice states in between are labelled', () => {
    expect(INVOICE_STATUS_LABELS[InvoiceStatus.AWAITING_HOD]).toBe('Awaiting final approval');
    expect(INVOICE_STATUS_LABELS[InvoiceStatus.HOD_APPROVED]).toBe('Approved, ready to send');
  });
});
