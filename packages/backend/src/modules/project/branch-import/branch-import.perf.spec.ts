/**
 * The owner's target: a 5,000-branch client list in minutes, not tens of minutes.
 *
 * The directories are mocked with a real delay (5 ms a question) so the test measures what the
 * importer controls — how many questions it asks and how many it has in flight — rather than the
 * public services' own speed. The old preview asked one question per row, in order: at 5 ms that is
 * 25 s for the geocoder alone on this file, and on the real services (seconds each) it was the
 * tens of minutes. The bound here is on the number of questions, which is what carries over.
 */

import { commitBranchImport } from './branch-import.commit';
import { rehearseBranchImport } from './branch-import.rehearsal';
import { countingLookups, MemoryBranchStore, parsed, quietHooks, target } from './branch-import.fixtures';

const ROWS = 5_000;
const PINCODES = 400;

describe('branch import at 5,000 rows', () => {
  it('rehearses and commits within budget, asking each directory at most once per distinct question', async () => {
    const rows = Array.from({ length: ROWS }, (_, i) => {
      const pin = String(600001 + (i % PINCODES));
      return {
        BRANCH: `P-${i}`,
        BRANCH_NAME: `Branch ${i}`,
        // One row in five has no district, so a directory is needed for it.
        DISTRICT: i % 5 === 0 ? '' : 'Chennai',
        STATE: 'Tamil Nadu',
        'Branch Address': `${i} Anna Salai, Chennai ${pin}`,
        Pincode: pin,
        Packets: 20 + (i % 100),
        // An IFSC column on every row: the old preview looked every one of them up.
        IFSC: `SBIN0${String(100000 + i).slice(-6)}`,
      };
    });
    const sheet = parsed(rows);
    const store = new MemoryBranchStore();
    const { lookups, calls } = countingLookups({ delayMs: 5 });

    const started = Date.now();
    const { report } = await rehearseBranchImport(sheet, target(), store.reads(), lookups, quietHooks());
    const rehearsedAt = Date.now();
    const outcome = await commitBranchImport(
      { report, decisions: { mode: 'all_valid', excluded: [], edits: {} }, target: target(), userId: 'u', jobId: 'j', regions: null },
      store.commitStore(),
      lookups,
      quietHooks(),
    );
    const committedAt = Date.now();

    const uniquePins = new Set(rows.map((r) => r.Pincode)).size;
    // eslint-disable-next-line no-console
    console.log(
      `[perf] ${ROWS} rows: rehearsal ${rehearsedAt - started} ms, commit ${committedAt - rehearsedAt} ms; ` +
        `ifsc=${calls.ifsc.length} pincode=${calls.pincode.length} geocode=${calls.geocode.length} ` +
        `(unique pincodes ${uniquePins}); chunks=${store.chunks.length}`,
    );

    expect(outcome.counts.created).toBe(ROWS);
    // Only the rows missing a district asked the IFSC directory — each code once — never the 4,000
    // complete rows that merely have an IFSC column. Their answer supplied the district, so India
    // Post was not needed on top.
    expect(calls.ifsc).toHaveLength(ROWS / 5);
    expect(new Set(calls.ifsc).size).toBe(calls.ifsc.length);
    expect(calls.pincode.length).toBeLessThanOrEqual(uniquePins);
    // District-less rows geocode under the district India Post supplied, so at most two places a pincode.
    expect(calls.geocode.length).toBeLessThanOrEqual(uniquePins * 2);
    expect(store.chunks).toHaveLength(Math.ceil(ROWS / 200));
    expect(committedAt - started).toBeLessThan(20_000);
  }, 60_000);
});
