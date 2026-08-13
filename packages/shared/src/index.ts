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
export * from './assayer-lifecycle';
export * from './rule-bypass';
