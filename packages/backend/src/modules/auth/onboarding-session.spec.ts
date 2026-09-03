import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  JwtAuthGuard, ONBOARDING_ALLOWED_KEY, PASSWORD_CHANGE_EXEMPT_KEY,
} from './guards';

/**
 * A registration-only session may go no further than registering.
 *
 * The four onboarding stages can sign in so an assayer can finish their own registration from a
 * phone — photographing their Aadhaar instead of carrying it to the office. They have not been
 * vetted; background verification is literally one of those stages. The ASSAYER role on its own
 * reaches nine controllers, including assignments, documents, expenses and billing, so the
 * session had to be narrowed at the same time it was opened.
 *
 * The narrowing is DENY-BY-DEFAULT, and that is the property these tests exist to hold. A route
 * added tomorrow is closed to these sessions until somebody marks it, rather than open until
 * somebody notices. Flip the check to an opt-out and the first test here fails.
 */
describe('a registration-only session', () => {
  const ctx = (user: any): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    }) as any;

  const reflectorReturning = (map: Record<string, any>) =>
    ({ getAllAndOverride: (key: string) => map[key] }) as unknown as Reflector;

  /**
   * `JwtAuthGuard` extends passport's `AuthGuard('jwt')`, whose `canActivate` does the token
   * work this suite is not about. Stubbed to succeed so each test exercises only the two checks
   * layered on top of it.
   */
  const guardFor = (map: Record<string, any>) => {
    const guard = new JwtAuthGuard(reflectorReturning(map));
    Object.getPrototypeOf(Object.getPrototypeOf(guard)).canActivate = jest.fn().mockResolvedValue(true);
    return guard;
  };

  const onboarding = { id: 'a-1', roles: [{ name: 'ASSAYER' }], onboarding: true };
  const active = { id: 'a-2', roles: [{ name: 'ASSAYER' }], onboarding: false };

  it('is REFUSED on a route nobody marked — the default is closed', async () => {
    const guard = guardFor({});
    await expect(guard.canActivate(ctx(onboarding))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('is allowed on a route marked for registration', async () => {
    const guard = guardFor({ [ONBOARDING_ALLOWED_KEY]: true });
    await expect(guard.canActivate(ctx(onboarding))).resolves.toBe(true);
  });

  it('carries a code of its own, so the app can show the checklist and not a dead end', async () => {
    const guard = guardFor({});
    await guard.canActivate(ctx(onboarding)).then(
      () => { throw new Error('should have been refused'); },
      (err) => {
        expect(err.getResponse()).toMatchObject({ code: 'REGISTRATION_IN_PROGRESS' });
        // Distinct from PASSWORD_CHANGE_REQUIRED: the two need different screens, and an app
        // that cannot tell them apart sends somebody to their HR contact for a password they
        // could have changed themselves.
        expect(err.getResponse().code).not.toBe('PASSWORD_CHANGE_REQUIRED');
      },
    );
  });

  it('does not restrict an assayer who has finished joining', async () => {
    const guard = guardFor({});
    await expect(guard.canActivate(ctx(active))).resolves.toBe(true);
  });

  it('does not restrict a principal with no onboarding flag at all', async () => {
    // Staff, and any assayer principal resolved before this flag existed. `undefined` must read
    // as "not restricted"; treating a missing flag as onboarding would lock out every staff user.
    const guard = guardFor({});
    await expect(guard.canActivate(ctx({ id: 'u-1', roles: [{ name: 'OPERATIONS' }] }))).resolves.toBe(true);
  });

  /**
   * Order matters when both conditions are true, which is the ordinary case: an invite sets
   * `mustChangePassword` and the person is mid-onboarding, so a freshly invited assayer trips
   * both. The password screen has to win — telling them their joining checks are outstanding
   * when what blocks them is an unchanged password sends them to their HR contact for something
   * they can fix themselves in ten seconds.
   */
  it('reports the password change first when both apply', async () => {
    const guard = guardFor({});
    const freshlyInvited = { ...onboarding, mustChangePassword: true };
    await guard.canActivate(ctx(freshlyInvited)).then(
      () => { throw new Error('should have been refused'); },
      (err) => expect(err.getResponse()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' }),
    );
  });

  it('still lets that person reach the change-password route itself', async () => {
    const guard = guardFor({ [PASSWORD_CHANGE_EXEMPT_KEY]: true, [ONBOARDING_ALLOWED_KEY]: true });
    const freshlyInvited = { ...onboarding, mustChangePassword: true };
    await expect(guard.canActivate(ctx(freshlyInvited))).resolves.toBe(true);
  });
});
