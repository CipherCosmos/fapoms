import * as fs from 'fs';
import * as path from 'path';
import {
  CRITICAL_ASSAYER_RECORD_FIELDS,
  SELF_EDITABLE_ASSAYER_FIELDS,
  HR_MAINTAINED_ASSAYER_FIELDS,
  splitMissingByOwnership,
  isSelfEditableAssayerField,
} from '@fapoms/shared';

/**
 * Who may change what, and who is told about it.
 *
 * Three places had an opinion and none of them agreed: the API enforced `SELF_EDITABLE_FIELDS`,
 * the mobile profile screen kept its own five-field idea of a complete record, and the web roster
 * counted from the shared list. So the phone could say "Your record is complete" while the web
 * listed the same person as incomplete — the reported bug — and could also present an input the
 * API would refuse to save.
 *
 * These tests hold the one list to the properties the other two rely on.
 */
describe('assayer self-editable fields', () => {
  it('never lets an assayer change their own payment details', () => {
    // The payroll-diversion route: a payee who can repoint their own payments. If this ever
    // passes, someone has made bank fraud a two-tap operation on a phone.
    for (const field of ['panNumber', 'bankAccountNumber', 'ifscCode']) {
      expect(isSelfEditableAssayerField(field)).toBe(false);
      expect(HR_MAINTAINED_ASSAYER_FIELDS).toContain(field);
    }
  });

  it('never lets an assayer change terms that decide their own eligibility or pay', () => {
    // Capacity limits remove someone from the planning pool; employment type and joining date
    // drive tenure, settlement and rate.
    for (const field of ['maxDailyWorkload', 'maxWeeklyWorkload', 'employmentType', 'joiningDate', 'performanceRating']) {
      expect(isSelfEditableAssayerField(field)).toBe(false);
    }
  });

  it('does let an assayer correct the things only they know', () => {
    // Nobody in HR learns a new phone number sooner than its owner does.
    for (const field of ['phone', 'emergencyContactPhone', 'address', 'city', 'pincode', 'latitude']) {
      expect(isSelfEditableAssayerField(field)).toBe(true);
    }
  });

  it('keeps the two lists disjoint', () => {
    const overlap = SELF_EDITABLE_ASSAYER_FIELDS.filter((f) => HR_MAINTAINED_ASSAYER_FIELDS.includes(f));
    expect(overlap).toEqual([]);
  });

  it('accounts for every critical field as either the assayer\'s or HR\'s', () => {
    // A critical gap owned by nobody is one no screen can explain: the phone cannot offer to fix
    // it and cannot say who will.
    const unclaimed = CRITICAL_ASSAYER_RECORD_FIELDS
      .map((f) => f.key)
      .filter((k) => !SELF_EDITABLE_ASSAYER_FIELDS.includes(k) && !HR_MAINTAINED_ASSAYER_FIELDS.includes(k));
    expect(unclaimed).toEqual([]);
  });

  describe('splitMissingByOwnership', () => {
    it('puts each gap on the side that can close it', () => {
      const { yours, hr } = splitMissingByOwnership({});
      expect(yours.map((f) => f.key).sort()).toEqual(['emergencyContactPhone', 'latitude', 'phone'].sort());
      expect(hr.map((f) => f.key).sort()).toEqual(['bankAccountNumber', 'ifscCode', 'joiningDate', 'panNumber'].sort());
    });

    it('reports nothing for a complete record', () => {
      const complete: Record<string, unknown> = {};
      for (const f of CRITICAL_ASSAYER_RECORD_FIELDS) complete[f.key] = 'set';
      const { yours, hr } = splitMissingByOwnership(complete);
      expect([...yours, ...hr]).toEqual([]);
    });

    it('treats whitespace as blank, the way the SQL side does', () => {
      const { yours } = splitMissingByOwnership({ phone: '   ' });
      expect(yours.map((f) => f.key)).toContain('phone');
    });
  });

  /**
   * The mobile screen keeps its state under shorter names than the API uses, so it translates
   * before counting. A critical field left out of that translation silently reads as blank
   * forever — which is exactly the class of bug this whole change is fixing, so it is worth a
   * test rather than a comment.
   */
  it('mobile maps every critical field into the canonical shape', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../../mobile/src/screens/ProfileScreen.tsx'),
      'utf-8',
    );
    const adapter = source.slice(
      source.indexOf('export function assayerRecordFromProfile'),
      source.indexOf('export const PROFILE_SECTION_FOR_FIELD'),
    );
    expect(adapter.length).toBeGreaterThan(0);

    for (const field of CRITICAL_ASSAYER_RECORD_FIELDS) {
      expect(adapter).toContain(`${field.key}:`);
    }
  });

  it('the mobile screen no longer keeps its own list of required fields', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../../mobile/src/screens/ProfileScreen.tsx'),
      'utf-8',
    );
    // The old shape: a literal array of {value,label,target} it filtered for blanks.
    expect(source).not.toContain("label: 'Bank account number'");
    expect(source).toContain('splitMissingByOwnership');
  });

  /**
   * Whether an input locks must follow the shared policy, not a sentence typed next to it. The
   * screen used to hardcode `lockedReason="…"` per field, which is the same drift in a different
   * costume: move a field between the two lists and the phone keeps its old opinion, either
   * offering an edit the API rejects or locking one it would accept.
   */
  it('the mobile screen decides locks from the shared policy, not hardcoded strings', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../../mobile/src/screens/ProfileScreen.tsx'),
      'utf-8',
    );
    expect(source).toMatch(/lockReasonFor\(/);
    // A literal `lockedReason="..."` means a field's lock state was decided locally again.
    expect(source).not.toMatch(/lockedReason="/);
  });

  it('every HR-maintained field the phone can show has wording for why it is locked', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../../../mobile/src/screens/ProfileScreen.tsx'),
      'utf-8',
    );
    const reasons = source.slice(
      source.indexOf('const HR_LOCK_REASONS'),
      source.indexOf('/** Which sub-screen fixes a given gap'),
    );
    for (const field of HR_MAINTAINED_ASSAYER_FIELDS) {
      expect(reasons).toContain(`${field}:`);
    }
  });
});
