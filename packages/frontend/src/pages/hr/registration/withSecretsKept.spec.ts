import { withSecretsKept } from './useRegistration';

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));

/** A masked identity number, or Replace's blank, never goes back as the number. */
describe('withSecretsKept', () => {
  const saved = { panNumber: '••••••234F', aadhaarNumber: '', bankAccountNumber: '********6789', fullName: 'R' };

  it('keeps the saved value for an untouched mask and for a Replace left blank', () => {
    const out = withSecretsKept({ ...saved, panNumber: '', bankAccountNumber: '********6789' }, saved);
    expect(out.panNumber).toBe(saved.panNumber);
    expect(out.bankAccountNumber).toBe(saved.bankAccountNumber);
  });

  it('lets a newly typed number through', () => {
    expect(withSecretsKept({ ...saved, panNumber: 'ABCDE1234F' }, saved).panNumber).toBe('ABCDE1234F');
  });

  it('leaves a field with nothing on file alone — clearing it is a real clear', () => {
    expect(withSecretsKept({ ...saved, aadhaarNumber: '' }, { ...saved, aadhaarNumber: '' }).aadhaarNumber).toBe('');
  });
});
