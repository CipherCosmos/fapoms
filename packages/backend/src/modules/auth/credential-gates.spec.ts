import 'reflect-metadata';
import { AuthController } from './auth.controller';
import { UserController } from '../user/user.controller';
import { AssayerController } from '../assayer/assayer.controller';
import { PASSWORD_CHANGE_EXEMPT_KEY } from './guards';

/**
 * The BINDINGS of the credential gates, read off the routes the way Nest itself will.
 *
 * `guards.spec.ts` proves the guard logic; what can silently regress is a decorator falling off
 * a handler — every logic test stays green while the route stops being exempt (locking users
 * into a 403 loop) or stops being throttled (reopening unlimited token guessing). The security
 * batch of 2026-08 was once reverted wholesale by an unrelated merge (commit 7c9ee664), which is
 * exactly the failure mode metadata assertions catch. Same technique as
 * `assayer-list-limit.spec.ts`.
 */
describe('credential gate route bindings', () => {
  const isExempt = (handler: unknown) =>
    Reflect.getMetadata(PASSWORD_CHANGE_EXEMPT_KEY, handler as object) === true;

  describe('forced-password-change exemptions', () => {
    /**
     * The complete escape hatch, per principal kind. Everything here must stay reachable with
     * the flag raised, or the forcing traps the very user it is aimed at:
     *  - staff: read /users/me (how the web learns the flag), change the password, log out;
     *  - assayer: read their profile (how the mobile app learns the flag on a restored session —
     *    and its validateSession() treats a 401/403 there as session death and signs the user
     *    out), and change their password via POST /assayers/me/change-password.
     */
    it.each([
      ['GET /users/me', UserController.prototype.getMe],
      ['POST /users/me/change-password', UserController.prototype.changePassword],
      ['POST /auth/logout', AuthController.prototype.logout],
      ['GET /assayers/:assayerId/profile', AssayerController.prototype.getProfile],
      ['POST /assayers/me/change-password', AssayerController.prototype.changeMyPassword],
    ])('%s stays reachable while a password change is owed', (_route, handler) => {
      expect(isExempt(handler)).toBe(true);
    });

    /**
     * Negative control: the exemption must stay a scalpel. If someone exempts a working route —
     * or the whole controller class — the rotation gate quietly stops guarding real data.
     */
    it.each([
      ['PUT /assayers/:id', AssayerController.prototype.update],
      ['POST /assayers', AssayerController.prototype.create],
      ['GET /assayers', AssayerController.prototype.findAll],
    ])('%s is NOT exempt', (_route, handler) => {
      expect(isExempt(handler)).toBe(false);
    });

    it('no controller class is exempted wholesale', () => {
      for (const ctrl of [AuthController, UserController, AssayerController]) {
        expect(Reflect.getMetadata(PASSWORD_CHANGE_EXEMPT_KEY, ctrl)).toBeUndefined();
      }
    });
  });

  describe('token-redemption throttles', () => {
    /**
     * @nestjs/throttler v6 writes `@Throttle({ default: { limit, ttl } })` onto the handler as
     * `THROTTLER:LIMITdefault` / `THROTTLER:TTLdefault` (see its throttler.decorator.ts — the
     * constants are not exported from the package index, hence the literals).
     */
    const budgetOf = (handler: unknown) => ({
      limit: Reflect.getMetadata('THROTTLER:LIMITdefault', handler as object) as number | undefined,
      ttl: Reflect.getMetadata('THROTTLER:TTLdefault', handler as object) as number | undefined,
    });

    it('POST /auth/refresh keeps its stated budget (30/min) — the baseline biometric is held to', () => {
      expect(budgetOf(AuthController.prototype.refresh)).toEqual({ limit: 30, ttl: 60_000 });
    });

    /**
     * biometric-login redeems a stored refresh token exactly like /auth/refresh — a
     * brute-forceable secret exchanged for a full session — and it shipped for a while with no
     * throttle at all, making it the cheapest place to guess token values. It must carry a
     * budget, and never a looser one (per minute) than the refresh route it is equivalent to.
     */
    it('POST /auth/biometric-login is throttled at least as tightly as /auth/refresh', () => {
      const biometric = budgetOf(AuthController.prototype.biometricLogin);
      const refresh = budgetOf(AuthController.prototype.refresh);

      expect(biometric.limit).toBeGreaterThan(0);
      expect(biometric.ttl).toBeGreaterThan(0);
      // Requests allowed per millisecond — the comparable rate whatever the windows are.
      const rate = (b: { limit?: number; ttl?: number }) => b.limit! / b.ttl!;
      expect(rate(biometric)).toBeLessThanOrEqual(rate(refresh));
    });
  });
});
