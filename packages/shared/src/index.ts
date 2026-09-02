/**
 * FAPOMS — Shared Types Package
 *
 * This package is the single source of truth for all business types
 * shared between the backend and frontend.
 */

// Canonical business enumerations
export * from './enums';

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
