import { AuthController } from './auth.controller';

/**
 * The pre-login identifier check says the same thing about everybody.
 *
 * It is unauthenticated. It used to answer with the person's name, their assayer code, and whether
 * their account had ever been given a password — so walking codes or phone numbers through it
 * produced a staff directory, annotated with which accounts were easiest to hijack. The login
 * endpoint already refuses to tell a wrong password from a missing account; this route must not
 * undo that.
 *
 * Field-app builds in circulation still call it after a failed sign-in and read only
 * `needsAppAccess`; with the flag absent they show the ordinary credential message.
 */
describe('the pre-login identifier check', () => {
  const controllerWith = (found: any) => {
    const c: any = Object.create(AuthController.prototype);
    c.authService = { verifyAssayerIdentifier: jest.fn().mockResolvedValue(found) };
    return c;
  };

  const cases: Array<[string, any]> = [
    ['a recognised account with a password', { displayName: 'Meera Iyer', assayerCode: 'AS-01' }],
    ['a recognised account never given app access', { displayName: 'Meera Iyer', assayerCode: 'AS-01', needsAppAccess: true }],
    ['an identifier nobody holds', null],
  ];

  it.each(cases)('answers identically for %s', async (_label, found) => {
    const c = controllerWith(found);
    const res = await c.verifyAssayer({ identifier: 'AS-01' });
    expect(res).toEqual({ accepted: true });
  });

  it('never names the person, echoes the code, or says whether they have a password', async () => {
    const c = controllerWith({ displayName: 'Meera Iyer', assayerCode: 'AS-01', needsAppAccess: true, phone: '9999999999' });
    const body = JSON.stringify(await c.verifyAssayer({ identifier: 'AS-01' }));
    expect(body).not.toMatch(/Meera|AS-01|needsAppAccess|displayName|assayerCode|9999999999|verified/);
  });

  it('does not even look the identifier up, so timing cannot tell them apart either', async () => {
    const c = controllerWith({ displayName: 'Meera Iyer', assayerCode: 'AS-01' });
    await c.verifyAssayer({ identifier: 'AS-01' });
    expect(c.authService.verifyAssayerIdentifier).not.toHaveBeenCalled();
  });
});
