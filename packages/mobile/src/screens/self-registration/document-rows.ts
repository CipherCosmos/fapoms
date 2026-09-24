import {
  DOCUMENT_REJECTION_GUIDANCE, ONBOARDING_DOCUMENT_LABELS, REGISTRATION_CONDITIONAL_DOCUMENTS, REGISTRATION_REQUIRED_DOCUMENTS, scanProfileFor,
  type ApplicationInfoRequestItem, type DocumentRejectionReason, type OnboardingDocument,
} from '@fapoms/shared';
import type { TranslationKey, TranslationVars } from '../../i18n/i18n';
import { hintKeyFor } from '../../services/registration-checklist';
import type { RegistrationDocument } from '../../services/self-registration.service';

/**
 * WHAT EACH DOCUMENT ROW OF THE REGISTRATION OFFERS, AND WHAT IS STILL MISSING BEFORE SUBMIT.
 *
 * The decisions behind the documents step, kept out of the component so they can be proven in node
 * (`document-rows.spec.ts`) — the mobile jest run has no React Native runtime.
 */

// ── Which camera a row opens ─────────────────────────────────────────────────────────────────

/**
 * - `scanner`    Google's ML Kit document scanner (Android): finds the edges, straightens, cleans.
 * - `camera`     The plain back camera (iOS, or an Android phone without ML Kit).
 * - `faceCamera` The FRONT camera with a crop — the ID-card face photo is a person, not a paper,
 *                and edge-finding a face makes it worse.
 */
export type CaptureKind = 'scanner' | 'camera' | 'faceCamera' | 'files';

export interface CapturePlan {
  /** The one big "Take photo" button — or, where no camera can be driven, "Choose file". */
  primary: CaptureKind;
  /** The small link under it: any file, the gallery (face photo), or nothing when the big button already is the file picker. */
  secondary: 'files' | 'gallery' | null;
  /**
   * Whether "choose file" may pick several at once. Only for documents that have pages — a card
   * or a face is one picture, so a second file there is a mistake, not a second page.
   */
  allowMultipleFiles: boolean;
  /** Whether choosing a file is limited to pictures — a face photo is never a PDF. */
  imagesOnly: boolean;
}

/**
 * `cameraAvailable` is whether expo-image-picker's native half is in this build: an APK from
 * before it was added has only the ML Kit scanner and the file picker, and must still work.
 */
export function capturePlanFor(
  requirement: string,
  opts: { scannerAvailable: boolean; cameraAvailable: boolean },
): CapturePlan {
  const profile = scanProfileFor(requirement);
  if (profile.shape === 'portrait') {
    if (opts.cameraAvailable) {
      return { primary: 'faceCamera', secondary: 'gallery', allowMultipleFiles: false, imagesOnly: true };
    }
    return opts.scannerAvailable
      ? { primary: 'scanner', secondary: 'files', allowMultipleFiles: false, imagesOnly: true }
      : { primary: 'files', secondary: null, allowMultipleFiles: false, imagesOnly: true };
  }
  const primary: CaptureKind = opts.scannerAvailable ? 'scanner' : opts.cameraAvailable ? 'camera' : 'files';
  return {
    primary,
    secondary: primary === 'files' ? null : 'files',
    allowMultipleFiles: profile.multiPage,
    imagesOnly: false,
  };
}

/** expo-image-picker settings for the face photo: front camera, 35×45 passport shape, light JPEG. */
export const FACE_PHOTO_CAMERA = {
  cameraType: 'front' as const,
  allowsEditing: true,
  // 35 × 45 mm, the Indian passport-photo standard `scanProfileFor('PHOTOGRAPH')` uses.
  aspect: [7, 9] as [number, number],
  quality: 0.85,
};

/** expo-image-picker settings for a document where ML Kit is not available. */
export const DOCUMENT_CAMERA = {
  cameraType: 'back' as const,
  allowsEditing: false,
  quality: 0.85,
};

/**
 * Whether each file of one capture replaces or adds. A retake replaces what was there with the
 * FIRST file and adds the rest after it; a first capture only adds. So picking three pages to
 * replace a two-page document leaves exactly those three pages.
 */
export function uploadReplaceFlags(fileCount: number, retake: boolean): boolean[] {
  return Array.from({ length: fileCount }, (_, i) => retake && i === 0);
}

