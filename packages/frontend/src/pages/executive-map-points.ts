/**
 * How the Command Center tells its branch points apart.
 *
 * A branch that sits in two projects is two points with the same branch `id`, and a branch in no
 * project (the "extras" the server adds so the map is complete) has no `projectBranchId` or
 * `projectId` at all. Keyed and selected by branch id, the two project points collided (React keys,
 * and a click always opened the first); and "Open in Planning" navigated to `projectId=null`.
 */
export interface PointIdentity {
  id: string;
  projectBranchId?: string | null;
  projectId?: string | null;
}

/** The point's own key: its project-branch link when it has one, else the branch. */
export function branchPointKey(p: PointIdentity): string {
  return p.projectBranchId ?? p.id;
}

/** Where "Open in Planning" goes, or null when the branch is in no project (nothing to plan). */
export function planningLinkFor(p: PointIdentity): string | null {
  if (!p.projectId || !p.projectBranchId) return null;
  return `/planning?projectId=${encodeURIComponent(p.projectId)}&branchId=${encodeURIComponent(p.projectBranchId)}`;
}
