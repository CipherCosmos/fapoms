import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { SensitiveValue } from './SensitiveValue';
import { maskedIdentifier, looksLikeMask } from './assayer-shared';
import { api } from '../../services/api';

/**
 * Covered by default, uncovered on purpose, and the uncovering said out loud.
 *
 * PAN, Aadhaar and bank account arrive from `GET /assayers/:id` last-4 masked, and the whole
 * number is behind `GET /assayers/:id/sensitive/:field`, which writes an audit event naming who
 * asked. What these hold is the half that is easy to get wrong: the warning has to be on screen
 * BEFORE the click, not only after it. A reveal control whose consequence is invisible collects a
 * log of people who did not know they were being logged — which serves neither the clerk nor the
 * person whose record it is, and is worse than having no control at all.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));

const mockRequest = api.request as jest.Mock;

beforeEach(() => mockRequest.mockReset());

const renderIt = (over: Partial<React.ComponentProps<typeof SensitiveValue>> = {}) => render(
  <SensitiveValue
    assayerId="a-1"
    fieldKey="aadhaarNumber"
    masked="******9012"
    canReveal
    {...over}
  />,
);

describe('a covered identifier', () => {
  it('shows the mask, never the number, and offers to uncover it', () => {
    renderIt();
    expect(screen.getByText('******9012')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show the whole Aadhaar number/ })).toBeInTheDocument();
  });

  it('says the reveal is recorded BEFORE anyone presses it', () => {
    renderIt();
    // Not a tooltip, not a hover, not a dialog somebody learns to click through: plain text
    // beside the button, in the ordinary flow of the page.
    expect(screen.getByText(/recorded in the audit log, with your name and the time/)).toBeInTheDocument();
  });

  it('asks the audited endpoint for the right field and prints what comes back', async () => {
    mockRequest.mockResolvedValue({ value: '123456789012' });
    renderIt();

    fireEvent.click(screen.getByRole('button', { name: /Show the whole Aadhaar number/ }));

    await waitFor(() => expect(screen.getByText('123456789012')).toBeInTheDocument());
    expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/sensitive/aadhaar');
  });

  it('confirms afterwards that it was recorded, and does not pretend hiding undoes it', async () => {
    mockRequest.mockResolvedValue({ value: '123456789012' });
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: /Show the whole Aadhaar number/ }));

    await waitFor(() => expect(screen.getByText(/Your name and the time are now in the audit log/)).toBeInTheDocument());
    // "Cover it again", not "undo" — the audit row is written and cannot be taken back.
    fireEvent.click(screen.getByRole('button', { name: /Cover it again/ }));
    expect(screen.getByText('******9012')).toBeInTheDocument();
    expect(screen.queryByText('123456789012')).not.toBeInTheDocument();
  });

  it('maps each field to its own route segment', async () => {
    mockRequest.mockResolvedValue({ value: 'ABCDE1234F' });
    renderIt({ fieldKey: 'panNumber', masked: '******234F' });
    fireEvent.click(screen.getByRole('button', { name: /Show the whole PAN/ }));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/assayers/a-1/sensitive/pan'));
  });

  it('offers nothing to a reader who is not entitled, and says why', () => {
    renderIt({ canReveal: false });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/Only HR and administrators/)).toBeInTheDocument();
  });

  it('says so when the reveal fails, instead of leaving the button spinning', async () => {
    mockRequest.mockRejectedValue(new Error('nope'));
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: /Show the whole Aadhaar number/ }));
    await waitFor(() => expect(screen.getByText(/Could not show the Aadhaar number/)).toBeInTheDocument());
    // The mask is still there — a failed reveal must not blank the field.
    expect(screen.getByText('******9012')).toBeInTheDocument();
  });

  it('has nothing to offer on a field with nothing on file', () => {
    renderIt({ masked: null });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('hands the real value to the caller so a box can be edited from it, not from the mask', async () => {
    mockRequest.mockResolvedValue({ value: '123456789012' });
    const onRevealed = jest.fn();
    renderIt({ onRevealed, renderRevealed: () => <input aria-label="Aadhaar" /> });

    fireEvent.click(screen.getByRole('button', { name: /Show the whole Aadhaar number/ }));

    await waitFor(() => expect(onRevealed).toHaveBeenCalledWith('123456789012'));
    // Reveal-then-edit: the box only exists once the number has been uncovered.
    expect(screen.getByLabelText('Aadhaar')).toBeInTheDocument();
  });
});

describe('the display-side mask', () => {
  /**
   * The server masks these on the way out, so on a healthy stack this passes its answer through.
   * It masks anyway when handed something unmasked, and that is the point rather than caution:
   * this function is the screen's own promise that it does not print a whole Aadhaar. A cached
   * payload from before the change, or a fixture in a test, would otherwise put a complete KYC
   * identifier on a screen a colleague can read over somebody's shoulder.
   */
  it('passes an already-masked value straight through', () => {
    expect(maskedIdentifier('******234F')).toBe('******234F');
  });

  it('masks anything that arrives whole, keeping the last four', () => {
    expect(maskedIdentifier('ABCDE1234F')).toBe('••••••234F');
    expect(maskedIdentifier('123456789012')).toBe('••••••••9012');
  });

  it('is nothing at all for a blank field, rather than a row of dots', () => {
    expect(maskedIdentifier(null)).toBeNull();
    expect(maskedIdentifier('   ')).toBeNull();
  });

  it('never covers fewer than four characters, however short the value', () => {
    expect(maskedIdentifier('7')).toBe('••••7');
  });

  it('recognises both the server\'s asterisks and this screen\'s bullets as a mask', () => {
    expect(looksLikeMask('******234F')).toBe(true);
    expect(looksLikeMask('••••••234F')).toBe(true);
    expect(looksLikeMask('ABCDE1234F')).toBe(false);
  });

  /**
   * The check has to answer the way the server answers, not merely in the same spirit.
   *
   * This side used to want three or more covering characters and the server wants one, so the
   * server's own mask of a five- or six-character value slipped through the gap between them: the
   * form posted `*2345` back as the new account number, the server refused it, and the clerk was
   * shown a 400 about a field they had never opened. Short values are not exotic — bank account
   * and document numbers reach these boxes at any length. It is one function now, imported from
   * `@fapoms/shared`, and this is the case that proves which one.
   */
  it('recognises the short masks the server actually emits', () => {
    expect(looksLikeMask('*2345')).toBe(true);
    expect(looksLikeMask('**3456')).toBe(true);
    expect(looksLikeMask('****')).toBe(true);
    expect(looksLikeMask('•2345')).toBe(true);
  });

  it('still never mistakes a real identifier for a mask', () => {
    for (const real of ['ABCDE1234F', '123456789012', 'HDFC0000001', '12345', 'X-7']) {
      expect(looksLikeMask(real)).toBe(false);
    }
  });
});