// ── What a row says ──────────────────────────────────────────────────────────────────────────

/** "Only if …" for a document that is needed only sometimes; nothing for the rest. */
export function conditionBadgeKey(requirement: string): TranslationKey | null {
  if (!REGISTRATION_CONDITIONAL_DOCUMENTS.includes(requirement)) return null;
  if (requirement === 'RENT_AGREEMENT') return 'selfRegistration.documents.onlyIfRented';
  if (requirement === 'ELECTRICITY_BILL') return 'selfRegistration.documents.onlyIfShopRented';
  return 'selfRegistration.documents.onlyIfApplicable';
}

/**
 * The one line under a row's name before anything is added. The passbook's line is the one that
 * says a cancelled cheque or a statement also counts — it used to be hidden behind the scanner tip.
 */
export function rowNoteKey(requirement: string): TranslationKey | null {
  if (scanProfileFor(requirement).shape === 'portrait') return 'selfRegistration.documents.photoRow';
  if (requirement === 'BANK_PASSBOOK') return 'selfRegistration.documents.passbookNote';
  return hintKeyFor(requirement);
}

/**
 * What HR said is wrong with a sent-back document: their own words when they wrote some, the
 * standard guidance for the reason they picked otherwise — never a flagged row with no words.
 */
export function rejectionText(
  doc: RegistrationDocument | undefined,
  infoRequests: ApplicationInfoRequestItem[],
): string | null {
  if (!doc || doc.reviewStatus !== 'NEEDS_RESUBMIT') return null;
  const asked = infoRequests.find((i) => i.kind === 'document' && i.key === doc.requirement)?.message?.trim();
  if (asked) return asked;
  const note = doc.rejectionNote?.trim();
  if (note) return note;
  const reason = doc.rejectionReason as DocumentRejectionReason | null | undefined;
  return (reason && DOCUMENT_REJECTION_GUIDANCE[reason]) || null;
}

// ── Still needed before submit ───────────────────────────────────────────────────────────────

export type StillNeededItem = { key: TranslationKey; vars?: TranslationVars } & (
  | { step: number }
  | { requirement: string }
);

/** A requirement's name as people read it. */
export const documentLabel = (requirement: string): string =>
  ONBOARDING_DOCUMENT_LABELS[requirement as OnboardingDocument] ?? requirement;

export interface SubmitReadiness {
  otpVerified: boolean;
  hasName: boolean;
  hasCategory: boolean;
  documentsRequested: string[];
  documents: RegistrationDocument[];
}

const hasFile = (docs: RegistrationDocument[], requirement: string) =>
  docs.some((d) => d.requirement === requirement && d.filePaths.length > 0);

/** The face photo's requirement, found by its shape rather than typed out. */
export function photoRequirement(documentsRequested: string[]): string {
  return documentsRequested.find((r) => scanProfileFor(r).shape === 'portrait') ?? 'PHOTOGRAPH';
}

/** The first document the server will refuse a submit without, or null. */
export function missingSubmitDocument(documentsRequested: string[], documents: RegistrationDocument[]): string | null {
  return REGISTRATION_REQUIRED_DOCUMENTS.find(
    (req) => documentsRequested.includes(req) && !hasFile(documents, req),
  ) ?? null;
}

/**
 * Only what is NOT done, in the order a person would fix it. Empty means Submit is on — the list
 * is hidden then, rather than a column of green ticks nobody needs to read.
 */
export function stillNeeded(r: SubmitReadiness): StillNeededItem[] {
  const items: StillNeededItem[] = [];
  if (!r.otpVerified) items.push({ key: 'selfRegistration.checklist.phone', step: 1 });
  if (!r.hasName) items.push({ key: 'selfRegistration.checklist.fullName', step: 1 });
  if (!r.hasCategory) items.push({ key: 'selfRegistration.checklist.category', step: 3 });
  const photo = photoRequirement(r.documentsRequested);
  if (!hasFile(r.documents, photo)) items.push({ key: 'selfRegistration.checklist.photo', requirement: photo });
  const missing = missingSubmitDocument(r.documentsRequested, r.documents);
  if (missing) {
    items.push({ key: 'selfRegistration.checklist.document', vars: { document: documentLabel(missing) }, requirement: missing });
  }
  return items;
}
