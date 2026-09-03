import { permissionKeysFrom } from './useCurrentRoles';

/**
 * The gate is only as good as what it is handed, and what it is handed comes from a cache written
 * by two different endpoints in two different shapes. Every case below is one of those shapes as
 * the running system actually produces it.
 */
describe('permissionKeysFrom', () => {
  /** The sign-in response: a flat array, already widened by the server. */
  const LOGIN_SHAPE = {
    roles: ['HR_OPERATOR'],
    permissions: ['ASSAYER:VIEW:PLATFORM', 'ASSAYER:VIEW:ORGANIZATION', 'OCR:EDIT:ORGANIZATION'],
  };

  /**
   * `/users/me`, which is the shape that actually reaches the cache: App.tsx overwrites whatever
   * sign-in produced with this a moment later, and this is what is there on every page load
   * afterwards. The rows are raw and un-widened.
   */
  const PROFILE_SHAPE = {
    roles: [{
      name: 'HR_OPERATOR',
      permissions: [
        { resource: 'ASSAYER', action: 'VIEW', scope: 'PLATFORM' },
        { resource: 'OCR', action: 'EDIT', scope: 'ORGANIZATION' },
      ],
    }],
  };

  it('reads the flat array the sign-in response carries', () => {
    expect(permissionKeysFrom(LOGIN_SHAPE)).toEqual(
      expect.arrayContaining(['ASSAYER:VIEW:ORGANIZATION', 'OCR:EDIT:ORGANIZATION']),
    );
  });

  it('reads the rows nested under each role, which is what /users/me returns', () => {
    expect(permissionKeysFrom(PROFILE_SHAPE)).toEqual(
      expect.arrayContaining(['ASSAYER:VIEW:PLATFORM', 'OCR:EDIT:ORGANIZATION']),
    );
  });

  /**
   * Both shapes have to agree, because which one is in the cache depends only on how recently the
   * person signed in. A gate that answered differently for the same account a page load apart
   * would look like an intermittent bug rather than a permissions decision.
   */
  it('answers the same for both shapes of the same account', () => {
    expect(permissionKeysFrom(PROFILE_SHAPE).sort()).toEqual(permissionKeysFrom(LOGIN_SHAPE).sort());
  });

  it('widens a PLATFORM grant to the narrower scopes, as the backend guard does', () => {
    const held = permissionKeysFrom({ roles: [{ permissions: [{ resource: 'DOCUMENT', action: 'VIEW', scope: 'PLATFORM' }] }] });
    expect(held).toEqual(expect.arrayContaining([
      'DOCUMENT:VIEW:PLATFORM', 'DOCUMENT:VIEW:ORGANIZATION', 'DOCUMENT:VIEW:CLIENT',
      'DOCUMENT:VIEW:STATE', 'DOCUMENT:VIEW:REGION', 'DOCUMENT:VIEW:DEPARTMENT',
      'DOCUMENT:VIEW:TEAM', 'DOCUMENT:VIEW:SELF',
    ]));
  });

  it('does not widen a grant that was not platform-wide', () => {
    const held = permissionKeysFrom({ roles: [{ permissions: [{ resource: 'DOCUMENT', action: 'VIEW', scope: 'TEAM' }] }] });
    expect(held).toEqual(['DOCUMENT:VIEW:TEAM']);
  });

  it('upper-cases, since the backend declares these in lower case', () => {
    expect(permissionKeysFrom({ permissions: ['assayer:view:organization'] }))
      .toEqual(['ASSAYER:VIEW:ORGANIZATION']);
  });

  /**
   * A cache written before permissions existed, a signed-out browser, a half-written entry. None
   * of these may throw: the first render after a deploy reads whatever the previous build left
   * behind, and a gate that crashes on it locks out everybody rather than nobody.
   */
  it.each([
    ['nothing at all', null],
    ['a user with no permissions key', { roles: [{ name: 'ADMIN' }] }],
    ['role names as plain strings', { roles: ['ADMIN'] }],
    ['a permissions key that is not an array of strings', { permissions: [null, 7, {}] }],
    ['rows missing a scope', { roles: [{ permissions: [{ resource: 'DOCUMENT', action: 'VIEW' }] }] }],
  ])('returns an empty list for %s rather than throwing', (_case, cached) => {
    expect(permissionKeysFrom(cached)).toEqual([]);
  });
});
