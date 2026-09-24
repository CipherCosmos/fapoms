import { branchPointKey, planningLinkFor } from './executive-map-points';

describe('Command Center branch points (W3)', () => {
  it('keys a point by its project-branch link, and a project-less branch by itself', () => {
    expect(branchPointKey({ id: 'b-1', projectBranchId: 'pb-1' })).toBe('pb-1');
    expect(branchPointKey({ id: 'b-1', projectBranchId: 'pb-2' })).toBe('pb-2');
    expect(branchPointKey({ id: 'b-1', projectBranchId: null })).toBe('b-1');
  });

  it('offers Planning only for a branch that is in a project', () => {
    expect(planningLinkFor({ id: 'b-1', projectBranchId: 'pb-1', projectId: 'p-1' })).toBe('/planning?projectId=p-1&branchId=pb-1');
    expect(planningLinkFor({ id: 'b-1', projectBranchId: null, projectId: null })).toBeNull();
  });
});
