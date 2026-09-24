import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MfaPanel } from './MfaPanel';
import * as mfa from '../../services/mfa';
import type { MfaStatus } from '../../services/mfa';

jest.mock('../../services/mfa', () => ({
  getMfaStatus: jest.fn(),
  enrolTotp: jest.fn(),
  confirmTotp: jest.fn(),
  enrolEmail: jest.fn(),
  confirmEmail: jest.fn(),
  enrolSms: jest.fn(),
  confirmSms: jest.fn(),
  disableMfa: jest.fn(),
  regenerateRecoveryCodes: jest.fn(),
}));

const getMfaStatus = jest.mocked(mfa.getMfaStatus);
const disableMfa = jest.mocked(mfa.disableMfa);
const regenerateRecoveryCodes = jest.mocked(mfa.regenerateRecoveryCodes);

const status = (over: Partial<MfaStatus> = {}): MfaStatus => ({
  enrolled: true, confirmed: true, factors: ['TOTP'], recoveryCodesRemaining: 8, smsAvailable: true, ...over,
});

/**
 * The server now refuses to turn a factor off or replace the recovery codes on a session alone — it
 * wants the current password or a fresh authenticator code. The panel has to ask for one, and must
 * not send the request until something has been typed.
 */
describe('MfaPanel — confirming it is you before weakening the account', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getMfaStatus.mockResolvedValue(status());
  });

  it('asks for the password before turning a factor off, and sends it with the request', async () => {
    disableMfa.mockResolvedValue({ message: 'TOTP factor removed.' });
    render(<MfaPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /turn off/i }));
    const dialog = (await screen.findByText(/to confirm it is you/i)).closest('form') as HTMLElement;
    const submit = within(dialog).getByRole('button', { name: /^turn off$/i });
    expect(submit).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/current password/i), { target: { value: 'my-password-1' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(disableMfa).toHaveBeenCalledWith('TOTP', { currentPassword: 'my-password-1' }));
  });

  it('keeps the dialog open with the reason when the server refuses the proof', async () => {
    disableMfa.mockRejectedValue(new Error('That password or code is not right.'));
    render(<MfaPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /turn off/i }));
    const dialog = (await screen.findByText(/to confirm it is you/i)).closest('form') as HTMLElement;
    fireEvent.change(within(dialog).getByLabelText(/authenticator code/i), { target: { value: '123456' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^turn off$/i }));

    await waitFor(() => expect(disableMfa).toHaveBeenCalledWith('TOTP', { code: '123456' }));
    expect(await screen.findByText(/to confirm it is you/i)).toBeInTheDocument();
  });

  it('asks for proof before regenerating recovery codes', async () => {
    regenerateRecoveryCodes.mockResolvedValue({ recoveryCodes: ['AAAA-BBBB'] });
    render(<MfaPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /regenerate recovery codes/i }));
    expect(regenerateRecoveryCodes).not.toHaveBeenCalled();
    const dialog = (await screen.findByText(/to confirm it is you/i)).closest('form') as HTMLElement;
    fireEvent.change(within(dialog).getByLabelText(/current password/i), { target: { value: 'my-password-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /generate new codes/i }));

    await waitFor(() => expect(regenerateRecoveryCodes).toHaveBeenCalledWith({ currentPassword: 'my-password-1' }));
    expect(await screen.findByText('AAAA-BBBB')).toBeInTheDocument();
  });
});
