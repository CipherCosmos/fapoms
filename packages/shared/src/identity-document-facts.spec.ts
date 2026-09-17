import {
  IDENTITY_DOCUMENTS, IDENTITY_DOCUMENT_FACTS, identityDocumentFacts,
  DOCUMENT_PRINTED_FIELDS, OnboardingDocument,
} from './index';

/**
 * ONE FORM ASKED EIGHT DIFFERENT DOCUMENTS THE SAME TWO QUESTIONS.
 *
 * "Document number" and "Expires", for every identity document on the record — when six of the
 * eight never expire and one of them has no number at all. Asking for a PAN card's expiry date is
 * asking a reviewer for something that is not on the card in their hand; they either invent it or
 * learn that this form asks for things that do not exist, and the second is worse, because the
 * next box they skip is the one that mattered.
 */
describe('what each identity document actually carries', () => {
  it('has an answer for every identity document, and only sensible ones', () => {
    for (const document of IDENTITY_DOCUMENTS) {
      const facts = IDENTITY_DOCUMENT_FACTS[document];
      expect(facts).toBeDefined();
      expect(typeof facts.expires).toBe('boolean');
      if (facts.numberLabel !== null) {
        // The number is called what it is called on the paper: a reviewer looking for "PAN" on the
        // card should read "PAN" on the screen, not "document number".
        expect(facts.numberLabel.length).toBeGreaterThan(2);
      }
    }
  });

  /** The six that are issued once and never run out. */
  it.each([
    [OnboardingDocument.PAN_CARD],
    [OnboardingDocument.AADHAAR_FRONT],
    [OnboardingDocument.AADHAAR_BACK],
    [OnboardingDocument.VOTER_ID],
    [OnboardingDocument.ID_PROOF],
    [OnboardingDocument.ADDRESS_PROOF],
  ])('does not ask when %s expires, because it does not', (document) => {
    expect(IDENTITY_DOCUMENT_FACTS[document].expires).toBe(false);
  });

  /** The two that genuinely print a valid-until date. */
  it.each([
    [OnboardingDocument.PASSPORT],
    [OnboardingDocument.DRIVING_LICENCE],
  ])('asks when %s expires, because it does', (document) => {
    expect(IDENTITY_DOCUMENT_FACTS[document].expires).toBe(true);
  });

  it('calls each number what the document calls it', () => {
    expect(IDENTITY_DOCUMENT_FACTS[OnboardingDocument.PAN_CARD].numberLabel).toBe('PAN');
    expect(IDENTITY_DOCUMENT_FACTS[OnboardingDocument.AADHAAR_FRONT].numberLabel).toBe('Aadhaar number');
    expect(IDENTITY_DOCUMENT_FACTS[OnboardingDocument.VOTER_ID].numberLabel).toBe('EPIC number');
  });

  /** An electricity bill has no number worth recording — the address on it is the point. */
  it('asks for no number where there is none to read', () => {
    expect(IDENTITY_DOCUMENT_FACTS[OnboardingDocument.ADDRESS_PROOF].numberLabel).toBeNull();
    expect(DOCUMENT_PRINTED_FIELDS[OnboardingDocument.ADDRESS_PROOF]?.address).toBe(true);
  });

  it('asks nothing it cannot be sure of for a document it does not know', () => {
    const unknown = identityDocumentFacts('SOMETHING_NEW');
    expect(unknown.expires).toBe(false);
    expect(unknown.numberLabel).toBe('Document number');
  });

  /**
   * The two tables have to agree about the same paper: the Aadhaar's address is on the BACK, and
   * its number is on both sides — which is why the back asks for a number and an address, and the
   * front asks for a number, a name, a date of birth and a gender.
   */
  it('lines up with what each document prints', () => {
    expect(DOCUMENT_PRINTED_FIELDS[OnboardingDocument.AADHAAR_FRONT]).toMatchObject({ name: true, address: false });
    expect(DOCUMENT_PRINTED_FIELDS[OnboardingDocument.AADHAAR_BACK]).toMatchObject({ name: false, address: true });
    expect(IDENTITY_DOCUMENT_FACTS[OnboardingDocument.AADHAAR_BACK].numberLabel).toBe('Aadhaar number');
  });
});
