import type { Readable } from 'stream';

/**
 * THE DIGITAL ID CARD (owner, 2026-09-23).
 *
 * There is no printed or downloadable card any more — the owner's decision: the card exists only
 * in the assayer's own app, live, with a code that changes every minute and a public page that
 * checks it against the record (`id-card-verification.ts`). A PDF anyone can forward is exactly the
 * artefact a bank counter cannot trust; a live code a screenshot cannot keep is the one it can.
 *
 * What the card must NOT claim (owner's decision, 2026-09-16) still holds: it shows only what the
 * record or Admin → Settings actually holds, and a line with nothing behind it is left off.
 */

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * The role the card names. Bank branches call this person a Gold Appraiser; the HR screens call
 * the same person an assayer. One constant, so the card and every screen name the role one way.
 */
export const ID_CARD_JOB_TITLE = 'Gold Appraiser';

/**
 * One displayable line, or null when there is nothing to show.
 *
 * Trimmed, and any line breaks folded into ", " — every text slot on the card is one line tall, and
 * an address typed over several lines must not wrap into whatever sits below it.
 */
export function cardLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const line = value
    .split(/[\r\n]+/)
    .map((part) => part.trim().replace(/,+$/, '').trim())
    .filter(Boolean)
    .join(', ');
  return line ? line : null;
}

/** "City, State" from whichever halves exist; null when neither does. Never an invented place. */
export function idCardLocation(city?: string | null, state?: string | null): string | null {
  const parts = [cardLine(city), cardLine(state)].filter((p): p is string => p !== null);
  return parts.length ? parts.join(', ') : null;
}

/** The issuance judgement, as `RosterRecordsService.idCardTerms` computes it — no side effects. */
export interface IdCardTerms {
  refusals: string[];
  gated: string[];
  gateMode: string;
  issuedOn: Date;
  validTill: Date;
}

/** The card text an administrator controls, already passed through `cardLine`. */
export interface IdCardPrintedText {
  signatoryName: string | null;
  signatoryTitle: string | null;
  helplinePhone: string | null;
  officeAddress: string | null;
  /** Admin → Settings `company.legalName` — whose card this is. */
  organisation: string | null;
}

/**
 * Whether the card is issued right now — the ONE statement of that condition. The app shows the
 * live card only when it is; the verification page answers "valid" only when it is; HR's preview
 * says why when it is not.
 *
 * `refusals` block in every mode. `gated` items block only under `enforce`; under `warn` they are
 * `gaps` — the card is issued and the gap is on the audit trail.
 */
export function idCardIssueVerdict(terms: Pick<IdCardTerms, 'refusals' | 'gated' | 'gateMode'>): {
  issued: boolean;
  blockedBecause: string[];
  gaps: string[];
} {
  const enforced = terms.gateMode === 'enforce';
  const issued = terms.refusals.length === 0 && !(terms.gated.length > 0 && enforced);
  return {
    issued,
    blockedBecause: issued ? [] : [...terms.refusals, ...(enforced ? terms.gated : [])],
    gaps: enforced ? [] : [...terms.gated],
  };
}

/** What the card shows, and whether it is issued — HR's preview, and the app's card face. */
export interface IdCardFace {
  issued: boolean;
  blockedBecause: string[];
  gaps: string[];
  issuedOn: string;
  validTill: string;
  jobTitle: string;
  fullName: string;
  assayerCode: string;
  department: string | null;
  location: string | null;
  organisation: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  helplinePhone: string | null;
  officeAddress: string | null;
}

export interface IdCardPerson {
  displayName: string;
  assayerCode: string;
  department?: string | null;
  city?: string | null;
  state?: string | null;
}

/** The card's content, decided once — for the app, HR's preview and the verification page alike. */
export function idCardFace(person: IdCardPerson, terms: IdCardTerms, printed: IdCardPrintedText): IdCardFace {
  return {
    ...idCardIssueVerdict(terms),
    issuedOn: terms.issuedOn.toISOString(),
    validTill: terms.validTill.toISOString(),
    jobTitle: ID_CARD_JOB_TITLE,
    fullName: person.displayName,
    assayerCode: person.assayerCode,
    department: cardLine(person.department),
    location: idCardLocation(person.city, person.state),
    organisation: cardLine(printed.organisation),
    signatoryName: cardLine(printed.signatoryName),
    signatoryTitle: cardLine(printed.signatoryTitle),
    helplinePhone: cardLine(printed.helplinePhone),
    officeAddress: cardLine(printed.officeAddress),
  };
}
