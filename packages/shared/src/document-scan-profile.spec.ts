import {
  DOCUMENT_SCAN_PROFILES, SCAN_SHAPE_ASPECT, scanProfileFor, shapeVerdict, shapeRemark,
  OnboardingDocument, ONBOARDING_DOCUMENT_LABELS,
} from './index';

describe('what the scanner knows about each document', () => {
  /**
   * The table is `Record<OnboardingDocument, …>`, so a missing entry is a compile error rather
   * than a test failure — this proves the other half: that the compiler's idea of "complete" and
   * the enum's actual members are the same set, and that nothing carries a nonsense shape.
   */
  it('has a profile for every document the app collects', () => {
    const documents = Object.values(OnboardingDocument);
    expect(documents.length).toBeGreaterThan(0);

    for (const document of documents) {
      const profile = DOCUMENT_SCAN_PROFILES[document];
      expect(profile).toBeDefined();
      expect(['card', 'page', 'portrait', 'free']).toContain(profile.shape);
      expect(['photo', 'document', 'ink']).toContain(profile.finish);
      expect(typeof profile.multiPage).toBe('boolean');
      // The hint is read aloud off the viewfinder by somebody holding the paper; an empty one
      // leaves them looking at a rectangle with no idea what it wants.
      expect(profile.hint.length).toBeGreaterThan(20);
      // Both apps read this one row: the web prints the sentence, the mobile app looks the key up
      // in English or Hindi. A hint with no key would be untranslatable on the phone.
      expect(profile.hintKey.length).toBeGreaterThan(0);
      expect(ONBOARDING_DOCUMENT_LABELS[document]).toBeTruthy();
    }
  });

  it('keeps identity cards in colour, because that is what gets checked', () => {
    for (const card of [
      OnboardingDocument.PAN_CARD, OnboardingDocument.AADHAAR_FRONT,
      OnboardingDocument.AADHAAR_BACK, OnboardingDocument.DRIVING_LICENCE,
      OnboardingDocument.VOTER_ID, OnboardingDocument.ID_CARD,
    ]) {
      expect(DOCUMENT_SCAN_PROFILES[card]).toMatchObject({ shape: 'card', finish: 'photo' });
    }
  });

  /** One side per row: Aadhaar has two rows precisely so each side is its own scan. */
  it('expects one page for a card and several for a form', () => {
    expect(DOCUMENT_SCAN_PROFILES[OnboardingDocument.AADHAAR_FRONT].multiPage).toBe(false);
    expect(DOCUMENT_SCAN_PROFILES[OnboardingDocument.PHOTOGRAPH].multiPage).toBe(false);
    expect(DOCUMENT_SCAN_PROFILES[OnboardingDocument.NDA].multiPage).toBe(true);
    expect(DOCUMENT_SCAN_PROFILES[OnboardingDocument.JOINING_FORM].multiPage).toBe(true);
  });

  it('says which side of the Aadhaar each row wants', () => {
    expect(DOCUMENT_SCAN_PROFILES[OnboardingDocument.AADHAAR_FRONT].hint).toMatch(/photograph/i);
    expect(DOCUMENT_SCAN_PROFILES[OnboardingDocument.AADHAAR_BACK].hint).toMatch(/address/i);
    // …and the phone can say the same thing in Hindi, because the two sides are separate keys.
    expect(DOCUMENT_SCAN_PROFILES[OnboardingDocument.AADHAAR_FRONT].hintKey).toBe('aadhaarFront');
    expect(DOCUMENT_SCAN_PROFILES[OnboardingDocument.AADHAAR_BACK].hintKey).toBe('aadhaarBack');
  });

  /** One key per distinct sentence: two documents sharing a hint must share its key, or a
      translator is asked to translate the same words twice and they drift. */
  it('uses one key per distinct sentence', () => {
    const byKey = new Map<string, Set<string>>();
    for (const profile of Object.values(DOCUMENT_SCAN_PROFILES)) {
      const seen = byKey.get(profile.hintKey) ?? new Set<string>();
      seen.add(profile.hint);
      byKey.set(profile.hintKey, seen);
    }
    for (const [key, sentences] of byKey) {
      expect({ key, sentences: [...sentences] }).toEqual({ key, sentences: [...sentences].slice(0, 1) });
    }
  });

  /** A signature is usually the point of a signed form, and high contrast can thin it to nothing. */
  it('starts a signed form on the finish that keeps a signature', () => {
    expect(DOCUMENT_SCAN_PROFILES[OnboardingDocument.NDA].finish).toBe('document');
    expect(DOCUMENT_SCAN_PROFILES[OnboardingDocument.NDA].finish).not.toBe('ink');
  });

  it('falls back to no expected shape for a requirement it does not know', () => {
    expect(scanProfileFor('SOMETHING_NEW').shape).toBe('free');
    expect(scanProfileFor(null).shape).toBe('free');
    expect(scanProfileFor(undefined).shape).toBe('free');
    expect(scanProfileFor(OnboardingDocument.PAN_CARD).shape).toBe('card');
  });
});

