import { readFileSync } from 'fs';
import { join } from 'path';
import { ASSAYER_RECORD_FIELDS, CRITICAL_ASSAYER_RECORD_FIELDS, missingAssayerRecordFields } from '@fapoms/shared';

/**
 * The roster and the paperwork page count the same people.
 *
 * "Which fields does a record need" was written down twice: `CRITICAL_FIELDS` in the web app
 * and `RECORD_FIELDS` in this service's SQL. They disagreed about the phone number — the web
 * app called a missing one an incomplete record and the server did not — so the roster's
 * "Incomplete record" filter and the paperwork page's incomplete list named different people.
 * And they disagreed exactly where it mattered: the client rosters this system imports have no
 * phone column at all, which is the whole reason a missing phone stopped blocking admission.
 *
 * One list now. These pin the properties that let both sides use it: every field needs a SQL
 * column for the aggregate here and a camelCase key for the record the API returns, and the two
 * have to name the same thing.
 */
describe('the assayer record fields', () => {
  it('gives every field both a column for SQL and a key for the API record', () => {
    for (const field of ASSAYER_RECORD_FIELDS) {
      expect(field.column).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(field.key).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.blocks.length).toBeGreaterThan(0);
    }
  });

  it('names the same thing in both spellings', () => {
    for (const field of ASSAYER_RECORD_FIELDS) {
      const fromColumn = field.column.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      expect(fromColumn).toBe(field.key);
    }
  });

  it('counts the phone as critical, which is the disagreement that started this', () => {
    expect(CRITICAL_ASSAYER_RECORD_FIELDS.map((f) => f.key)).toContain('phone');
  });

  it('treats blank, whitespace and absent the same way the SQL does', () => {
    // The SQL test is `IS NULL OR ::text = ''`; this is its counterpart for a loaded record.
    const missing = missingAssayerRecordFields({
      phone: '   ', panNumber: '', bankAccountNumber: null,
      ifscCode: 'HDFC0000123', joiningDate: '2024-01-01', emergencyContactPhone: '+919000000000',
      latitude: 19.076,
    });
    expect(missing.map((f) => f.key).sort()).toEqual(['bankAccountNumber', 'panNumber', 'phone']);
  });

  /**
   * Coordinates are a critical field, and the reason is not tidiness.
   *
   * `recommendation.engine.ts` returns `true` from its distance check when either side has no
   * coordinates, so a candidate four states from the branch passes the "near enough" filter
   * instead of being excluded by it. 1,155 of the 1,163 imported records had none — the bulk
   * importer writes entities straight through the transaction manager, skipping the geocoding
   * that create() and update() perform — and nothing on any screen said so.
   */
  it('flags a record with no coordinates, because the planner cannot filter on distance without them', () => {
    const withoutCoordinates = {
      phone: '+919000000000', panNumber: 'ABCDE1234F', bankAccountNumber: '123',
      ifscCode: 'HDFC0000123', joiningDate: '2024-01-01', emergencyContactPhone: '+919000000001',
    };
    expect(missingAssayerRecordFields(withoutCoordinates).map((f) => f.key)).toEqual(['latitude']);
  });

  it('counts a latitude of zero as present, not blank', () => {
    // `0` is falsy and `''` is blank; only one of them means "nobody recorded this".
    expect(missingAssayerRecordFields({ latitude: 0 }).map((f) => f.key)).not.toContain('latitude');
  });

  it('reports nothing missing for a complete record, and everything for an empty one', () => {
    const complete: Record<string, string> = {};
    for (const f of CRITICAL_ASSAYER_RECORD_FIELDS) complete[f.key] = 'set';
    expect(missingAssayerRecordFields(complete)).toEqual([]);
    expect(missingAssayerRecordFields({})).toHaveLength(CRITICAL_ASSAYER_RECORD_FIELDS.length);
  });

  it('is the only list — neither side keeps a private copy any more', () => {
    const service = readFileSync(join(__dirname, 'hr-workforce.service.ts'), 'utf8');
    // A literal array of `{ column: '...' }` here would be the second list growing back.
    expect(service).not.toMatch(/const RECORD_FIELDS:\s*\{/);
    expect(service).toContain('ASSAYER_RECORD_FIELDS');
  });
});
