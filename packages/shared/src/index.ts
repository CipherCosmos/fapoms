/**
 * FAPOMS — Shared Types Package
 *
 * This package is the single source of truth for all business types
 * shared between the backend and frontend.
 */

// Canonical business enumerations
export * from './enums';

// The role hierarchy: which built-in roles imply which (DEVELOPER ⊇ ADMIN + PRODUCT_SUPPORT)
export * from './role-hierarchy';

// The destructive-action two-person rule (developer requests, admin approves, developer executes)
export * from './destructive-action';

// Upload ceilings and the scan accept-list — one source for server guard and pickers
export * from './upload-limits';

// Operational limits (check-in geofence, expense claim cap) and their shipped fallback
export * from './platform-limits';

// Canonical geographic regions and the state → region map
export * from './regions';
export * from './pincode';
// Per-document scanning guidance (shape, finish, page count)
export * from './document-scan-profile';

// Domain entity interfaces
export * from './interfaces';

// API request/response contracts
export * from './api-contracts';

// State machine definitions and validators
export * from './state-machines';

// Canonical display labels for every status enum
export * from './labels';

// What "coverage" means, and the one calculation the planning screen, the planning endpoint and
// the client-facing workbook all report from
export * from './coverage';

// Shared utilities
export * from './utils';

// A message (email or SMS) the system has promised to send, and where it has got to
export * from './outbound-message';
export * from './email-layout';

// GST state-code resolution, tax-split labelling and amount-in-words for invoices
export * from './gst';
export * from './billing-liveness';
export * from './assayer-lifecycle';
export * from './assayer-record';
export * from './workforce-registration';
export * from './rule-bypass';

// The roster spreadsheet's own words, and the vocabularies they are read into
export * from './assayer-roster-vocabulary';

// Qualification scoring: dimension vocabulary, view types, standing caps, PII masking
export * from './assayer-qualification';
export * from './assignment-fee';

// The Appraiser Recruitment application layer — pre-account interview/registration, separate
// from the guarded live assayer lifecycle
export * from './assayer-application';

// References a candidate names before approval: how many, and what counts as one
export * from './application-references';

// PAN/Aadhaar/IFSC/phone validation — one rulebook for the importer and every API write path
export * from './identity-validation';

// Comparing a name on a card with a name on a record, and the edit distance both it and the
// region canonicaliser measure with.
export * from './text-distance';
export * from './name-match';

// What "assign anyway" may and may not waive — read by the engine, the write path and the panel.
export * from './assignment-override';

// Assayer invoicing: the consent wrapper over payables (invite → submit → approve) API shapes
export * from './assayer-invoicing';

// Service-log viewer: the readable-service allowlist, line shape and query ceilings
export * from './service-logs';

// The machine-readable name of every failure the API can return, and the shape of an error body.
// Lives here so a translated client keys off a code rather than matching the English sentence.
export * from './error-codes';

// Approving an expense claim the rules refuse: who may override, and on which refusals
export * from './expense-approval';

// Cleans the workforce-attribute vocabulary endpoint's raw rows into name lists — one
// implementation, read by both the web hook and the mobile service that used to each carry their
// own de-dupe/sort.
export * from './workforce-vocabulary';

// Resolves a LiveKit signaling URL the backend may have returned as a bare relative path — one
// implementation, read by both the web call service and the mobile calls service that used to
// each carry their own copy.
export * from './livekit-url';

// Socket.IO reconnection behaviour, byte-identical between the web and mobile socket clients
// since the mobile fix was ported to web verbatim — one object so the two cannot silently drift.
export * from './socket-transport-config';
export * from './registration-consent';
export * from './identifier-entry';
export * from './registration-form';
export * from './source-referral';
export * from './onboarding-approval';
export * from './periodic-checks';
export * from './record-capabilities';
export * from './check-in-rules';
// The candidate's road from the registration form to their first job — the one step list, and the
// words for it, that the web link and the phone app both show after the form is sent.
export * from './candidate-journey';

// Work the server accepted and is doing in the background (uploads, imports): status, progress,
// result, and which page owns each kind
export * from './background-jobs';

// A branch list rehearsed, reviewed and committed as background jobs: which fields a person may
// edit in the review, what makes a row ready, and how their decisions are applied — one rule
// for the review screen and the commit job alike.
export * from './branch-import';
