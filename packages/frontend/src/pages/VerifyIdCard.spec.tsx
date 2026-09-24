import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VerifyIdCard } from './VerifyIdCard';
import * as idCardApi from '../services/public-id-card';

/**
 * The public ID card check (owner, 2026-09-23) — what a bank branch sees when it scans the live QR
 * or types the ID number and code. No sign-in; the answer is the record as it is now.
 */
jest.mock('../services/public-id-card');
const mocked = idCardApi as jest.Mocked<typeof idCardApi>;

const valid = {
  result: 'VALID' as const, message: 'This ID card is valid, and they are cleared for audit work.',
  fullName: 'Ramesh Kulkarni', assayerCode: 'AS0009', jobTitle: 'Gold Appraiser', organisation: 'Sumeru Global',
  validTill: '2026-12-31T00:00:00.000Z', clearedForNewWork: true, photoUrl: '/api/v1/public/id-card/photo/x', checkedAt: '2026-09-23T10:00:00Z',
};

beforeEach(() => jest.clearAllMocks());

describe('checking an ID card', () => {
  it('checks a scanned QR straight away, and shows the face to match', async () => {
    mocked.verifyIdCardToken.mockResolvedValue(valid);
    render(<VerifyIdCard token="tok" />);

    expect(await screen.findByText('Valid ID card')).toBeInTheDocument();
    expect(mocked.verifyIdCardToken).toHaveBeenCalledWith('tok');
    expect(screen.getByAltText('Photograph of Ramesh Kulkarni')).toHaveAttribute('src', valid.photoUrl);
    expect(screen.getByText('✓ Cleared for audit work')).toBeInTheDocument();
  });

  it('says plainly when a card is not valid', async () => {
    mocked.verifyIdCardToken.mockResolvedValue({ ...valid, result: 'NOT_VALID', message: 'This ID card is NOT valid. They are not currently an active appraiser with us.' });
    render(<VerifyIdCard token="tok" />);
    expect(await screen.findByText('NOT a valid ID card')).toBeInTheDocument();
    expect(screen.queryByText(/Cleared for audit work/)).not.toBeInTheDocument();
  });

  it('checks by the ID number and the 6 digits typed from the card', async () => {
    mocked.verifyIdCardCode.mockResolvedValue(valid);
    render(<VerifyIdCard />);

    fireEvent.change(screen.getByPlaceholderText('e.g. AS0012'), { target: { value: 'as0009' } });
    fireEvent.change(screen.getByPlaceholderText('••••••'), { target: { value: '12a3456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));

    await waitFor(() => expect(mocked.verifyIdCardCode).toHaveBeenCalledWith('AS0009', '123456'));
    expect(await screen.findByText('Valid ID card')).toBeInTheDocument();
  });

  it('asks for both before checking', async () => {
    render(<VerifyIdCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/ID number and the 6-digit code/);
    expect(mocked.verifyIdCardCode).not.toHaveBeenCalled();
  });
});
