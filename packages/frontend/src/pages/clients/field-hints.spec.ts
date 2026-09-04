import { taxIdHint, taxIdGstinConsequenceHint } from './field-hints';

/**
 * The Tax ID / GSTIN field has always held either a GSTIN or a bare PAN. The hint must accept
 * both shapes and, per the task, never become a reason to refuse a save — it is advisory only.
 */
describe('taxIdHint', () => {
  it('says nothing for a blank value', () => {
    expect(taxIdHint('')).toBeNull();
    expect(taxIdHint('   ')).toBeNull();
  });

  it('says nothing for a real GSTIN', () => {
    expect(taxIdHint('27AAPFU0939F1ZV')).toBeNull();
  });

  it('says nothing for a bare PAN', () => {
    expect(taxIdHint('ABCDE1234F')).toBeNull();
  });

  it('warns, but does not throw or block, on a value matching neither shape', () => {
    expect(taxIdHint('not-a-real-number')).toEqual(expect.any(String));
  });
});

/**
 * The place-of-supply consequence of a bare PAN: `taxIdHint` above stays silent for it (it is a
 * legitimate shape), but a PAN carries no GST state prefix, so the invoice document cannot
 * determine place of supply from it. This hint is the one place that consequence is surfaced at
 * the point of data entry rather than only on a printed invoice.
 */
describe('taxIdGstinConsequenceHint', () => {
  it('says nothing for a blank value', () => {
    expect(taxIdGstinConsequenceHint('')).toBeNull();
    expect(taxIdGstinConsequenceHint('   ')).toBeNull();
  });

  it('says nothing for a real GSTIN', () => {
    expect(taxIdGstinConsequenceHint('27AAPFU0939F1ZV')).toBeNull();
  });

  it('warns for a bare PAN, where taxIdHint stays silent', () => {
    expect(taxIdHint('ABCDE1234F')).toBeNull();
    expect(taxIdGstinConsequenceHint('ABCDE1234F')).toEqual(expect.any(String));
  });

  it('says nothing for a value matching neither shape — taxIdHint already covers that case', () => {
    expect(taxIdGstinConsequenceHint('not-a-real-number')).toBeNull();
  });
});
