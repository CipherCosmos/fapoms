import * as fs from 'fs';
import * as ts from 'typescript';
import * as path from 'path';
import { SELF_EDITABLE_ASSAYER_FIELDS } from '@fapoms/shared';

/**
 * The assayer's profile save must be a PATCH, not a re-assertion of the whole record.
 *
 * Two things went wrong when it sent everything:
 *
 *  1. The server validates address consistency on every update. For the ~1,155 roster-imported
 *     records whose pincode and state disagree, changing a PHONE NUMBER was refused with
 *     "Pincode 411045 is in Maharashtra, but the entered state is …" — an error about a field the
 *     assayer never touched, on a screen that does not show it. The record became un-editable.
 *  2. Anything the screen held stale was written back over the server's newer value.
 *
 * These tests exercise the diff directly by loading it out of the mobile hook, because the mobile
 * package has no test runner of its own and this logic is worth holding still.
 */
const HOOK = path.join(__dirname, '../../../../mobile/src/hooks/useAssayerProfile.ts');

/**
 * `changedFields` compiled out of the hook.
 *
 * The alternative is importing from packages/mobile, which drags React Native's entire module
 * graph into a Node test run. The function is self-contained, so the source between its own two
 * markers is extracted and evaluated.
 */
function loadChangedFields(): (next: any, base: any) => Record<string, any> {
  const source = fs.readFileSync(HOOK, 'utf-8');
  const start = source.indexOf('const SENDABLE_PROFILE_KEYS');
  const end = source.indexOf('function emptyProfile');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  const body = source.slice(start, end).replace(/export function/g, 'function');

  // Transpiled rather than regex-stripped: the snippet is TypeScript, and hand-removing type
  // annotations is exactly the kind of thing that starts passing for the wrong reason.
  const js = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;

  // eslint-disable-next-line no-new-func
  return new Function(`${js}; return changedFields;`)() as any;
}

describe('assayer profile partial save', () => {
  const changedFields = loadChangedFields();

  const base = {
    phone: '+919876543210', alternatePhone: '', email: 'a@b.com',
    address: 'Old Street', city: 'Pune', district: 'Pune', state: 'Karnataka', pincode: '411045',
    latitude: 18.52, longitude: 73.85,
    emergencyName: 'Asha', emergencyPhone: '+919000000000', emergencyRelation: 'Sister',
    skills: 'gold, silver', languages: 'Hindi', preferredRegions: 'WEST', experienceYears: 4,
    // Read-only / HR-maintained, present on the screen's state but never sendable.
    panNumber: 'ABCDE1234F', bankAccountNumber: '111122223333', joiningDate: '2024-01-01',
    maxDailyWorkload: 3, totalAssignments: 40, averageRating: 4.6,
  };

  it('sends only the field that changed', () => {
    const next = { ...base, phone: '+919999999999' };
    expect(changedFields(next, base)).toEqual({ phone: '+919999999999' });
  });

  /**
   * The reported bug, stated as a test: the mismatched address must not ride along on an
   * unrelated edit, or the server rejects the save over a field nobody touched.
   */
  it('does not resend an untouched address when only the phone changed', () => {
    const next = { ...base, phone: '+919999999999' };
    const sent = changedFields(next, base);
    for (const key of ['address', 'city', 'district', 'state', 'pincode']) {
      expect(sent).not.toHaveProperty(key);
    }
  });

  it('never sends a field the assayer is not allowed to edit', () => {
    // Even if the screen's copy has drifted from the server's, these must not be written back.
    const next = { ...base, panNumber: 'ZZZZZ9999Z', bankAccountNumber: '999', joiningDate: '2020-01-01', maxDailyWorkload: 99 };
    expect(changedFields(next, base)).toEqual({});
  });

  it('never sends read-only statistics', () => {
    const next = { ...base, totalAssignments: 999, averageRating: 1.0 };
    expect(changedFields(next, base)).toEqual({});
  });

  it('sends nothing at all when nothing changed', () => {
    expect(changedFields({ ...base }, base)).toEqual({});
  });

  /**
   * Coordinates describe one fact and the API ignores a lone half, so a moved pin has to send
   * both — otherwise the screen shows the new position and the server keeps the old one.
   */
  it('sends latitude and longitude together when either moves', () => {
    const sent = changedFields({ ...base, latitude: 19.0 }, base);
    expect(sent).toEqual({ latitude: 19.0, longitude: 73.85 });
  });

  it('treats a numeric field retyped as the same string as unchanged', () => {
    // FieldInput hands back strings; '4' must not look like an edit against the number 4.
    expect(changedFields({ ...base, experienceYears: '4' }, base)).toEqual({});
  });

  it('carries a deliberate clear through, rather than dropping it', () => {
    // '' means "remove this", which the API maps to null. Silently dropping it was its own bug.
    expect(changedFields({ ...base, alternatePhone: '' }, { ...base, alternatePhone: '+9111' }))
      .toEqual({ alternatePhone: '' });
  });

  /**
   * The local names on the phone must stay a subset of what the API accepts, or the all-or-
   * nothing 403 turns one stray field into "no save ever works".
   */
  it('every sendable key maps to a field the API accepts', () => {
    const source = fs.readFileSync(HOOK, 'utf-8');
    const list = source.slice(
      source.indexOf('const SENDABLE_PROFILE_KEYS'),
      source.indexOf('export function changedFields'),
    );
    const keys = [...list.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);

    // `emergency*` are the screen's shorthand for the API's `emergencyContact*`.
    const toApiName = (k: string) =>
      k.startsWith('emergency') ? k.replace('emergency', 'emergencyContact') : k;

    for (const key of keys) {
      expect(SELF_EDITABLE_ASSAYER_FIELDS).toContain(toApiName(key));
    }
  });
});
