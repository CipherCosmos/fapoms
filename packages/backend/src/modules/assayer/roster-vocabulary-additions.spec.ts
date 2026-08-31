import { readWorkingBanks } from '@fapoms/shared';

/**
 * The "Project Name" cell is the roster's per-bank applicability record, and these pins hold
 * the reading to what the real file actually contains (measured on all 1,155 rows).
 */
describe('readWorkingBanks', () => {
  it('splits a slash-separated bank list', () => {
    expect(readWorkingBanks('AXIS / AU FINANCE / IDFC').sort()).toEqual(['AU FINANCE', 'AXIS', 'IDFC']);
  });

  it('keeps L&T as one bank — the ampersand is part of the name, not a separator', () => {
    expect(readWorkingBanks('L&T / RBL')).toEqual(['L&T', 'RBL']);
  });

  it('skips the availability words that share the cell — they describe the person, not a bank', () => {
    expect(readWorkingBanks('INACITVE')).toEqual([]);
    expect(readWorkingBanks('Back up / HOLD')).toEqual([]);
    expect(readWorkingBanks('AXIS / Back up')).toEqual(['AXIS']);
  });

  it("reads the sheet's own spellings: EQITAS, a bare YES, VISTAAR FINANCE", () => {
    expect(readWorkingBanks('EQITAS')).toEqual(['EQUITAS']);
    expect(readWorkingBanks('YES')).toEqual(['YES BANK']);
    expect(readWorkingBanks('Vistaar Finance / VISTAAR')).toEqual(['VISTAAR']);
  });

  it('unfuses the cells that hold two banks in one token', () => {
    expect(readWorkingBanks('ICICI IIFL').sort()).toEqual(['ICICI', 'IIFL']);
    expect(readWorkingBanks('RBL INDEL').sort()).toEqual(['INDEL MONEY', 'RBL']);
  });

  it('an empty or blank cell names no banks', () => {
    expect(readWorkingBanks('')).toEqual([]);
    expect(readWorkingBanks(null)).toEqual([]);
    expect(readWorkingBanks('   ')).toEqual([]);
  });
});
