import { readFileSync } from 'fs';
import { join } from 'path';
import {
  API_ERROR_CODES,
  FIELD_ERROR_CODES,
  GENERAL_ERROR_CODES,
  isApiErrorCode,
  fallbackCodeForStatus,
} from './error-codes';
import * as catalogue from './error-codes';

describe('isApiErrorCode', () => {
  it('recognises a real code from each category', () => {
    expect(isApiErrorCode('INVALID_CREDENTIALS')).toBe(true); // auth
    expect(isApiErrorCode('IDENTITY_NOT_VERIFIED')).toBe(true); // assayer
    expect(isApiErrorCode('OVERRIDE_REASON_REQUIRED')).toBe(true); // assignment
    expect(isApiErrorCode('VALIDATION_FAILED')).toBe(true); // general
  });

  it('recognises every code the catalogue actually declares — not a hand-picked sample', () => {
    for (const code of Object.values(API_ERROR_CODES)) {
      expect(isApiErrorCode(code)).toBe(true);
    }
  });

  it('rejects a string that is not a known code', () => {
    expect(isApiErrorCode('NOT_A_REAL_CODE')).toBe(false);
    expect(isApiErrorCode('')).toBe(false);
  });

  it('rejects a non-string outright, including the values a wire response might carry', () => {
    expect(isApiErrorCode(undefined)).toBe(false);
    expect(isApiErrorCode(null)).toBe(false);
    expect(isApiErrorCode(404)).toBe(false);
    expect(isApiErrorCode(['VALIDATION_FAILED'])).toBe(false);
    expect(isApiErrorCode({ code: 'VALIDATION_FAILED' })).toBe(false);
  });

  it('does not mistake an inherited Object property for a declared code', () => {
    // API_ERROR_CODES is a plain object; a naive `value in API_ERROR_CODES` check would say yes
    // to 'toString'/'constructor'. hasOwnProperty is what the implementation uses to avoid this.
    expect(isApiErrorCode('toString')).toBe(false);
    expect(isApiErrorCode('constructor')).toBe(false);
    expect(isApiErrorCode('hasOwnProperty')).toBe(false);
  });
});

/**
 * The categories actually spread into `API_ERROR_CODES`, read from the composition itself.
 *
 * This was four names typed out by hand, and by the time there were eight categories it was
 * comparing half the catalogue against all of it and failing — a test that had quietly become a
 * statement about the day it was written rather than about the code. Parsing the spread list means
 * a new category is covered the moment it is added, and a category that stops being composed in
 * stops being checked, both without anybody remembering to come here.
 */
function spreadCategories(): Array<[string, Record<string, string>]> {
  const source = readFileSync(join(__dirname, 'error-codes.ts'), 'utf8');
  const composition = source.match(/export const API_ERROR_CODES = \{([\s\S]*?)\} as const;/);
  if (!composition) throw new Error('API_ERROR_CODES is no longer composed by spreading categories.');
  const names = [...composition[1].matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]);
  return names.map((name) => {
    const codes = (catalogue as Record<string, unknown>)[name];
    if (!codes || typeof codes !== 'object') throw new Error(`${name} is spread in but not exported.`);
    return [name, codes as Record<string, string>];
  });
}

