import { issueRegistrationScanLink, registrationScanLinkIsValid, REGISTRATION_SCAN_LINK_TTL_SECONDS } from './registration-scan-link';

/**
 * 2026-09-24: registration scans are locked behind the session code (x-registration-session). A PDF
 * opened in the phone's viewer cannot send that header, so an unlocked caller gets a two-minute
 * link for exactly one page.
 */
describe('registration scan links', () => {
  const OLD = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-scan-links-0123456789'; });
  afterAll(() => { process.env.JWT_SECRET = OLD; });
  const now = 1_800_000_000;

  it('opens the page it was issued for, until it expires', () => {
    const link = issueRegistrationScanLink('invite-A', 'PAN_CARD', 0, now);
    expect(registrationScanLinkIsValid(link, 'invite-A', 'PAN_CARD', 0, now + 10)).toBe(true);
    expect(registrationScanLinkIsValid(link, 'invite-A', 'PAN_CARD', 0, now + REGISTRATION_SCAN_LINK_TTL_SECONDS + 1)).toBe(false);
  });

  it('opens nothing else: another invite, requirement or page', () => {
    const link = issueRegistrationScanLink('invite-A', 'PAN_CARD', 0, now);
    expect(registrationScanLinkIsValid(link, 'invite-B', 'PAN_CARD', 0, now)).toBe(false);
    expect(registrationScanLinkIsValid(link, 'invite-A', 'AADHAAR_CARD', 0, now)).toBe(false);
    expect(registrationScanLinkIsValid(link, 'invite-A', 'PAN_CARD', 1, now)).toBe(false);
  });

  it('refuses a missing, malformed or tampered link', () => {
    const link = issueRegistrationScanLink('invite-A', 'PAN_CARD', 0, now);
    const [exp] = link.split('.');
    expect(registrationScanLinkIsValid(undefined, 'invite-A', 'PAN_CARD', 0, now)).toBe(false);
    expect(registrationScanLinkIsValid('garbage', 'invite-A', 'PAN_CARD', 0, now)).toBe(false);
    expect(registrationScanLinkIsValid(`${Number(exp) + 3600}.${link.split('.')[1]}`, 'invite-A', 'PAN_CARD', 0, now)).toBe(false);
  });
});
