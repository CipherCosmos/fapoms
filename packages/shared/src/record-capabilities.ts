/**
 * What a signed-in assayer may do to a record right now, and why not when they may not.
 *
 * The field app used to decide which buttons to show from an assignment's status alone, while the
 * server refused on facts the app never saw — the scheduled day, the 2 km zone, an assayer's
 * standing, a job already on a bill, a verified document. So people tapped, then read a refusal.
 * These shapes carry the server's own verdict to the app instead: the server builds them with the
 * SAME evaluator functions its controllers enforce with, so the app can only offer what will
 * work, and can say plainly why something is not available yet.
 *
 * Rules for both sides:
 *  - The app shows an action only if the server listed it; `allowed: false` renders disabled with
 *    `reason` (and `opensAt` when it is a matter of time). It never invents an action locally.
 *  - `code` is a stable machine code from `error-codes.ts` — the same one the route returns when
 *    it refuses — so a translated sentence can be chosen by code.
 *  - `reason` is the server's plain-English sentence, for when no translation exists.
 */

/** Everything an assayer can do to one of their assignments from the field app. */
export enum AssignmentAction {
  ACCEPT = 'ACCEPT',
  DECLINE = 'DECLINE',
  CHECK_IN = 'CHECK_IN',
  CHECK_OUT = 'CHECK_OUT',
  SUBMIT_RETURN = 'SUBMIT_RETURN',
  CLAIM_EXPENSE = 'CLAIM_EXPENSE',
  REPORT_ISSUE = 'REPORT_ISSUE',
}

export interface ActionGate<A extends string = string> {
  action: A;
  allowed: boolean;
  /** Machine code for why not (absent when allowed). */
  code?: string;
  /** Plain-English reason for why not (absent when allowed). */
  reason?: string;
  /** ISO timestamp from which the action becomes possible, when that is the only obstacle. */
  opensAt?: string;
}

/**
 * Check-in's geography, sent with the CHECK_IN gate so the phone can check itself in on arrival
 * and say how far away it is, without a round trip per GPS fix. The server still decides.
 */
export interface CheckInZone {
  latitude: number;
  longitude: number;
  /** Radius of the zone in metres (platform setting `checkInGeofenceMeters`). */
  radiusMeters: number;
  /**
   * A smaller circle inside the zone (platform setting `field.arrivalRadiusMeters`): how close the
   * phone must be before the app treats the assayer as having ARRIVED — the moment to offer
   * check-in and to note the arrival time. Never larger than `radiusMeters`. Check-in itself is
   * still allowed anywhere inside `radiusMeters`; the server gates on that, not on this. Optional:
   * absent from a server that predates it.
   */
  arrivalRadiusMeters?: number;
}

/** Attached to each assignment the assayer's work list returns. Additive: older apps ignore it. */
export interface AssignmentCapabilities {
  actions: ActionGate<AssignmentAction>[];
  checkInZone?: CheckInZone | null;
}

/**
 * How a field on the assayer's own record may be changed from the phone.
 *  - `direct`: they may change it themselves.
 *  - `locked`: they may not; HR maintains it, or it has been verified.
 *  - `reopened`: it was locked, and HR has asked for it again — they may send a new one; it locks
 *    again once sent. (Owner decision 2026-09-24: verified details cannot be changed until HR asks.)
 */
export type FieldMode = 'direct' | 'locked' | 'reopened';

export interface FieldGate {
  field: string;
  mode: FieldMode;
  code?: string;
  reason?: string;
}

/** A document on the assayer's own record, as the phone may treat it. */
export interface DocumentGate {
  requirement: string;
  mode: FieldMode;
  code?: string;
  reason?: string;
  /** HR's note when `mode` is `reopened` — what they asked to be fixed. */
  hrNote?: string | null;
}

/** `GET /assayers/me/capabilities` — what the signed-in assayer may change on their own record. */
export interface AssayerSelfCapabilities {
  fields: FieldGate[];
  documents: DocumentGate[];
}

/** Find one action's gate, treating an action the server did not list as not allowed. */
export function gateFor<A extends string>(gates: ActionGate<A>[] | undefined | null, action: A): ActionGate<A> {
  return gates?.find((g) => g.action === action) ?? { action, allowed: false };
}