describe('API_ERROR_CODES composition', () => {
  it('reads the real category list, so this cannot pass by checking nothing', () => {
    const names = spreadCategories().map(([name]) => name);
    expect(names.length).toBeGreaterThan(3);
    expect(names).toContain('AUTH_ERROR_CODES');
  });

  it('has no code name defined in more than one category', () => {
    // The composed object is built by spreading four category objects together. A name reused
    // across two categories would silently let the later one win with no error — this would
    // catch that the moment it happened, rather than leaving one category's code quietly dead.
    const allKeys = spreadCategories().flatMap(([, codes]) => Object.keys(codes));
    expect(new Set(allKeys).size).toBe(allKeys.length);
    expect(Object.keys(API_ERROR_CODES).length).toBe(allKeys.length);
  });

  it('gives every code the same string as its own key — the wire value IS the code name', () => {
    for (const [key, value] of Object.entries(API_ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });
});

describe('FIELD_ERROR_CODES', () => {
  it('declares the four identity codes this module singles out by name', () => {
    expect(FIELD_ERROR_CODES.BAD_PAN).toBe('BAD_PAN');
    expect(FIELD_ERROR_CODES.BAD_AADHAAR).toBe('BAD_AADHAAR');
    expect(FIELD_ERROR_CODES.BAD_IFSC).toBe('BAD_IFSC');
    expect(FIELD_ERROR_CODES.BAD_PHONE).toBe('BAD_PHONE');
  });

  it('has no duplicate value across its own codes', () => {
    const values = Object.values(FIELD_ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('fallbackCodeForStatus', () => {
  it.each([
    [400, GENERAL_ERROR_CODES.BAD_REQUEST],
    [401, GENERAL_ERROR_CODES.UNAUTHENTICATED],
    [403, GENERAL_ERROR_CODES.FORBIDDEN],
    [404, GENERAL_ERROR_CODES.NOT_FOUND],
    [409, GENERAL_ERROR_CODES.CONFLICT],
    [413, GENERAL_ERROR_CODES.PAYLOAD_TOO_LARGE],
    [422, GENERAL_ERROR_CODES.UNPROCESSABLE],
    [429, GENERAL_ERROR_CODES.RATE_LIMITED],
    [502, GENERAL_ERROR_CODES.SERVICE_UNAVAILABLE],
    [503, GENERAL_ERROR_CODES.SERVICE_UNAVAILABLE],
    [504, GENERAL_ERROR_CODES.SERVICE_UNAVAILABLE],
  ])('maps %i to %s', (status, expected) => {
    expect(fallbackCodeForStatus(status)).toBe(expected);
  });

  it('maps an unlisted 4xx to BAD_REQUEST rather than leaving it uncategorised', () => {
    expect(fallbackCodeForStatus(418)).toBe(GENERAL_ERROR_CODES.BAD_REQUEST);
  });

  it('maps any other 5xx to INTERNAL_ERROR', () => {
    expect(fallbackCodeForStatus(500)).toBe(GENERAL_ERROR_CODES.INTERNAL_ERROR);
    expect(fallbackCodeForStatus(599)).toBe(GENERAL_ERROR_CODES.INTERNAL_ERROR);
  });

  it('always returns a code isApiErrorCode itself would accept', () => {
    for (const status of [400, 401, 403, 404, 409, 413, 418, 422, 429, 500, 502, 503, 504, 599]) {
      expect(isApiErrorCode(fallbackCodeForStatus(status))).toBe(true);
    }
  });
});

describe('codes added for the 2026-09-24 integrity fixes', () => {
  it('names every check-in/check-out refusal the attendance routes send, with unchanged wire values', () => {
    // These were bare literals in AssignmentService.recordCheckIn/recordCheckOut. Installed apps
    // compare against the literal, so each value must equal the string that used to be sent.
    for (const code of [
      'NOT_YOUR_ASSIGNMENT', 'ASSIGNMENT_COMPLETED', 'ASSIGNMENT_NOT_FOUND', 'INVALID_STATE_FOR_CHECK_IN',
      'ASSAYER_NOT_ACTIVE', 'CONFLICT_ASSIGNMENT_MODIFIED', 'NOT_SCHEDULED_TODAY', 'TOO_FAR_FROM_BRANCH',
      'NOT_CHECKED_IN',
      // Already catalogued elsewhere and sent by the same routes.
      'ASSIGNMENT_CANCELLED', 'STALE_ASSIGNMENT_VERSION', 'INVALID_ASSIGNMENT_VERSION',
    ]) {
      expect(isApiErrorCode(code)).toBe(true);
      expect((API_ERROR_CODES as Record<string, string>)[code]).toBe(code);
    }
    expect(catalogue.ATTENDANCE_ERROR_CODES.NOT_SCHEDULED_TODAY).toBe('NOT_SCHEDULED_TODAY');
    expect(catalogue.ATTENDANCE_ERROR_CODES.TOO_FAR_FROM_BRANCH).toBe('TOO_FAR_FROM_BRANCH');
  });

  it('exports the upload, expense, document-lock and leave codes', () => {
    expect(catalogue.ASSAYER_ERROR_CODES.DOCUMENT_VERIFIED_LOCKED).toBe('DOCUMENT_VERIFIED_LOCKED');
    expect(catalogue.ASSAYER_ERROR_CODES.LEAVE_OVERLAPS_ASSIGNED_WORK).toBe('LEAVE_OVERLAPS_ASSIGNED_WORK');
    expect(catalogue.OTHER_CONFLICT_ERROR_CODES.ASSIGNMENT_CLOSED).toBe('ASSIGNMENT_CLOSED');
    expect(catalogue.OTHER_CONFLICT_ERROR_CODES.EXPENSE_PAYOUT_ALREADY_APPROVED).toBe('EXPENSE_PAYOUT_ALREADY_APPROVED');
    expect(catalogue.ASSAYER_ERROR_CODES.PHOTOGRAPH_LOCKED).toBe('PHOTOGRAPH_LOCKED');
    expect(catalogue.OTHER_CONFLICT_ERROR_CODES.EXPENSE_JOB_ALREADY_BILLED).toBe('EXPENSE_JOB_ALREADY_BILLED');
    for (const code of ['DOCUMENT_VERIFIED_LOCKED', 'PHOTOGRAPH_LOCKED', 'LEAVE_OVERLAPS_ASSIGNED_WORK', 'ASSIGNMENT_CLOSED', 'EXPENSE_PAYOUT_ALREADY_APPROVED', 'EXPENSE_JOB_ALREADY_BILLED']) {
      expect(isApiErrorCode(code)).toBe(true);
    }
  });
});
