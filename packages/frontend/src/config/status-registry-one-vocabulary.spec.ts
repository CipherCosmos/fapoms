import {
  AssignmentStatus, ProjectBranchStatus, ProjectStatus, AssayerPayableStatus,
  InvoiceStatus, ValidationStatus, ScheduleStatus, UserStatus, BillingState,
  AssayerLifecycleStatus,
  assignmentStatusLabel, branchStatusLabel, projectStatusLabel, payableStatusLabel,
  invoiceStatusLabel, validationStatusLabel, scheduleStatusLabel, userStatusLabel,
  billingStateLabel, assayerLifecycleLabel,
} from '@fapoms/shared';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getStatusDescriptor, type StatusDomain } from './status-registry';

/**
 * One status, one word — everywhere in the product.
 *
 * This registry used to keep its own spelling of every status beside `@fapoms/shared`'s, and the
 * two had **already diverged in 27 places** by the time anyone diffed them. All of these shipped
 * at once, to the same users, about the same rows:
 *
 *   PAYABLE   APPROVED             "Approved"            vs "Approved (Frozen)"
 *   PAYABLE   PENDING              "Due"                 vs "Pending Approval"
 *   BRANCH    CANDIDATE_SEARCH     "Finding Assayer"     vs "Seeking Assayer"
 *   ASSIGNMENT REJECTED            "Rejected"            vs "Declined"
 *   INVOICE   ISSUED               "Sent"                vs "Issued (Sent)"
 *   VALIDATION OCR_PROCESSING      "Being read"          vs "Processing OCR"
 *
 * Two badges on one payout reading "Approved" and "Approved (Frozen)" is not a cosmetic problem:
 * it makes a person ask whether they are looking at two different things. The registry now keeps
 * only what it is for — semantic tone and icon — and the words come from shared, which the mobile
 * app also reads.
 *
 * These tests hold that line from both ends: the rendered label must equal shared's, and the
 * source must not contain a literal that could drift again.
 */
describe('status registry — the words come from @fapoms/shared', () => {
  const cases: Array<[StatusDomain, string[], (s?: string | null) => string]> = [
    ['assignment', Object.values(AssignmentStatus), assignmentStatusLabel],
    ['branch', Object.values(ProjectBranchStatus), branchStatusLabel],
    ['project', Object.values(ProjectStatus), projectStatusLabel],
    ['assayerPayable', Object.values(AssayerPayableStatus), payableStatusLabel],
    ['invoice', Object.values(InvoiceStatus), invoiceStatusLabel],
    ['validation', Object.values(ValidationStatus), validationStatusLabel],
    ['schedule', Object.values(ScheduleStatus), scheduleStatusLabel],
    ['user', Object.values(UserStatus), userStatusLabel],
    ['billingState', Object.values(BillingState), billingStateLabel],
    ['assayerLifecycle', Object.values(AssayerLifecycleStatus), assayerLifecycleLabel],
  ];

  it.each(cases)('%s uses shared wording for every one of its statuses', (domain, values, label) => {
    for (const value of values) {
      expect(getStatusDescriptor(domain, value).label).toBe(label(value));
    }
  });

  it('still carries the presentation it exists for — a tone for every status', () => {
    for (const [domain, values] of cases) {
      for (const value of values) {
        expect(getStatusDescriptor(domain, value).semantic).toBeTruthy();
      }
    }
  });

  /**
   * The source-level half. Passing the assertions above while a literal sits in the map would
   * mean the copy is merely unused — and an unused copy beside a live one is how the first 27
   * appeared. A domain shared names must carry no label text at all.
   */
  it('keeps no literal label for any domain shared already names', () => {
    const source = readFileSync(join(__dirname, 'status-registry.ts'), 'utf8');
    const SHARED_MAPS = [
      'ASSAYER_LIFECYCLE_STATUS_MAP', 'BRANCH_STATUS_MAP', 'PROJECT_STATUS_MAP',
      'ASSIGNMENT_STATUS_MAP', 'BILLING_STATE_MAP', 'INVOICE_STATUS_MAP',
      'ASSAYER_PAYABLE_STATUS_MAP', 'VALIDATION_STATUS_MAP', 'SCHEDULE_STATUS_MAP',
      'USER_STATUS_MAP',
    ];
    const offenders: string[] = [];
    for (const name of SHARED_MAPS) {
      const start = source.indexOf(`export const ${name}:`);
      expect(start).toBeGreaterThan(-1);
      const next = source.indexOf('\nexport ', start + 10);
      const block = source.slice(start, next > 0 ? next : source.length);
      const found = block.match(/^\s+label: '/gm);
      if (found) offenders.push(`${name} (${found.length})`);
    }
    expect(offenders).toEqual([]);
  });
});
