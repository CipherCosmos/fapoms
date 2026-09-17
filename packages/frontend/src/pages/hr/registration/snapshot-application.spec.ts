// The hook module imports the API client, which pulls in the socket and its `import.meta`. Nothing
// here makes a request; the mock only keeps the module graph loadable under jest.
jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));

import { snapshotApplication } from './useRegistration';
import { buildApplicationPatch } from './persist';
import { REGISTRATION_FIELDS } from './steps';

/**
 * THE DESK ASKED FOR THE NUMBER IT HAD JUST GIVEN.
 *
 * "Add candidate" takes a mobile number; the application opens with it in `mobile`. The desk's form
 * reads its phone box from `extendedProfile.fields`, which nothing writes when an application is
 * opened — so the form came up asking for a phone number already on file. The candidate's own form
 * has always shown it.
 */
describe('opening an application the desk has just created', () => {
  const view = (over: Record<string, unknown> = {}) => ({
    application: {
      id: 'app-1', fullName: 'Ramesh Iyer', mobile: '9822014455', email: null,
      extendedProfile: null,
      ...over,
    },
    documents: [], gaps: [], documentsRequested: [], invitedMobile: null,
  }) as never;

  it('shows the number they were invited on in the phone box', () => {
    expect(snapshotApplication(view()).phone).toBe('9822014455');
  });

  it('reads it the same way whether it was stored with a country code or not', () => {
    expect(snapshotApplication(view({ mobile: '+919822014455' })).phone).toBe('9822014455');
  });

  /** A phone the desk typed on the form is theirs to keep; the invited number only fills a blank. */
  it('never replaces a phone somebody typed on the form', () => {
    const snap = snapshotApplication(view({ extendedProfile: { fields: { phone: '9000000001' } } }));
    expect(snap.phone).toBe('9000000001');
  });

  it('does not borrow the invited number for the alternate phone', () => {
    expect(snapshotApplication(view()).alternatePhone).toBe('');
  });

  /**
   * DISPLAY ONLY. The snapshot is what the form treats as already saved as well as what it shows,
   * so an untouched box is not a change and is never sent. That keeps the deliberate rule in
   * `persist.ts` intact: `record.phone` must not overwrite the `mobile` column.
   */
  it('sends nothing unless somebody changes the box', () => {
    const snap = snapshotApplication(view());
    const { body } = buildApplicationPatch(REGISTRATION_FIELDS, snap, snap);
    expect(body).toBeNull();
  });
});
