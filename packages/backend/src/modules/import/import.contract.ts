/**
 * FAPOMS — what a spreadsheet import is, independent of which door it came through.
 *
 * ## Why this file exists
 *
 * Branches could be imported through two endpoints that shared nothing:
 *
 * | Endpoint | Implementation | How it ran |
 * |---|---|---|
 * | `POST /projects/:id/branches/upload` | `projectService.uploadBranchesFromExcel` | queued, 202 + job id, progress, per-row reasons |
 * | `POST /branches/import/:clientId`    | `branchService.importExcel`             | inline, in the request, no progress, no cancel |
 *
 * Both wrote the same `branches` table. `branch.service.ts` even said so, in a comment sitting on
 * the line that did it: *"door into the same table, geocoded every row. Two importers, two
 * answers."* Someone found the duplication, wrote it down, and left it there.
 *
 * The two answers were not cosmetic. The inline importer did a geography check, a `findOne` and a
 * geocode **per row, inside the HTTP request**. On the real 3,759-branch client file that is
 * thousands of sequential round trips on a socket with a 300-second timeout — which is what the
 * operator experiences as the page freezing, and then as an upload that "failed" and needs doing
 * again, while the first one is still running.
 *
 * The queued importer already had the answer: prefetch by key, memoise per distinct value, report
 * every row it could not use, and publish progress. So there is one importer now, and this file
 * holds the vocabulary both scopes speak. Nothing here depends on a project — that was the only
 * thing standing between the good implementation and the endpoint that needed it.
 */

import type { ProjectBranchEntity } from '../project/project-branch.entity';

/**
 * What an import is being loaded *into*.
 *
 * A branch sheet means two different jobs depending on where it was uploaded:
 *
 * - `PROJECT` — attach these branches to an audit project, creating the project-branch link and
 *   its assessment. The branch master is updated on the way through.
 * - `CLIENT` — load or correct the client's branch master only. No project, no link, no
 *   assessment. This is the Branches page.
 *
 * Modelled as a scope rather than an optional `projectId` so the difference is stated once and
 * checked by the compiler, instead of being re-derived from `projectId == null` at each of the
 * dozen places that care.
 */
export type ImportScopeKind = 'PROJECT' | 'CLIENT';

export interface ImportScope {
  kind: ImportScopeKind;
  /** The project id or the client id, according to `kind`. */
  id: string;
}

export const importScopeEquals = (a: ImportScope, b: ImportScope): boolean =>
  a.kind === b.kind && a.id === b.id;

/**
 * What an import did.
 *
 * The counts and `skipped` are the answer to "did that work?", so they travel with the result. An
 * earlier version returned only a success flag and the resulting list: a file whose header row
 * said `Branch` instead of `BRANCH_NAME` dropped every row, and the operator saw a success message
 * beside a list that had not changed.
 */
export interface BranchImportOutcome {
  /** Data rows found in the first sheet. */
  totalRows: number;
  /** Branches created in the branch master. */
  created: number;
  /** Existing branches corrected from the sheet — only those that actually changed. */
  updated: number;
  /**
   * Existing branches the sheet matched but had nothing new to say about.
   *
   * Counted separately because `updated` deliberately counts real changes: an identical
   * re-import writes nothing, which is correct, but leaves `created` and `updated` both at zero —
   * indistinguishable from a file whose column headings did not match and from which nothing could
   * be read at all. Those two outcomes need opposite messages ("already up to date" versus "your
   * headings are wrong"), and without this count the caller has to guess which it is looking at.
   */
  unchanged: number;
  /**
   * Branches newly attached to the project (an already-attached branch is not counted).
   *
   * Always 0 for a `CLIENT` import, which has no project to link to.
   */
  linked: number;
  skipped: { row: number; solId?: string; reason: string }[];
  /**
   * Rows that imported but could not be located precisely — they need their coordinates corrected
   * before planning or check-in will behave. Distinct from `skipped`: these branches exist.
   */
  imprecise: { row: number; solId?: string; reason: string }[];
  /**
   * Archived branches this file brought back.
   *
   * Before, an archived branch was simply invisible to the importer, so a re-import created a
   * second branch beside it with the same client and SOL ID — a duplicate no later import could
   * tell apart. The importer now matches archived rows and restores them, and reports doing so:
   * a branch reappearing in the estate is a change the operator should see attributed to the file
   * they just uploaded, not discover later as an unexplained reappearance.
   */
  revived: { row: number; solId?: string; reason: string }[];
  /**
   * Facts about the FILE rather than about a row — chiefly a column heading the importer does not
   * recognise, whose data is therefore dropped in silence.
   *
   * The roster importer proved why this is needed: a sheet headed `Aadhaar Number` instead of
   * `Aadhar Card Number` imported every row, reported "created 6, skipped 0", and discarded every
   * Aadhaar. The branch importer reads its columns the same way and had the same blind spot, on a
   * file of 3,759 branches.
   */
  notes: string[];
}

/**
 * The outcome plus the project's resulting branch list.
 *
 * Split from `BranchImportOutcome` because the queued path must NOT carry the entity list: a job
 * return value is serialised into Redis, and 2,000 hydrated `ProjectBranchEntity` rows (each with
 * its branch and assignments) is megabytes of duplicated state that the caller is about to refetch
 * from `GET /projects/:id/branches` anyway. The synchronous path keeps returning it, because the
 * existing endpoint's `data` field is that list and callers depend on it. Empty for a `CLIENT`
 * import.
 */
export interface BranchUploadReport extends BranchImportOutcome {
  branches: ProjectBranchEntity[];
}

/**
 * Live counters for an import in flight, published onto the Bull job so the poll endpoint can
 * answer "how far has it got?".
 *
 * Counts only, never the `skipped`/`imprecise` detail arrays: progress is written repeatedly
 * during the run, and re-serialising a growing list of failure reasons on every update would make
 * the reporting cost grow with the number of problems in the file. The detail arrives once, in the
 * result, when the job finishes.
 */
export interface BranchImportProgress {
  processed: number;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  linked: number;
  skipped: number;
  imprecise: number;
}

/**
 * What the request can determine about an upload before committing to do it.
 *
 * This exists so the HTTP request can still reject a wrong or empty file *synchronously* — with
 * the same messages it always gave — while handing the slow part to a queue. Without it, an
 * operator who uploaded the assayer roster to the branch importer would get a cheerful 202 and a
 * job id, and only discover the mistake by polling.
 */
export interface BranchImportPreflight {
  totalRows: number;
  /**
   * Rows with no usable Latitude/Longitude, i.e. the rows that will each cost a geocode.
   *
   * The honest predictor of how long an import takes. The free OSM tiers are rate-limited to
   * about one lookup per second, so 400 unlocated rows is ~7 minutes regardless of how quick the
   * database work is, whereas 2,000 rows that carry their own coordinates never touch the
   * network. Row count alone would push the second case onto the queue for no reason and, worse,
   * would let a 60-row file with no coordinates run synchronously for a minute.
   */
  rowsNeedingGeocode: number;
  sheetName: string;
}
