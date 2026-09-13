import {
  EMPLOYMENT_TERM_FIELD_KEYS, REGISTRATION_RECORD_FIELD_KEYS,
} from '@fapoms/shared';
// `services/api` pulls in the socket client, which reads `import.meta.env` and cannot be parsed
// by jest's CommonJS runtime. Mocked for the same reason `steps.spec.ts` mocks it — nothing below
// makes a request.
jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));

// eslint-disable-next-line import/first
import { REGISTRATION_FIELDS, RATE_KEYS, STEP_FIELDS, REGISTRATION_STEP_KEYS } from './steps';

/**
 * Every box this form draws has somewhere to go.
 *
 * The wizard used to write a live roster row through `POST /assayers`, so it could ask for
 * anything the record has — and it did: an assayer code that is minted at promotion, a joining
 * date that is an employment decision, a VSTS code and a free-text note with no application
 * equivalent at all. It writes an application now, the same row the candidate fills in through
 * their own link, and an application holds its own columns plus one allow-list.
 *
 * A box with nowhere to go is not a small bug. It is a clerk typing something, seeing it saved,
 * and finding it gone from the person it was about — which is the class of defect this whole
 * pipeline was rebuilt to remove. Nothing but this file can notice it: the value is filtered out
 * server-side without complaint, exactly as designed.
 */

/**
 * `assayer_applications`' own columns, in the wizard's vocabulary.
 *
 * Named here rather than derived because the frontend cannot see the entity. `phone` is absent on
 * purpose — it is the record's name for the application's `mobile`, and it is on the registration
 * allow-list, so it is covered by that instead. Source: `assayer-application.entity.ts`.
 */
const APPLICATION_COLUMNS = [
  'fullName', 'email', 'dateOfBirth', 'gender', 'address', 'state', 'city', 'pincode',
  'experienceYears', 'currentEmployer', 'expertise', 'availability', 'employmentCategory',
];

describe('what the registration wizard asks for', () => {
  it.each(REGISTRATION_FIELDS.map((f) => [f.key, f.label]))(
    '%s (%s) is something an application can actually hold',
    (key) => {
      const holdable = (REGISTRATION_RECORD_FIELD_KEYS as readonly string[]).includes(key as string)
        || APPLICATION_COLUMNS.includes(key as string);
      expect(holdable).toBe(true);
    },
  );

  /**
   * Terms are the desk's, and they are asked for at approval — where somebody with the authority
   * to hire is looking at the person, rather than a week earlier at a counter. A candidate must
   * never be able to set their own joining date or workload ceiling by putting one in their form.
   */
  it('asks for no employment term', () => {
    const terms = REGISTRATION_FIELDS
      .map((f) => f.key)
      .filter((k) => (EMPLOYMENT_TERM_FIELD_KEYS as readonly string[]).includes(k));
    expect(terms).toEqual([]);
  });

  it('does not ask for a code that is minted when the record is created', () => {
    expect(REGISTRATION_FIELDS.map((f) => f.key)).not.toContain('assayerCode');
  });

  /**
   * The one box the candidate's form has always had and this one never did. It decides which
   * documents are asked for, and `submit()` refuses without it — so a desk-filled application
   * missing it could be typed in full and then not be submittable by the candidate at all.
   */
  it('asks whether they are a freelancer or a proprietor', () => {
    const field = REGISTRATION_FIELDS.find((f) => f.key === 'employmentCategory');
    expect(field).toBeDefined();
    expect(field!.options?.map((o) => o.value).sort()).toEqual(['FREELANCER', 'PROPRIETOR']);
  });

  it('draws every field it defines, and defines every field it draws', () => {
    // A definition no step renders is a box nobody can fill in; a step naming a key with no
    // definition renders nothing and looks like a missing question. Both have happened here.
    const defined = new Set(REGISTRATION_FIELDS.map((f) => f.key));
    const drawn = new Set(REGISTRATION_STEP_KEYS.flatMap((s) => STEP_FIELDS[s]));
    expect([...drawn].filter((k) => !defined.has(k))).toEqual([]);
    expect([...defined].filter((k) => !drawn.has(k))).toEqual([]);
  });

  it('keeps the pay rates out of the field list — they are not columns on anybody', () => {
    const leaked = REGISTRATION_FIELDS.map((f) => f.key).filter((k) => RATE_KEYS.includes(k));
    expect(leaked).toEqual([]);
  });
});
