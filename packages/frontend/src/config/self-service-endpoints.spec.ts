import { readFileSync } from 'fs';
import { join } from 'path';
import { SystemRole } from '@fapoms/shared';
import { changeOwnPasswordPath, isAssayerPrincipal } from './self-service-endpoints';

describe('the self-service endpoint a principal\'s own account actions go to', () => {
  it('sends an assayer to the assayer door', () => {
    expect(changeOwnPasswordPath([{ name: SystemRole.ASSAYER }])).toBe('/assayers/me/change-password');
  });

  it('sends every staff role to the staff door', () => {
    for (const role of [
      SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR,
      SystemRole.AUDITOR, SystemRole.PRODUCT_SUPPORT, SystemRole.CLIENT_USER, SystemRole.DEVELOPER,
    ]) {
      expect(changeOwnPasswordPath([{ name: role }])).toBe('/users/me/change-password');
    }
  });

  /**
   * A custom role built in Admin → Roles is a `users` row like any other staff account, so it
   * must not be mistaken for an assayer by a check that only knows two shapes.
   */
  it('sends a custom role to the staff door', () => {
    expect(changeOwnPasswordPath([{ name: 'CERT_SURFACE_CUSTOM' }])).toBe('/users/me/change-password');
  });

  it('accepts bare role names as well as objects, and survives an absent list', () => {
    expect(changeOwnPasswordPath([SystemRole.ASSAYER])).toBe('/assayers/me/change-password');
    expect(changeOwnPasswordPath(undefined)).toBe('/users/me/change-password');
    expect(changeOwnPasswordPath(null)).toBe('/users/me/change-password');
    expect(changeOwnPasswordPath([])).toBe('/users/me/change-password');
    expect(isAssayerPrincipal([{ name: undefined as any }])).toBe(false);
  });

  /**
   * The point of the helper is that no screen hard-codes the staff path again.
   *
   * This is the check that would have caught the original defect: both self-service screens
   * posted a literal `/users/me/change-password`, and nothing anywhere said that was a decision
   * about which kind of principal was signed in.
   */
  it('is the only place either self-service screen names a change-password path', () => {
    const SRC = join(__dirname, '..');
    for (const file of ['pages/ForcePasswordChange.tsx', 'pages/Settings.tsx']) {
      const src = readFileSync(join(SRC, file), 'utf8');
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(stripped).not.toContain('/users/me/change-password');
      expect(stripped).toContain('changeOwnPasswordPath');
    }
  });
});
