import { runSheetSubmit } from './sheet-submit';

const FALLBACK = 'Could not save. Try again.';

describe('runSheetSubmit', () => {
  it('a handler that succeeds closes the sheet with no error', async () => {
    expect(await runSheetSubmit(async () => true, FALLBACK)).toEqual({ ok: true, error: null });
    expect(await runSheetSubmit(async () => ({ ok: true }), FALLBACK)).toEqual({ ok: true, error: null });
  });

  it('a plain failure keeps the sheet open with the fallback words', async () => {
    expect(await runSheetSubmit(async () => false, FALLBACK)).toEqual({ ok: false, error: FALLBACK });
  });

  it('a failure with its own words shows those words', async () => {
    expect(await runSheetSubmit(async () => ({ ok: false, error: 'Dates overlap.' }), FALLBACK)).toEqual({
      ok: false,
      error: 'Dates overlap.',
    });
    expect(await runSheetSubmit(async () => ({ ok: false, error: '  ' }), FALLBACK)).toEqual({ ok: false, error: FALLBACK });
  });

  /**
   * The defect: a handler that threw skipped the line that stopped the spinner, so the sheet spun
   * for ever. A throw is now an ordinary failure the sheet can show and recover from.
   */
  it('a handler that throws is reported, not left hanging', async () => {
    expect(
      await runSheetSubmit(async () => {
        throw new Error('Network request failed');
      }, FALLBACK),
    ).toEqual({ ok: false, error: FALLBACK });
    expect(
      await runSheetSubmit(async () => {
        throw 'weird';
      }, FALLBACK),
    ).toEqual({ ok: false, error: FALLBACK });
  });
});
