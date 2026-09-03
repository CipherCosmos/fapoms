import { AuthController } from './auth.controller';

/**
 * The pre-login check has to pass on what it worked out.
 *
 * `verifyAssayerIdentifier` learned to distinguish "no such account" from "an account with no
 * password", because 540 sign-in-eligible assayers were imported from the roster and never sent an
 * invite. The controller then shaped a fixed object and dropped the flag, so the service did the
 * work and the app never saw it — the failure mode of a hand-shaped response, and invisible from
 * either side alone.
 *
 * The shaping itself stays deliberate: this route is unauthenticated, so it returns existence and
 * a display name and nothing else. This test is what keeps the allow-list honest rather than
 * silently lossy.
 */
describe('the pre-login identifier check', () => {
  const controllerWith = (found: any) => {
    const c: any = Object.create(AuthController.prototype);
    c.authService = { verifyAssayerIdentifier: jest.fn().mockResolvedValue(found) };
    return c;
  };

  it('forwards needsAppAccess so the app can say access has not been issued', async () => {
    const c = controllerWith({ displayName: 'Meera Iyer', assayerCode: 'AS-01', needsAppAccess: true });

    const res: any = await c.verifyAssayer({ identifier: 'AS-01' });

    expect(res.data).toEqual({
      verified: true, displayName: 'Meera Iyer', assayerCode: 'AS-01', needsAppAccess: true,
    });
  });

  it('omits the flag entirely for an account that has a password', async () => {
    // Absent rather than false: the app treats a missing flag as "nothing special about this
    // account", and an explicit false would read as a claim the check did not make.
    const c = controllerWith({ displayName: 'Meera Iyer', assayerCode: 'AS-01' });

    const res: any = await c.verifyAssayer({ identifier: 'AS-01' });

    expect(res.data).toEqual({ verified: true, displayName: 'Meera Iyer', assayerCode: 'AS-01' });
  });

  it('still says nothing at all about an identifier it does not recognise', async () => {
    const c = controllerWith(null);

    const res: any = await c.verifyAssayer({ identifier: 'nobody' });

    expect(res.data).toEqual({ verified: false });
  });

  it('never returns contact details or identifiers the caller did not supply', async () => {
    // The route is unauthenticated. Whatever the service grows later, this response stays a
    // deliberate allow-list rather than a spread of the row.
    const c = controllerWith({
      displayName: 'Meera Iyer', assayerCode: 'AS-01',
      phone: '9999999999', email: 'meera@example.com', panNumber: 'ABCDE1234F', id: 'asr-1',
    });

    const res: any = await c.verifyAssayer({ identifier: 'AS-01' });

    expect(Object.keys(res.data).sort()).toEqual(['assayerCode', 'displayName', 'verified']);
  });
});
