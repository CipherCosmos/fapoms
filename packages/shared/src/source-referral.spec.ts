import {
  normalizeSourceReferral, candidateMayEditSourceReferral, sourceReferralLine, ReferralSourceType,
} from './source-referral';

/** Who referred an assayer — one rule for every door that asks. */
describe('the source referral', () => {
  const ok = { type: 'ASSAYER', name: ' Ravi Kumar ', mobile: '+91 98765 43210', email: 'Ravi@Example.in' };

  it('keeps a tidy entry, stamped with who recorded it', () => {
    expect(normalizeSourceReferral(ok, 'HR')).toEqual({
      referral: { type: ReferralSourceType.ASSAYER, name: 'Ravi Kumar', mobile: '9876543210', email: 'ravi@example.in', recordedBy: 'HR' },
      error: null,
    });
  });

  it.each([null, undefined, { type: '', name: '', mobile: '', email: '' }])('treats %p as nobody', (raw) => {
    expect(normalizeSourceReferral(raw, 'CANDIDATE')).toEqual({ referral: null, error: null });
  });

  it.each([
    [{ ...ok, type: 'FRIEND' }, /an assayer, our staff, a bank branch/],
    [{ ...ok, name: '' }, /name of the person/],
    [{ ...ok, mobile: '12345' }, /10-digit/],
    [{ ...ok, email: 'ravi@' }, /email/],
    [{ ...ok, mobile: '', email: '' }, /mobile or an email for Ravi Kumar/],
  ])('refuses %p', (raw, message) => {
    expect(normalizeSourceReferral(raw, 'HR').error).toMatch(message);
  });

  it('takes an email alone, or a mobile alone', () => {
    expect(normalizeSourceReferral({ ...ok, mobile: '' }, 'HR').referral?.email).toBe('ravi@example.in');
    expect(normalizeSourceReferral({ ...ok, email: '' }, 'HR').referral?.mobile).toBe('9876543210');
  });

  it('lets the candidate change only what they wrote themselves', () => {
    expect(candidateMayEditSourceReferral(null)).toBe(true);
    expect(candidateMayEditSourceReferral({ recordedBy: 'CANDIDATE' })).toBe(true);
    expect(candidateMayEditSourceReferral({ recordedBy: 'HR' })).toBe(false);
  });

  it('reads as one line', () => {
    expect(sourceReferralLine(normalizeSourceReferral(ok, 'HR').referral)).toBe('Ravi Kumar (an assayer of ours) · 9876543210 · ravi@example.in');
  });
});
