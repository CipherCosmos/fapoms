import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  AssayerEngagementType, AssayerUnavailableReason, EmpanelmentStatus,
  ASSAYER_ENGAGEMENT_LABELS, ASSAYER_UNAVAILABLE_LABELS, EMPANELMENT_STANDING_LABELS,
  assayerEngagementLabel, assayerUnavailableLabel,
} from '@fapoms/shared';

/**
 * One word per roster value, and one place it is written.
 *
 * Five private maps across four files said what an engagement type, an unavailability reason and
 * an empanelment standing are called: `roster-filters.ts` held three, `AssayerRecord.tsx` held
 * two more, `AssayerForms.tsx` repeated the same words as option arrays, and
 * `AssayerVettingTab.tsx` held `STANDING_LABELS`. None were exported, so the filter panel that
 * must show the same words as the record it filters could not borrow them.
 *
 * They had already drifted in five places, and the clerk-visible consequences were these:
 *
 *   REJECTED_BY_US     filter 'We rejected them'   vs record 'Rejected by us'
 *   NO_WORK_IN_AREA    'No work in their area'     vs 'No work in area'
 *   MOVED_ABROAD       'Moved out of India'        vs 'Moved abroad'
 *   MOVED_TO_COMPANY   'Now engaged through a company' vs 'Moved to company'
 *   BGV_FAILED         'Background verification failed' vs ABSENT
 *
 * The last is the one that actually broke a screen: filtering on "Background verification
 * failed" returned records that showed the raw `BGV_FAILED` back at the person who filtered.
 *
 * The maps are now total `Record<Enum, string>`s in `@fapoms/shared`, so a new enum value cannot
 * compile without a word. This spec holds the other half — that no screen starts a sixth copy.
 */
describe('roster vocabulary — one copy, in shared', () => {
  const HR = __dirname;

  it('names every engagement type, unavailability reason and standing', () => {
    // Belt as well as braces: the Record types make this a build error, and an enum value added
    // via a string union somewhere would still slip past that.
    for (const v of Object.values(AssayerEngagementType)) expect(ASSAYER_ENGAGEMENT_LABELS[v]).toBeTruthy();
    for (const v of Object.values(AssayerUnavailableReason)) expect(ASSAYER_UNAVAILABLE_LABELS[v]).toBeTruthy();
    for (const v of Object.values(EmpanelmentStatus)) expect(EMPANELMENT_STANDING_LABELS[v]).toBeTruthy();
  });

  it('gives the roster the wording it kept, not the abbreviated copy', () => {
    // The divergence was resolved in favour of the sentences, not the de-underscored column names.
    expect(assayerUnavailableLabel(AssayerUnavailableReason.REJECTED_BY_US)).toBe('We rejected them');
    expect(assayerUnavailableLabel(AssayerUnavailableReason.NO_WORK_IN_AREA)).toBe('No work in their area');
    expect(assayerUnavailableLabel(AssayerUnavailableReason.MOVED_ABROAD)).toBe('Moved out of India');
    expect(assayerUnavailableLabel(AssayerUnavailableReason.MOVED_TO_COMPANY)).toBe('Now engaged through a company');
    expect(assayerUnavailableLabel(AssayerUnavailableReason.BGV_FAILED)).toBe('Background verification failed');
    expect(assayerEngagementLabel(AssayerEngagementType.BACK_UP)).toBe('Back-up');
  });

  it('shows an unknown value rather than an empty cell', () => {
    // A row written by a newer API must still give a clerk something to read.
    expect(assayerUnavailableLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(assayerEngagementLabel(null)).toBe('');
  });

  /**
   * The source-level half. Passing the assertions above while a private map sits in an HR page
   * would mean the copy is merely unused — and an unused copy beside a live one is how the
   * first five appeared.
   */
  it('keeps no HR page writing its own copy of these words', () => {
    const offenders: string[] = [];
    const banned = /^\s*(?:export\s+)?const\s+(ENGAGEMENT_LABELS|UNAVAILABLE_LABELS|ENGAGEMENT_OPTIONS|UNAVAILABLE_OPTIONS|EMPANELMENT_STANDING_LABELS)\b[^=]*=\s*\{/;

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry) || /\.spec\.tsx?$/.test(entry)) continue;
        readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          if (banned.test(line)) offenders.push(`${entry}:${i + 1}  ${line.trim().slice(0, 80)}`);
        });
      }
    };
    walk(HR);

    // `STANDING_LABELS` in AssayerVettingTab is deliberately an ALIAS of the shared map, not a
    // literal, so it does not match the `= {` shape above and is not an offender.
    expect(offenders).toEqual([]);
  });
});
