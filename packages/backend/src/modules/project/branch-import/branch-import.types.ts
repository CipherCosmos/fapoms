/**
 * FAPOMS — what the branch-import rehearsal and commit need from the outside world.
 *
 * Both are written against these ports rather than against TypeORM and the geo helpers directly, so
 * the whole flow — 5,000 rows, every lookup counted — runs in a test in a fraction of a second, and
 * the one adapter that does touch the database (`BranchImportStore`) stays small enough to read.
 */

import type { BranchImportDecisions } from '@fapoms/shared';
import type { IfscLookupResult } from '../../geo/ifsc-lookup.helper';
import type { PincodeLookupResult } from '../../geo/pincode-lookup.helper';

export type BranchImportPhase = 'rehearse' | 'commit';

/** What a BRANCH_IMPORT job's `params` hold. */
export interface BranchImportParams {
  phase: BranchImportPhase;
  /** Commit only: what the person decided in the review. */
  decisions?: BranchImportDecisions;
}

export type BranchImportScopeType = 'CLIENT' | 'PROJECT';

/** Who the rows are being loaded for, resolved once per job. */
export interface BranchImportTarget {
  scopeType: BranchImportScopeType;
  /** The project, for a PROJECT import; null for the Branches page. */
  projectId: string | null;
  clientId: string | null;
  organizationId: string | null;
  clientName: string;
  /** The 4-letter IFSC bank code this client is, when it can be told from its name or code. */
  bankCode: string | null;
  /** The project's priority (a client import uses MEDIUM) — new branches take their risk from it. */
  priority: string;
  /** From the client's planning preferences; 15 when it has none. */
  minutesPerPacket: number;
  /** "SBI" or "Project PRJ-2026-004" — for titles and audit remarks. */
  label: string;
}

/** A branch already in the master, as much of it as the import reads. */
export interface MasterBranch {
  id: string;
  solId: string;
  name: string;
  state: string | null;
  district: string | null;
  city: string | null;
  address: string | null;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  geoSource: string | null;
  geoAccuracyMeters: number | null;
  region: string | null;
  zoneId: string | null;
  isActive: boolean;
  complexity: string | null;
  estimatedDurationHours: number | null;
}

/** The same SOL ID held by another client — the "wrong bank's file" signal. */
export interface OtherClientBranch {
  solId: string;
  clientId: string | null;
  clientName: string | null;
  name: string;
}

export interface GeocodeRequest {
  address: string;
  name: string;
  district: string;
  state: string;
  pincode: string | null;
}

export interface GeoFix {
  lat: number;
  lng: number;
  geoSource: string;
  geoAccuracyMeters: number;
  geoMatchedName: string | null;
}

/** The outside directories. Each is asked each distinct question once per job. */
export interface BranchImportLookups {
  ifsc(bankIdentifier: string, code: string): Promise<IfscLookupResult | null>;
  pincode(pin: string): Promise<PincodeLookupResult | null>;
  geocode(request: GeocodeRequest): Promise<GeoFix>;
  /**
   * Whether the geocoder's bulk answer depends on the street address. Without a Google key the fast
   * tiers answer from pincode, district and state alone, so two branches in one pincode are one
   * question, not two.
   */
  geocodeUsesAddress: boolean;
}

/** The job context, as much of it as the rehearsal and commit use. */
export interface BranchImportHooks {
  progress(processed: number, total: number | null, stage?: string, message?: string | null): Promise<void>;
  /** Throws when someone asked the job to stop. Called where stopping loses nothing. */
  throwIfCancelled(): Promise<void>;
  /**
   * Commit only: asked between chunks once writing has begun. True → stop there and report what was
   * written, rather than throwing it away with the stop.
   */
  shouldStop?(): Promise<boolean>;
}

/** How many of each lookup may be in flight at once. Small: these are free public services. */
export const LOOKUP_CONCURRENCY = {
  ifsc: 4,
  pincode: 4,
  geocode: 6,
  /** The geography check: offline for the state; a live place lookup for district/city when configured. */
  geography: 4,
} as const;

/** Rows written per transaction. A failed chunk is retried row by row, so one bad row costs only itself. */
export const COMMIT_CHUNK_SIZE = 200;
