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

// Canonical geographic regions and the state → region map
export * from './regions';
export * from './pincode';

// Domain entity interfaces
export * from './interfaces';

// API request/response contracts
export * from './api-contracts';

// State machine definitions and validators
export * from './state-machines';

// Canonical display labels for every status enum
export * from './labels';

// Shared utilities
export * from './utils';

// GST state-code resolution, tax-split labelling and amount-in-words for invoices
export * from './gst';
export * from './assayer-lifecycle';
export * from './assayer-record';
export * from './rule-bypass';

// Upload size limits shared by the API and every client that offers a file picker
export * from './upload-limits';

// The roster spreadsheet's own words, and the vocabularies they are read into
export * from './assayer-roster-vocabulary';

// Qualification scoring: dimension vocabulary, view types, standing caps, PII masking
export * from './assayer-qualification';
export * from './assignment-fee';

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
