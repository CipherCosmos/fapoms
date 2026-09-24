import { expenseBranchName } from './expense-mapping';

describe('the branch an expense claim was for', () => {
  it('reads the branch name the server loads with the claim', () => {
    expect(expenseBranchName({ assignment: { projectBranch: { branch: { name: 'Anand Nagar' } } } })).toBe('Anand Nagar');
  });

  it('is null when the server did not say', () => {
    expect(expenseBranchName({ assignment: {} })).toBeNull();
    expect(expenseBranchName({})).toBeNull();
    expect(expenseBranchName(null)).toBeNull();
  });
});
