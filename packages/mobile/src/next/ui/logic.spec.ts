import {
  createTapGuard,
  fieldIssueKey,
  filterOptions,
  normaliseField,
  normaliseSearch,
  selectedIndex,
  stepStates,
} from './logic';

describe('createTapGuard', () => {
  it('ignores a second tap while the first is still running', async () => {
    const changes: boolean[] = [];
    const guard = createTapGuard((b) => changes.push(b));
    let release!: () => void;
    let calls = 0;
    const first = guard.run(() => {
      calls++;
      return new Promise<void>((r) => {
        release = r;
      });
    });
    expect(guard.isBusy()).toBe(true);
    await expect(guard.run(() => calls++)).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(calls).toBe(1);
    expect(guard.isBusy()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('frees itself even when the action throws', async () => {
    const guard = createTapGuard();
    await expect(guard.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(guard.isBusy()).toBe(false);
    await expect(guard.run(() => undefined)).resolves.toBe(true);
  });
});

describe('filterOptions', () => {
  const options = [
    { value: 'mh', label: 'Maharashtra' },
    { value: 'mp', label: 'Madhya Pradesh' },
    { value: 'hp', label: 'Himachal Pradesh' },
    { value: 'tn', label: 'तमिलनाडु', keywords: ['Tamil Nadu'] },
  ];

  it('returns everything for an empty query, in order', () => {
    expect(filterOptions(options, '  ').map((o) => o.value)).toEqual(['mh', 'mp', 'hp', 'tn']);
  });

  it('puts label-prefix matches first, then keeps the original order', () => {
    expect(filterOptions(options, 'pradesh').map((o) => o.value)).toEqual(['mp', 'hp']);
    expect(filterOptions(options, 'h').map((o) => o.value)).toEqual(['hp', 'mh', 'mp']);
  });

  it('needs every typed word, in any order', () => {
    expect(filterOptions(options, 'pradesh madhya').map((o) => o.value)).toEqual(['mp']);
  });

  it('finds an option by its keywords and by Indic text', () => {
    expect(filterOptions(options, 'tamil').map((o) => o.value)).toEqual(['tn']);
    expect(filterOptions(options, 'तमिल').map((o) => o.value)).toEqual(['tn']);
  });

  it('ignores case, accents and punctuation', () => {
    expect(normaliseSearch('  Café-Road ')).toBe('cafe road');
  });

  it('finds the selected option to scroll to', () => {
    expect(selectedIndex(options, 'hp')).toBe(2);
    expect(selectedIndex(options, 'zz' as string)).toBe(0);
    expect(selectedIndex(options, null)).toBe(0);
  });
});

describe('fieldIssueKey (shared identifier rules)', () => {
  it('only complains about an empty field when it is required', () => {
    expect(fieldIssueKey('', { required: true })).toBe('field.required');
    expect(fieldIssueKey('   ', { required: false })).toBeNull();
  });

  it('checks length', () => {
    expect(fieldIssueKey('abcdef', { maxLength: 5 })).toBe('field.tooLong');
  });

  it('uses the shared PAN, IFSC, pincode and account rules', () => {
    expect(fieldIssueKey('ABCDE1234', { ruleKey: 'panNumber' })).toBe('field.issue.pan');
    expect(fieldIssueKey('ABCDE1234F', { ruleKey: 'panNumber' })).toBeNull();
    expect(fieldIssueKey('SBIN001234', { ruleKey: 'ifscCode' })).toBe('field.issue.ifsc');
    expect(fieldIssueKey('SBIN0001234', { ruleKey: 'ifscCode' })).toBeNull();
    expect(fieldIssueKey('4110', { ruleKey: 'pincode' })).toBe('field.issue.pincode');
    expect(fieldIssueKey('411001', { ruleKey: 'pincode' })).toBeNull();
    expect(fieldIssueKey('1234', { ruleKey: 'bankAccountNumber' })).toBe('field.issue.bankAccount');
  });

  it('tells a short Aadhaar from a mistyped one', () => {
    expect(fieldIssueKey('1234', { ruleKey: 'aadhaarNumber' })).toBe('field.issue.aadhaarLength');
    expect(fieldIssueKey('123456789012', { ruleKey: 'aadhaarNumber' })).toBe('field.issue.aadhaarChecksum');
  });

  it('stays quiet on a phone number until ten digits are in', () => {
    expect(fieldIssueKey('98765', { ruleKey: 'phone' })).toBeNull();
    expect(fieldIssueKey('1234567890', { ruleKey: 'phone' })).toBe('field.issue.phone');
    expect(fieldIssueKey('9876543210', { ruleKey: 'phone' })).toBeNull();
  });

  it('tidies pasted identifiers on blur', () => {
    expect(normaliseField('abcde 1234f', 'panNumber')).toBe('ABCDE1234F');
    expect(normaliseField('1234 5678 9012', 'aadhaarNumber')).toBe('123456789012');
    expect(normaliseField('anything', undefined)).toBe('anything');
  });
});

describe('stepStates', () => {
  it('marks earlier steps done and the current one now', () => {
    expect(stepStates(3, 0)).toEqual(['current', 'todo', 'todo']);
    expect(stepStates(3, 1)).toEqual(['done', 'current', 'todo']);
    expect(stepStates(3, 3)).toEqual(['done', 'done', 'done']);
  });

  it('clamps nonsense', () => {
    expect(stepStates(3, -2)).toEqual(['current', 'todo', 'todo']);
    expect(stepStates(3, 9)).toEqual(['done', 'done', 'done']);
  });
});
