/**
 * The project an assignment belongs to, as the detail drawer names it.
 *
 * `GET /assignments/:id` carries it at `projectBranch.project` (loaded for staff since 2026-09-24).
 * The drawer used to read a top-level `assignment.project` the server never sends, so the line
 * under the branch was always empty.
 */
export function assignmentProjectName(a: {
  projectBranch?: { project?: { name?: string | null } | null } | null;
  project?: { name?: string | null } | null;
} | null | undefined): string | null {
  return a?.projectBranch?.project?.name ?? a?.project?.name ?? null;
}
