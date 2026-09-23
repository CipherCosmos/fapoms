import { OnboardingDocument } from './assayer-roster-vocabulary';

/**
 * WHAT THE SCANNER NEEDS TO KNOW ABOUT EACH PAPER IT IS POINTED AT.
 *
 * The scanner was built to photograph "a document", and a document is not one thing. A PAN card is
 * 85.6 × 54mm of laminated plastic whose colour and hologram are part of what a verifier checks. A
 * joining form is four sides of A4 that only has to be *readable*. A passport photograph is a
 * 35 × 45mm portrait. Treating all three the same way gives the person holding the phone no idea
 * where to put the thing, defaults two of them to the wrong finish, and quietly assumes one page.
 *
 * So the knowledge lives here, once, as a table the compiler will not let anybody leave a hole in:
 * `Record<OnboardingDocument, …>` means a new document type does not compile until somebody has
 * said what shape it is. That is deliberate — a list of "the documents that existed the day this
 * was written" is exactly the kind of rule that goes stale silently.
 *
 * Nothing here ever refuses an upload. The shape is a guide drawn on the viewfinder and, at worst,
 * a sentence pointing out that what was captured looks like a different kind of thing. The desk
 * and the server stay the authorities on whether a document is acceptable.
 */

export type ScanShape = 'card' | 'page' | 'portrait' | 'free';

/**
 * Width ÷ height for each shape, from the real documents:
 * - `card`     ID-1, the international bank/ID card size — 85.6 × 54mm. PAN, Aadhaar, licences.
 * - `page`     A4 upright — 210 × 297mm. Every form, letter, agreement and bill.
 * - `portrait` The Indian passport-photo standard — 35 × 45mm.
 * - `free`     No expected shape, so no guide and no shape warning.
 */
export const SCAN_SHAPE_ASPECT: Record<Exclude<ScanShape, 'free'>, number> = {
  card: 85.6 / 54,
  page: 210 / 297,
  portrait: 35 / 45,
};

/** Which clean-up the scanner starts on. Matches `ScanFinish` in the web scanner. */
export type ScanFinishName = 'photo' | 'document' | 'ink';

export interface DocumentScanProfile {
  shape: ScanShape;
  finish: ScanFinishName;
  /** Whether this requirement normally holds more than one page. */
  multiPage: boolean;
  /** Shown under the viewfinder title — what to actually do with the paper. */
  hint: string;
  /**
   * The same sentence's stable name, for platforms that translate.
   *
   * The web prints `hint` because it has one language; the mobile app is English and Hindi, and a
   * translator cannot be handed an English string as a lookup key. Both read the SAME row of this
   * table, so a document whose hint changes here changes on both — which is the entire reason this
   * table exists rather than a copy of it living in each app.
   */
  hintKey: ScanHintKey;
}

export type ScanHintKey =
  | 'card' | 'aadhaarFront' | 'aadhaarBack' | 'passport'
  | 'page' | 'portrait' | 'passbook' | 'free';

const CARD: DocumentScanProfile = {
  shape: 'card',
  // Colour, not grey: the hologram, the emblem and the photograph on an identity card are part of
  // what somebody checks it against. A greyed-out PAN card is a worse document than a colour one.
  finish: 'photo',
  multiPage: false,
  hint: 'Lay the card flat inside the outline — all four corners showing.',
  hintKey: 'card',
};

const PAGE: DocumentScanProfile = {
  shape: 'page',
  // Grey with the contrast stretched, which is what a flatbed gives and what makes a signature and
  // a rubber stamp both survive. High contrast is offered but not the default: it can thin a faint
  // signature to nothing, and a signature is usually the point of these.
  finish: 'document',
  multiPage: true,
  hint: 'Flatten the page inside the outline. Add each further page after this one.',
  hintKey: 'page',
};

const FREE: DocumentScanProfile = {
  shape: 'free',
  finish: 'photo',
  multiPage: true,
  hint: 'Fill the frame with the document and hold steady.',
  hintKey: 'free',
};

/**
 * Every document this app collects, and how to photograph it.
 *
 * Grouped by what the paper physically is rather than by what it means administratively — an
 * address proof and an electricity bill are the same act of scanning even though the desk treats
 * them differently.
 */
