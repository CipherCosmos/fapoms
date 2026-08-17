import { withScope, scopeConflict, SCOPE_DIMENSIONS } from './scope-merge';

/**
 * The rule that decides what a request is actually filtered by.
 *
 * The header's scope and a page's own filters write the *same* query parameters, so on the wire
 * they cannot be told apart. `withScope` used to merge them with `URLSearchParams.set()`, which
 * overwrites — so whatever a page passed silently replaced the header's value, and the scope
 * indicator went on claiming something that was no longer true of the rows on screen.
 *
 * The rule now is: **global is a ceiling, local may only narrow within it.** These tests pin both
 * halves of that, because the failure is invisible — nothing throws, nothing 500s, the wrong rows
 * simply appear under a label that says otherwise.
 */
describe('scope and page filters', () => {
  describe('withScope', () => {
    it('passes a page filter through when the header has left that dimension open', () => {
      // The useful case, and the reason local filters are worth keeping: drilling into one project
      // without abandoning the working context.
      expect(withScope({}, { projectId: 'p-1' })).toBe('projectId=p-1');
    });

    it('keeps page filters that name something else entirely', () => {
      const qs = withScope({ region: 'WEST' }, { status: 'COMPLETED' });
      expect(new URLSearchParams(qs).get('region')).toBe('WEST');
      expect(new URLSearchParams(qs).get('status')).toBe('COMPLETED');
    });

    it('agreeing on the same value is not a conflict', () => {
      expect(withScope({ projectId: 'p-1' }, { projectId: 'p-1' })).toBe('projectId=p-1');
    });

    it('does NOT let a page filter overwrite the header — the bug this rule exists for', () => {
      // Before: 'projectId=p-2'. The header still displayed p-1.
      expect(withScope({ projectId: 'p-1' }, { projectId: 'p-2' })).toBe('projectId=p-1');
    });

    it('holds for every dimension the header owns, not just projectId', () => {
      for (const dimension of SCOPE_DIMENSIONS) {
        const qs = withScope({ [dimension]: 'from-header' }, { [dimension]: 'from-page' });
        expect(new URLSearchParams(qs).get(dimension)).toBe('from-header');
      }
    });

    it("treats a page's empty or ALL value as 'no opinion' rather than a conflict", () => {
      expect(withScope({ projectId: 'p-1' }, { projectId: '' })).toBe('projectId=p-1');
      expect(withScope({ projectId: 'p-1' }, { projectId: 'ALL' })).toBe('projectId=p-1');
      expect(withScope({ projectId: 'p-1' }, { projectId: undefined })).toBe('projectId=p-1');
    });
  });

  describe('scopeConflict', () => {
    it('reports the disagreement so a page can show it instead of hiding it', () => {
      expect(scopeConflict({ projectId: 'p-1' }, { projectId: 'p-2' })).toEqual({
        dimension: 'projectId',
        scoped: 'p-1',
        requested: 'p-2',
      });
    });

    it('is silent when the page narrows within an open dimension', () => {
      expect(scopeConflict({ region: 'WEST' }, { projectId: 'p-1' })).toBeNull();
    });

    it('is silent when both name the same value', () => {
      expect(scopeConflict({ projectId: 'p-1' }, { projectId: 'p-1' })).toBeNull();
    });

    it('ignores page params that are not scope dimensions', () => {
      // `status` is a genuine page filter; it can never contradict the header.
      expect(scopeConflict({ projectId: 'p-1' }, { status: 'COMPLETED' })).toBeNull();
    });

    it('agrees with withScope: whenever it reports a conflict, the header value is what ships', () => {
      const scope = { projectId: 'p-1', region: 'WEST' };
      const page = { projectId: 'p-2' };

      const conflict = scopeConflict(scope, page);
      expect(conflict).not.toBeNull();
      expect(new URLSearchParams(withScope(scope, page)).get(conflict!.dimension)).toBe(conflict!.scoped);
    });
  });
});
