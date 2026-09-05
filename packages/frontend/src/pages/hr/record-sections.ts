/**
 * What `?section=` on a link to an assayer record may name, and where each name lands.
 *
 * Other screens point at a *part* of the record, not just the person: HR Pay's payout-gap link
 * means the bank boxes or the PAN, a compliance chip might mean the Documents tab. The
 * parameter has already been dead once — HR Pay wrote `section=financial` for an edit modal
 * that had been removed, nothing read it, and the clerk landed on the top of the Summary with
 * the fields they came for still a hunt away.
 *
 * The contract now: `/hr/roster/:id?section=<name>` opens the record on that part.
 * `/hr/roster?assayer=<id>&section=<name>` and `/assayers/:id?section=<name>` work identically —
 * both redirects forward the parameters in RECORD_LINK_PARAMS, so either entrance keeps them.
 * AssayerRecord consumes the parameter once on arrival — a tab name opens that tab, a Summary
 * group name opens the Summary scrolled to that group with a brief ring around it — then strips
 * it from the URL so a refresh does not replay the jump.
 *
 * Kept as a dependency-free .ts module because the test runner only transforms .ts, and a
 * vocabulary that silently stops matching the screen is exactly what needs a test. The other
 * half of the guarantee is compile-time: AssayerRecord passes `RecordSectionTarget.tab` straight
 * to its `setTab`, so a name here that is not a real tab fails the build rather than rendering
 * an empty pane.
 */

/**
 * The query parameters a link to one person may carry through to their record.
 *
 * The roster's `?assayer=` redirect forwards exactly these. It is an allow-list, not "everything
 * but what the roster owns", because the roster owns a whole filter vocabulary of its own
 * (`q`, `segment`, the `f.*` filter params, `register`, `view`, …) that grows over time — a
 * deny-list would quietly start forwarding every new filter param onto record URLs, where they
 * dangle meaning nothing.
 */
export const RECORD_LINK_PARAMS = ['section', 'edit'] as const;

/** The record's tabs, by the keys AssayerRecord's TABS list uses. */
export const RECORD_TAB_KEYS = [
  'summary', 'commercial', 'skills', 'vetting', 'documents', 'qualification', 'remarks', 'history',
] as const;
export type RecordTabKey = (typeof RECORD_TAB_KEYS)[number];

/**
 * The Summary's fact groups, nameable so a link can mean "the bank details", not "the record".
 * Each is an anchor on one FactGroup panel; `financial` is "How they are paid", `identity` is
 * "Who they are" (PAN, Aadhaar).
 */
export const SUMMARY_GROUP_KEYS = [
  'contact', 'location', 'job', 'identity', 'financial', 'workload',
] as const;
export type SummaryGroupKey = (typeof SUMMARY_GROUP_KEYS)[number];

export interface RecordSectionTarget {
  tab: RecordTabKey;
  /** Set when the section is one of the Summary's groups — scroll there and ring it. */
  group?: SummaryGroupKey;
}

/**
 * Names that are neither a tab key nor a group key but that somebody writing a link would
 * plausibly use — the words on the screen. The commercial tab is labelled "Pay & terms".
 */
const ALIASES: Record<string, RecordSectionTarget> = {
  pay: { tab: 'commercial' },
};

/**
 * `?section=<raw>` to a landing spot, or null for anything unrecognised — an unknown name
 * must degrade to the record's ordinary front page, never to a blank pane or a crash.
 */
export function resolveRecordSection(raw: string | null | undefined): RecordSectionTarget | null {
  const key = raw?.trim().toLowerCase();
  if (!key) return null;
  if ((RECORD_TAB_KEYS as readonly string[]).includes(key)) return { tab: key as RecordTabKey };
  if ((SUMMARY_GROUP_KEYS as readonly string[]).includes(key)) return { tab: 'summary', group: key as SummaryGroupKey };
  return ALIASES[key] ?? null;
}
