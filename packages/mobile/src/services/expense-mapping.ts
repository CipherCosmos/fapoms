/**
 * Where an expense claim was for, from `GET /expenses/mine`. Pure, for the node tests.
 *
 * The server sends the claim's assignment with `projectBranch.branch` loaded; the branch's name is
 * `branch.name`. This used to read `projectBranch.branchName` — a field that does not exist — so
 * every claim on the Earnings tab said "Unknown branch".
 */
export function expenseBranchName(e: unknown): string | null {
  const a = (e as { assignment?: any } | null)?.assignment;
  const name = a?.projectBranch?.branch?.name ?? a?.branchName;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}
