import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotificationCategory } from '@fapoms/shared';
import Notifications from './Notifications';
import { api } from '../services/api';

/**
 * The per-person SMS switch on the Notification Center's Preferences tab.
 *
 * A text lands on a personal phone, so the person needs a switch for it the moment an administrator
 * switches SMS on for any event — and that switch must follow the same rules as the three beside
 * it: on unless they turned it off (including against a server that does not report it yet), saved
 * on its own key so it can never flip another channel, and put back if the save fails.
 */

jest.mock('../services/api', () => {
  const actual = jest.requireActual('../services/api');
  return {
    ...actual,
    api: {
      getNotificationPreferences: jest.fn(),
      setNotificationPreference: jest.fn(),
      getUnreadNotificationCount: jest.fn(),
      getNotificationPage: jest.fn(),
    },
  };
});
jest.mock('../services/socket', () => ({ connectSocket: () => null, getSocket: () => null }));

const mockApi = api as unknown as Record<string, jest.Mock>;

const pref = (category: string, over: Record<string, boolean> = {}) => ({
  category, inApp: true, push: true, email: true, sms: true, ...over,
});

const renderPreferences = () => render(
  <MemoryRouter initialEntries={['/notifications?tab=preferences']}>
    <Notifications />
  </MemoryRouter>,
);

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getUnreadNotificationCount.mockResolvedValue(0);
  mockApi.setNotificationPreference.mockResolvedValue({});
  mockApi.getNotificationPreferences.mockResolvedValue(
    Object.values(NotificationCategory).map((c) => pref(c, c === NotificationCategory.ASSIGNMENT ? { sms: false } : {})),
  );
});

describe('Notification preferences — the SMS column', () => {
  it('shows an SMS switch for every category, reflecting what was saved', async () => {
    renderPreferences();

    expect(await screen.findByText('SMS')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'SMS for Assignments' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'SMS for Billing' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByRole('switch', { name: /^SMS for / })).toHaveLength(Object.values(NotificationCategory).length);
  });

  it('reads a category the server did not report SMS for as on — absence means opted in', async () => {
    mockApi.getNotificationPreferences.mockResolvedValue([
      { category: NotificationCategory.BILLING, inApp: true, push: true, email: true },
    ]);
    renderPreferences();

    expect(await screen.findByRole('switch', { name: 'SMS for Billing' })).toHaveAttribute('aria-checked', 'true');
  });

  it('saves the SMS switch on its own key, touching no other channel', async () => {
    renderPreferences();

    fireEvent.click(await screen.findByRole('switch', { name: 'SMS for Billing' }));

    await waitFor(() => expect(mockApi.setNotificationPreference)
      .toHaveBeenCalledWith(NotificationCategory.BILLING, { sms: false }));
    expect(screen.getByRole('switch', { name: 'SMS for Billing' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Email for Billing' })).toHaveAttribute('aria-checked', 'true');
  });

  it('puts the switch back when the save fails, so it never shows a choice that was not kept', async () => {
    mockApi.setNotificationPreference.mockRejectedValue(new Error('network down'));
    renderPreferences();

    fireEvent.click(await screen.findByRole('switch', { name: 'SMS for Billing' }));

    await waitFor(() => expect(screen.getByRole('switch', { name: 'SMS for Billing' })).toHaveAttribute('aria-checked', 'true'));
  });
});