describe('judging what was actually captured', () => {
  const CARD = SCAN_SHAPE_ASPECT.card;   // 1.585 landscape
  const PAGE = SCAN_SHAPE_ASPECT.page;   // 0.707 upright

  it('accepts the shape it expected', () => {
    expect(shapeVerdict(CARD, 'card')).toBe('fits');
    expect(shapeVerdict(PAGE, 'page')).toBe('fits');
    expect(shapeVerdict(SCAN_SHAPE_ASPECT.portrait, 'portrait')).toBe('fits');
  });

  it('accepts a hand-held capture that is a little off', () => {
    expect(shapeVerdict(CARD * 1.25, 'card')).toBe('fits');
    expect(shapeVerdict(CARD / 1.25, 'card')).toBe('fits');
  });

  /**
   * The useful answer. A card held upright is a card, not a mistake — its aspect is the expected
   * one turned over, so the scanner rotates it instead of telling anybody off.
   */
  it('recognises the right document held the wrong way round', () => {
    expect(shapeVerdict(1 / CARD, 'card')).toBe('sideways');
    expect(shapeVerdict(1 / PAGE, 'page')).toBe('sideways');
  });

  /**
   * The limit of what aspect ratio can know, written down so nobody re-adds the check that looks
   * obvious. A card is 1.59 and an A4 sheet on its side is 1.41 — twelve percent apart, inside the
   * error of a dragged corner — so a full page on the PAN row reads as a sideways card. Answering
   * "sideways" there is honest; answering "wrong document" would be a confident guess, and a false
   * one of those teaches people to ignore the true ones.
   */
  it('does not pretend it can tell a page from a card, or from a photograph', () => {
    expect(shapeVerdict(PAGE, 'card')).not.toBe('wrong-shape');
    expect(shapeVerdict(SCAN_SHAPE_ASPECT.portrait, 'page')).toBe('fits');
  });

  /** What it genuinely can catch: a shape that is neither the document nor the document turned. */
  it('notices a capture that is no orientation of the document at all', () => {
    expect(shapeVerdict(4.2, 'card')).toBe('wrong-shape');     // half a card, or a strip of one
    expect(shapeVerdict(1.0, 'page')).toBe('wrong-shape');     // square: the desk, not the paper
    expect(shapeRemark('wrong-shape', 'card')).toMatch(/drag the corners/i);
    expect(shapeRemark('wrong-shape', 'page')).toMatch(/drag the corners/i);
  });

  it('has no opinion about a shape it was never given', () => {
    expect(shapeVerdict(CARD, 'free')).toBe('fits');
    expect(shapeVerdict(0, 'card')).toBe('fits');
    expect(shapeVerdict(Number.NaN, 'card')).toBe('fits');
    expect(shapeVerdict(Number.POSITIVE_INFINITY, 'card')).toBe('fits');
  });

  it('says nothing at all when the shape fits or is merely sideways', () => {
    expect(shapeRemark('fits', 'card')).toBeNull();
    expect(shapeRemark('sideways', 'card')).toBeNull();
  });
});
