import { JwtService } from '@nestjs/jwt';
import { verifyAccessToken } from './jwt-verify';

describe('verifyAccessToken', () => {
  const jwt = new JwtService({ secret: 'test-secret-that-is-long-enough-for-hs256' });

  it('returns the payload for a validly signed, unexpired token', async () => {
    const token = jwt.sign({ sub: 'user-1' });
    await expect(verifyAccessToken(jwt, token)).resolves.toEqual(
      expect.objectContaining({ sub: 'user-1' }),
    );
  });

  it('returns null (never throws) for a token signed with a different secret', async () => {
    const forged = new JwtService({ secret: 'someone-elses-secret-someone-elses-secret' }).sign({ sub: 'attacker' });
    await expect(verifyAccessToken(jwt, forged)).resolves.toBeNull();
  });

  it('returns null for an expired token', async () => {
    const expired = jwt.sign({ sub: 'user-1' }, { expiresIn: -1 });
    await expect(verifyAccessToken(jwt, expired)).resolves.toBeNull();
  });

  it('returns null for garbage input rather than throwing', async () => {
    await expect(verifyAccessToken(jwt, 'not-a-jwt-at-all')).resolves.toBeNull();
  });
});
