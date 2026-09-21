import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MfaPanel, SMS_UNAVAILABLE_NOTE } from './MfaPanel';
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

const status = (over: Partial<MfaStatus> = {}): MfaStatus => ({
  enrolled: false,
  confirmed: false,
  factors: [],
  recoveryCodesRemaining: 0,
  smsAvailable: true,
  ...over,
});

/** The card for one factor: the box around its title that holds exactly one factor's content. */
const card = async (label: string): Promise<HTMLElement> => {
  const title = await screen.findByText(label);
  let node: HTMLElement | null = title;
  // Up to the element whose parent also holds the OTHER factors' titles — that parent is the list.
  while (node?.parentElement && !/Authenticator app[\s\S]*Email code[\s\S]*Text message/.test(node.parentElement.textContent ?? '')) {
    node = node.parentElement;
  }
  return node as HTMLElement;
};

describe('MfaPanel — the text message option', () => {
  beforeEach(() => jest.clearAllMocks());

  /**
   * SMS is built but not configured on this server yet. A "Set up" button here would let a person
   * type their number and only then be refused, so the card says plainly why it cannot be used and
   * points at the two options that work.
   */
  it('shows SMS as unavailable, with a plain reason and no way to start it, when the server has no SMS', async () => {
    getMfaStatus.mockResolvedValue(status({ smsAvailable: false }));
    render(<MfaPanel />);

    const sms = await card('Text message (SMS)');
    expect(within(sms).getByText('Unavailable')).toBeInTheDocument();
    expect(within(sms).getByText(SMS_UNAVAILABLE_NOTE)).toBeInTheDocument();
    expect(within(sms).queryByRole('button', { name: /set up/i })).not.toBeInTheDocument();

    // The other two stay offered.
    expect(within(await card('Authenticator app')).getByRole('button', { name: /set up/i })).toBeInTheDocument();
    expect(within(await card('Email code')).getByRole('button', { name: /set up/i })).toBeInTheDocument();
  });

  it('offers SMS like any other option once the server can send texts', async () => {
    getMfaStatus.mockResolvedValue(status({ smsAvailable: true }));
    render(<MfaPanel />);

    const sms = await card('Text message (SMS)');
    expect(within(sms).getByRole('button', { name: /set up/i })).toBeInTheDocument();
    expect(screen.queryByText(SMS_UNAVAILABLE_NOTE)).not.toBeInTheDocument();
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
  });

  /** Someone who set SMS up before it was switched off must still be able to remove it. */
  it('still lets an existing SMS factor be turned off after SMS stops being available', async () => {
    getMfaStatus.mockResolvedValue(status({ smsAvailable: false, enrolled: true, confirmed: true, factors: ['SMS'] }));
    render(<MfaPanel />);

    const sms = await card('Text message (SMS)');
    expect(within(sms).getByRole('button', { name: /turn off/i })).toBeInTheDocument();
    expect(within(sms).getByText(SMS_UNAVAILABLE_NOTE)).toBeInTheDocument();
  });
});
