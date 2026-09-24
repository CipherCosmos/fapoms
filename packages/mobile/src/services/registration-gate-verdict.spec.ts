import { registrationGateVerdict } from './registration-gate-verdict';

/**
 * The forced registration checklist used to stay up for the rest of the session once raised, so
 * a new joiner HR had approved was still trapped on it. The app now asks a gated route and lowers
 * the checklist only on the server's own "you're through".
 */
describe('registrationGateVerdict', () => {
  it('a gated route answering normally means the person has been let through', () => {
    expect(registrationGateVerdict(200)).toBe('released');
    expect(registrationGateVerdict(204)).toBe('released');
  });

  it('the registration refusal means still registering', () => {
    expect(registrationGateVerdict(403, 'REGISTRATION_IN_PROGRESS')).toBe('in-progress');
  });

  it('anything else decides nothing — no signal must never release or trap anybody', () => {
    expect(registrationGateVerdict(0)).toBe('unknown');
    expect(registrationGateVerdict(500)).toBe('unknown');
    expect(registrationGateVerdict(401)).toBe('unknown');
    // The password gate is checked first on the server, so it hides the registration answer.
    expect(registrationGateVerdict(403, 'PASSWORD_CHANGE_REQUIRED')).toBe('unknown');
    expect(registrationGateVerdict(403)).toBe('unknown');
  });
});
