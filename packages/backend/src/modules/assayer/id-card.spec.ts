import { buildIdCardPdf, idCardExpiry } from './id-card';

/**
 * The ID card's expiry rule, pinned on its own.
 *
 * The Appraiser Recruitment spec asks for exactly one thing here — "expiry date as the end of
 * current calendar year" — and it is computed fresh on every download rather than stored, so a
 * card issued in March and one issued in November of the same year both say 31 December, and a
 * re-download next year says the next 31 December. A bug in this is silent: the PDF still renders,
 * it just tells a bank's branch that an appraiser's credential is valid when it is not.
 */
describe('ID card expiry', () => {
  it('is 31 December of the year the card was generated in', () => {
    const expiry = idCardExpiry(new Date(2026, 8, 12));
    expect(expiry.getFullYear()).toBe(2026);
    expect(expiry.getMonth()).toBe(11);
    expect(expiry.getDate()).toBe(31);
  });

  it('does not roll into next year for a card generated on the last day', () => {
    // The boundary that a naive "+1 year" or an off-by-one month would get wrong.
    expect(idCardExpiry(new Date(2026, 11, 31)).getFullYear()).toBe(2026);
    expect(idCardExpiry(new Date(2026, 11, 31)).getDate()).toBe(31);
  });

  it('tracks the year it is asked about, so a re-download next year expires next year', () => {
    expect(idCardExpiry(new Date(2027, 0, 1)).getFullYear()).toBe(2027);
    expect(idCardExpiry(new Date(2030, 5, 9)).getFullYear()).toBe(2030);
  });
});

describe('ID card rendering', () => {
  const input = {
    fullName: 'Ramesh Vitthal Kulkarni',
    assayerCode: 'AS0009',
    city: 'Pune',
    state: 'Maharashtra',
    photograph: null,
    generatedOn: new Date(2026, 8, 12),
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
