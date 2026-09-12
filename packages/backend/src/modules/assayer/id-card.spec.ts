import { buildIdCardPdf } from './id-card';

/**
 * The expiry RULE moved out of this file. It used to be pinned here as "always December 31 of the
 * current year" — including a test asserting that a card generated on December 31st expires that
 * same day, which the owner spotted as absurd the moment they saw the process drawn. The rule now
 * lives in `identity-artifacts.ts`, is configurable, and carries a year-end grace window; its
 * table of cases, December-31st joiner first, is in `identity-artifacts.spec.ts`. This file now
 * pins only what the builder still owns: rendering a real PDF from the inputs it is handed.
 */

describe('ID card rendering', () => {
  const input = {
    fullName: 'Ramesh Vitthal Kulkarni',
    assayerCode: 'AS0009',
    city: 'Pune',
    state: 'Maharashtra',
    photograph: null,
    generatedOn: new Date(2026, 8, 12),
    validTill: new Date(2026, 11, 31),
  };

  it('produces a real PDF', async () => {
    const pdf = await buildIdCardPdf(input);
    // `%PDF-` rather than just a non-empty buffer: the first build of this shipped a default
    // import of pdfkit that type-checked, built, and threw `is not a constructor` the moment it
    // was called. Asserting the magic bytes is what makes that reachable from the suite.
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(500);
  });

  it('still renders a card when there is no photograph on file', async () => {
    // Most freshly-promoted assayers have none — the card must issue anyway, with a placeholder.
    await expect(buildIdCardPdf({ ...input, photograph: null })).resolves.toBeInstanceOf(Buffer);
  });

  it('does not fail the whole card on an unreadable photograph', async () => {
    // A corrupt or truncated stored image must not cost somebody their ID card.
    const notAnImage = Buffer.from('this is not a picture');
    await expect(buildIdCardPdf({ ...input, photograph: notAnImage })).resolves.toBeInstanceOf(Buffer);
  });
});
