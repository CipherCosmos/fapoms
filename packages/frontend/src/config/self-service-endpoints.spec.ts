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

  /**
   * The assayer's profile is read-only on the web, and the screen says so rather than offering a
   * Save button that cannot work.
   *
   * `PUT /users/me` has no assayer counterpart — the field app owns that screen
   * (`mobile/src/screens/ProfileScreen.tsx`). Before this, an assayer got a filled-in form, a
   * working-looking Save, and a 404 quoting an internal id.
   */
  it('does not offer an assayer a profile form that cannot save', () => {
    const src = readFileSync(join(__dirname, '..', 'pages/Settings.tsx'), 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // The editable form is behind `!isAssayer`; the read-only explanation is behind `isAssayer`.
    expect(stripped).toContain("activeTab === 'PROFILE' && isAssayer");
    expect(stripped).toContain("activeTab === 'PROFILE' && !isAssayer");
    // And the Save handler is reachable only from the staff branch.
    const assayerBranch = stripped.slice(
      stripped.indexOf("activeTab === 'PROFILE' && isAssayer"),
      stripped.indexOf("activeTab === 'PROFILE' && !isAssayer"),
    );
    expect(assayerBranch).not.toContain('handleSaveProfile');
  });

  /** The Security tab stays available to them, because the password change now works. */
  it('still offers an assayer the security tab', () => {
    const src = readFileSync(join(__dirname, '..', 'pages/Settings.tsx'), 'utf8');
    expect(src).toContain("activeTab === 'SECURITY'");
    expect(src).not.toMatch(/activeTab === 'SECURITY' && !isAssayer/);
  });
});
