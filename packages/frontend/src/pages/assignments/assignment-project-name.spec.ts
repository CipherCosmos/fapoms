import { assignmentProjectName } from './assignment-project-name';

describe('the drawer names the assignment\'s project', () => {
  it('reads it where the server sends it', () => {
    expect(assignmentProjectName({ projectBranch: { project: { name: 'SBI Q3' } } })).toBe('SBI Q3');
  });
  it('is null, not "undefined", when there is none', () => {
    expect(assignmentProjectName({ projectBranch: {} })).toBeNull();
    expect(assignmentProjectName(null)).toBeNull();
  });
});
