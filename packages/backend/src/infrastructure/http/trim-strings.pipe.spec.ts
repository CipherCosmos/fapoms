import { TrimStringsPipe } from './trim-strings.pipe';

/**
 * The gap this pipe closes: `@IsNotEmpty()` rejects `""` but accepts `"   "`, and so does the
 * browser's `required` attribute. Five modules shipped records made entirely of spaces before it
 * was fixed centrally — including a *username*, which is the login identifier.
 */
describe('TrimStringsPipe', () => {
  const pipe = new TrimStringsPipe();
  const run = (v: unknown) => pipe.transform(v, {} as any);

  it('trims a field of spaces to empty, so @IsNotEmpty() is the thing that reports it', () => {
    // Not deleted — left as '' so the validation error still names the field.
    expect(run({ name: '   ' })).toEqual({ name: '' });
  });

  it('trims ordinary padding without altering the value', () => {
    expect(run({ clientCode: '  RBL  ', name: 'RBL Bank ' })).toEqual({
      clientCode: 'RBL',
      name: 'RBL Bank',
    });
  });

  it('leaves non-strings exactly as they are', () => {
    const input = { budget: 5000, active: true, missing: null, when: undefined };
    expect(run(input)).toEqual(input);
  });

  it('reaches into nested objects and arrays', () => {
    expect(run({ contact: { name: ' Priya ' }, tags: [' gold ', ' audit '] })).toEqual({
      contact: { name: 'Priya' },
      tags: ['gold', 'audit'],
    });
  });

  /**
   * Silently trimming a credential would let `"  admin123  "` authenticate as `"admin123"` —
   * quietly widening what counts as the right password, and locking out anyone whose passphrase
   * legitimately ends in a space.
   */
  it('never touches password fields', () => {
    expect(run({ password: '  secret  ', newPassword: ' x ', currentPassword: ' y ' })).toEqual({
      password: '  secret  ',
      newPassword: ' x ',
      currentPassword: ' y ',
    });
  });

  it('passes class instances and dates through untouched rather than rebuilding them', () => {
    const when = new Date('2026-08-15T00:00:00Z');
    const out = run({ when }) as { when: Date };
    expect(out.when).toBe(when);
  });

  it('handles a bare string body and a bare array body', () => {
    expect(run('  hello  ')).toBe('hello');
    expect(run([' a ', ' b '])).toEqual(['a', 'b']);
  });
});
