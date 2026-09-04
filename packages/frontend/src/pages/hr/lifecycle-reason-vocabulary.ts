/**
 * Why somebody was moved to a lifecycle stage that ends up on their employment record, offered as
 * choices instead of a blank box.
 *
 * This does not add a constraint the server did not already have: `reason` is still the free
 * string `AssayerService.dispatchLifecycleTransition` requires to be non-blank for SUSPENDED,
 * INACTIVE, RESIGNED and TERMINATED, and it is stored exactly as typed either way — nothing here
 * changes the backend contract. What changes is what a clerk sees while typing it. Querying
 * `assayers.notes` for people who have actually left turned up the same handful of reasons over
 * and over, spelled inconsistently enough that the column cannot be grouped by reason today —
 * "Behaviour issue" alone shows up as at least two different misspellings in the real data. The
 * list below is that clustering, so today's entries stop joining the pile instead of fixing it.
 *
 * "Someone else did their audit for them" earns its own line rather than folding into "Behaviour
 * issue": it is the platform's own #1 vetting alert ("N appraisers have work attended by somebody
 * else"), so far only ever findable by a notes-text match. Picking it here is what makes the
 * alert queryable by reason.
 */
export const LIFECYCLE_MOVE_REASONS = [
  'Not doing regular/any audit',
  'Audit not up to the mark',
  'Behaviour issue',
  'Not responding in call',
  'Resignation/termination paperwork not completed',
  'Joined another company',
  'Someone else did their audit for them',
  'Mandatory test/compliance not done',
  'Background/criminal-record issue',
  'Commercial dispute (fee/invoice)',
  'Literacy/language barrier',
] as const;

/**
 * Dropdown sentinel meaning "none of these — let me type it". Never sent to the server: choosing
 * it only reveals the free-text box, and what that box holds is what actually gets sent, same as
 * before this dropdown existed.
 */
export const OTHER_LIFECYCLE_REASON = '__OTHER__';
