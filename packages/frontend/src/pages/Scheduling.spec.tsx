// `Scheduling.tsx` imports `../services/api` at module scope, which transitively reaches
// `./socket`'s Vite-only `import.meta.env` — unparseable by Jest's CommonJS transform. Mocked
// before the import below so that chain never loads; every other page spec in this codebase
// does the same for the same reason.
jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));

import { RESCHEDULE_REASON_PRESETS, RESCHEDULE_REASON_OTHER, rescheduleReasonSelectValue } from './Scheduling';

/**
 * The reschedule reason. Before this, `handleConfirmReschedule` always posted the
 * machine-generated `Rescheduled to <date>` string and nothing else — the actual why was
 * discarded, not just left as unstructured free text. These tests hold the pure derivation the
 * preset select is built on; a full render of the reschedule modal would need to mock the
 * schedules list, documents fetch and socket connection this page also pulls in, for behavior
 * that reduces to one string comparison.
 */
describe('rescheduleReasonSelectValue', () => {
  it('reflects a preset back as itself', () => {
    for (const preset of RESCHEDULE_REASON_PRESETS) {
      expect(rescheduleReasonSelectValue(preset)).toBe(preset);
    }
  });

  it('falls back to Other for empty or free-typed text', () => {
    expect(rescheduleReasonSelectValue('')).toBe(RESCHEDULE_REASON_OTHER);
    expect(rescheduleReasonSelectValue('The bridge is out')).toBe(RESCHEDULE_REASON_OTHER);
  });

  /**
   * The mutation this guards against: hard-coding the select to always read as a fixed preset,
   * which would make a hand-typed reason invisible to the select without touching what actually
   * gets submitted (the text box's own value, not the select's).
   */
  it('does not silently coerce a near-miss into a preset', () => {
    expect(rescheduleReasonSelectValue('assayer unavailable')).toBe(RESCHEDULE_REASON_OTHER);
  });

  it('never returns an empty string, even for empty input, so the select always has a real option selected', () => {
    expect(rescheduleReasonSelectValue('')).not.toBe('');
  });
});