export const DOCUMENT_SCAN_PROFILES: Record<OnboardingDocument, DocumentScanProfile> = {
  // Cards, in the hand, in colour.
  [OnboardingDocument.PAN_CARD]: CARD,
  [OnboardingDocument.AADHAAR_FRONT]: {
    ...CARD,
    hint: 'The side with the photograph, flat inside the outline. The back goes on its own row.',
    hintKey: 'aadhaarFront',
  },
  [OnboardingDocument.AADHAAR_BACK]: {
    ...CARD,
    hint: 'The side with the address, flat inside the outline.',
    hintKey: 'aadhaarBack',
  },
  [OnboardingDocument.ID_CARD]: CARD,
  [OnboardingDocument.DRIVING_LICENCE]: CARD,
  [OnboardingDocument.VOTER_ID]: CARD,
  [OnboardingDocument.PASSPORT]: {
    ...CARD,
    multiPage: true,
    hint: 'The page with the photograph, held open and flat. Add the address page after it.',
    hintKey: 'passport',
  },

  // A face, not a document.
  [OnboardingDocument.PHOTOGRAPH]: {
    shape: 'portrait',
    finish: 'photo',
    multiPage: false,
    hint: 'Head and shoulders inside the outline, facing the camera, plain background.',
    hintKey: 'portrait',
  },

  // Paper, signed or printed.
  [OnboardingDocument.JOINING_FORM]: PAGE,
  [OnboardingDocument.NDA]: PAGE,
  [OnboardingDocument.CODE_OF_CONDUCT]: PAGE,
  [OnboardingDocument.APPOINTMENT_LETTER]: PAGE,
  [OnboardingDocument.REFERENCE_CHECK]: PAGE,
  [OnboardingDocument.PENALTY_FORM]: PAGE,
  [OnboardingDocument.GOVERNANCE_AUDIT]: PAGE,
  [OnboardingDocument.ETHICAL_CONDUCT_LETTER]: PAGE,
  [OnboardingDocument.BGV_REPORT]: PAGE,
  [OnboardingDocument.POLICE_CERTIFICATE]: PAGE,
  [OnboardingDocument.CREDIT_REPORT]: PAGE,
  [OnboardingDocument.ID_PROOF]: PAGE,
  [OnboardingDocument.ADDRESS_PROOF]: PAGE,
  [OnboardingDocument.OFFICE_ADDRESS_PROOF]: PAGE,
  [OnboardingDocument.SHOP_ENTITY_PROOF]: PAGE,
  [OnboardingDocument.ASSOCIATION_LETTER]: PAGE,
  [OnboardingDocument.RENT_AGREEMENT]: PAGE,
  [OnboardingDocument.ELECTRICITY_BILL]: PAGE,
  [OnboardingDocument.EXPERIENCE_LETTER]: PAGE,

  // Neither, and honest about it: a passbook is a small booklet nobody can outline usefully, and a
  // company stamp is an impression somewhere on a sheet.
  [OnboardingDocument.BANK_PASSBOOK]: {
    ...FREE,
    hint: 'The page with the account number and the name, held flat and filling the frame.',
    hintKey: 'passbook',
  },
  [OnboardingDocument.COMPANY_STAMP]: { ...FREE, multiPage: false },
};

/** The profile for a requirement, falling back to "no expected shape" for anything unrecognised. */
export function scanProfileFor(requirement: string | null | undefined): DocumentScanProfile {
  if (!requirement) return FREE;
  return DOCUMENT_SCAN_PROFILES[requirement as OnboardingDocument] ?? FREE;
}

export type ShapeVerdict = 'fits' | 'sideways' | 'wrong-shape';

/**
 * Whether what was captured is the shape the requirement expects.
 *
 * Three answers, and the middle one is the useful one. A card photographed upright is not a
 * mistake, it is a card the right way up in somebody's hand — its aspect is the expected one turned
 * over, and the scanner can simply rotate it rather than telling anybody off. Only a shape that
 * matches neither way round is worth a sentence, and even that one is a remark, never a refusal:
 * a folded page, an unusually shaped state licence and a badly cropped corner all reach here, and
 * none of them is grounds for throwing away a scan somebody just took.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. It cannot tell a card from a page. An ID card is 1.59
 * wide-to-tall and an A4 sheet on its side is 1.41 — twelve percent apart, well inside the error of
 * four corners dragged by a thumb — and upright they are 0.63 against 0.71, the same twelve percent.
 * A4 against a passport photograph is closer still. So a full page captured on the PAN row reads
 * here as a card lying sideways, and that is the honest answer rather than a wrong one: aspect
 * alone does not carry the information, and a confident "that is the wrong document" on a correct
 * scan would teach people to ignore the warning that matters.
 *
 * What is left is genuinely catchable: a shape that matches neither orientation — half a card, a
 * strip, a whole desk, a frame with nothing rectangular in it.
 */
export function shapeVerdict(
  aspect: number, shape: ScanShape, tolerance = 1.35,
): ShapeVerdict {
  if (shape === 'free' || !Number.isFinite(aspect) || aspect <= 0) return 'fits';
  const expected = SCAN_SHAPE_ASPECT[shape];
  const off = (a: number) => Math.max(a / expected, expected / a);
  if (off(aspect) <= tolerance) return 'fits';
  if (off(1 / aspect) <= tolerance) return 'sideways';
  return 'wrong-shape';
}

/**
 * What to say when the capture is not the expected shape.
 *
 * Each one points at the corners, because that is the fix: a capture this far out is almost always
 * part of the document, or the document plus half the desk, and dragging the corners onto the real
 * edges corrects both. None of them says a scan is wrong — nothing here knows that.
 */
export function shapeRemark(verdict: ShapeVerdict, shape: ScanShape): string | null {
  if (verdict !== 'wrong-shape') return null;
  if (shape === 'card') return 'That is not the shape of a card — drag the corners onto the edges of the card itself.';
  if (shape === 'page') return 'That is not the shape of a full page — drag the corners onto the edges of the paper.';
  if (shape === 'portrait') return 'That is not the shape of a passport photograph — drag the corners onto the photo itself.';
  return null;
}
