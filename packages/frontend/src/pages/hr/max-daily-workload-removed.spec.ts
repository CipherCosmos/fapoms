import { readFileSync } from 'fs';
import { join } from 'path';
import { ROSTER_EXPORT_COLUMNS, EXPORT_PRESETS } from './roster-export';
import { EMPLOYMENT_TERM_FIELD_KEYS, HR_MAINTAINED_ASSAYER_FIELDS } from '@fapoms/shared';

/**
 * Owner decision 2026-09-25: "Most jobs per day" is removed entirely — an assayer may take several
 * branches in one day with no cap, so a number HR was asked to maintain decided nothing. It is gone
 * from the HR forms, the record, the approval terms, the roster export and the shared field lists.
 */
describe('"Most jobs per day" is gone from the web app', () => {
  it('is not a roster export column or part of any preset', () => {
    expect(ROSTER_EXPORT_COLUMNS.map((c) => c.key)).not.toContain('maxDailyWorkload');
    for (const p of EXPORT_PRESETS) expect(p.columns).not.toContain('maxDailyWorkload');
  });

  it('is not a term the desk sets at approval, nor an HR-maintained field', () => {
    expect(EMPLOYMENT_TERM_FIELD_KEYS as readonly string[]).not.toContain('maxDailyWorkload');
    expect(HR_MAINTAINED_ASSAYER_FIELDS).not.toContain('maxDailyWorkload');
  });

  it.each([
    'AssayerForms.tsx',
    'AssayerRecord.tsx',
    'assayer-shared.ts',
    'applications/ApplicationDetailDrawer.tsx',
  ])('%s neither shows nor edits it', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8');
    expect(source).not.toMatch(/maxDailyWorkload|Most jobs (per|in a) day/);
  });
});
