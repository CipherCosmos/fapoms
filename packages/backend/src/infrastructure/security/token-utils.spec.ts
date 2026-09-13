import * as crypto from 'crypto';
import { constantTimeEqual } from './token-utils';

describe('constantTimeEqual', () => {
  // Every case below asserts on a RETURN VALUE, which a naive `a === b` satisfies identically to
  // a real constant-time comparison — the property that matters here is execution-time variance,
  // which a return value can never expose. This is the one test that actually distinguishes them:
  // it fails the moment the body stops delegating to the real primitive, regardless of what any
  // return-value assertion above would say.
  it('delegates an equal-length comparison to the real constant-time primitive, not a functional shortcut', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    constantTimeEqual('same-length-a', 'same-length-b');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('accepts two identical strings', () => {
    expect(constantTimeEqual('s3cr3t-token', 's3cr3t-token')).toBe(true);
  });

  it('rejects a different value of the same length', () => {
    expect(constantTimeEqual('s3cr3t-token', 's3cr3t-tokeX')).toBe(false);
  });

  // The whole reason this helper exists: Node's timingSafeEqual throws on a length mismatch
  // instead of returning false, so every caller needs this guard in front of it.
  it('rejects a shorter or longer value without throwing', () => {
    expect(() => constantTimeEqual('short', 'a-much-longer-value')).not.toThrow();
    expect(constantTimeEqual('short', 'a-much-longer-value')).toBe(false);
    expect(constantTimeEqual('a-much-longer-value', 'short')).toBe(false);
  });

  it('treats an empty string as unequal to a non-empty one, but equal to another empty one', () => {
    expect(constantTimeEqual('', 'x')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('accepts Buffer arguments as well as strings', () => {
    expect(constantTimeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(constantTimeEqual(Buffer.from('abc'), 'abc')).toBe(true);
    expect(constantTimeEqual('abc', Buffer.from('abd'))).toBe(false);
  });
});
