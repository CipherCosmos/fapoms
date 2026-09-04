import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RuleBypassPanel } from './RuleBypassPanel';
import { api } from '../../services/api';
import { BypassableRule, INACTIVE_BYPASS, DEFAULT_BYPASS_HOURS } from '@fapoms/shared';

/**
 * The bypass reason field: a preset+autocomplete hybrid, not a preset+Other lock like the other
 * three tasks. A bypass reason is written prose ("Testing the mobile check-in flow before the
 * RBL pilot" is the field's own placeholder example), so this is a plain, always-free-typeable
 * input backed by a native `<datalist>` — fixed categories plus real reasons pulled from
 * `GET /admin/rule-bypass/history`, which this screen did not call before this change.
 *
 * These tests prove two things: the suggestions genuinely come from both sources (deduplicated),
 * and whichever text ends up in the field — a suggestion or something typed from scratch — is
 * exactly what reaches the enable request, never swapped or truncated.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../hooks/useCurrentRoles', () => ({
  useCurrentRoles: () => ['ADMIN'],
  useCurrentPermissions: () => ['configuration:view:platform', 'configuration:edit:platform'],
}));
jest.mock('../../config/route-permissions', () => ({ canAccessRoute: () => true }));
jest.mock('../../components/ui', () => {
  const actual = jest.requireActual('../../components/ui');
  // The confirmation dialog before a suspend is real UI this screen relies on for its own
  // friction, but it is not what this suite is testing — auto-confirming keeps the tests aimed
  // at the reason field.
  return { ...actual, useConfirm: () => ({ confirm: jest.fn().mockResolvedValue(true), confirmDialog: null }) };
});

const mockRequest = api.request as jest.Mock;

const RULE_LABEL = 'Test rule A';
const catalogue = {
  rules: [
    { rule: BypassableRule.CHECK_IN_GEOFENCE, label: RULE_LABEL, blocks: 'blocks a thing', protects: 'protects a thing', evidential: false },
  ],
  defaultHours: DEFAULT_BYPASS_HOURS,
};

// One past window whose reason duplicates a fixed category verbatim (must not appear twice in
// the suggestions) and one with a genuinely new reason (must appear at all).
const history = [
  { reason: 'Client escalation / one-off exception' },
  { reason: 'Recharging the field-team demo before the client walkthrough' },
];

const renderPanel = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><RuleBypassPanel /></QueryClientProvider>);
};

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockImplementation((url: string, options?: { method?: string }) => {
    if (url === '/admin/rule-bypass' && options?.method === 'POST') {
      return Promise.resolve({ ...INACTIVE_BYPASS, active: true });
    }
    if (url === '/admin/rule-bypass') return Promise.resolve(INACTIVE_BYPASS);
    if (url === '/admin/rule-bypass/catalogue') return Promise.resolve(catalogue);
    if (url.startsWith('/admin/rule-bypass/history')) return Promise.resolve(history);
    return Promise.resolve(undefined);
  });
});

/** Ticks the one fixture rule and types a reason, leaving hours at the default. */
const fillReasonAndSelectRule = async (reasonText: string) => {
  renderPanel();
  await waitFor(() => expect(screen.getByText(RULE_LABEL)).toBeInTheDocument());
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(
    screen.getByPlaceholderText('e.g. Testing the mobile check-in flow before the RBL pilot'),
    { target: { value: reasonText } },
  );
};

describe('RuleBypassPanel — bypass reason', () => {
  it('sends the exact text of a chosen suggestion, unchanged', async () => {
    await fillReasonAndSelectRule('System or connectivity outage');
    fireEvent.click(screen.getByRole('button', { name: /Suspend 1 rule for/ }));

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('/admin/rule-bypass', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ rules: [BypassableRule.CHECK_IN_GEOFENCE], reason: 'System or connectivity outage', hours: DEFAULT_BYPASS_HOURS }),
      })));
  });

  it('sends the exact free text typed from scratch, not a suggestion', async () => {
    const freeText = 'Ad-hoc test the ops lead asked for over chat this morning.';
    await fillReasonAndSelectRule(freeText);
    fireEvent.click(screen.getByRole('button', { name: /Suspend 1 rule for/ }));

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('/admin/rule-bypass', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ rules: [BypassableRule.CHECK_IN_GEOFENCE], reason: freeText, hours: DEFAULT_BYPASS_HOURS }),
      })));
  });

  it('stays fully free-typeable: an arbitrary reason no suggestion covers still enables submit', async () => {
    await fillReasonAndSelectRule('Something nobody has ever typed here before, quite long.');
    const submit = screen.getByRole('button', { name: /Suspend 1 rule for/ });
    expect(submit).not.toBeDisabled();
  });

  it('offers the fixed categories and real past reasons as suggestions, deduplicated', async () => {
    renderPanel();
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.stringContaining('/admin/rule-bypass/history')));

    const datalist = await waitFor(() => {
      const el = document.getElementById('rule-bypass-reason-suggestions') as HTMLDataListElement | null;
      if (!el || el.querySelectorAll('option').length === 0) throw new Error('datalist not populated yet');
      return el;
    });
    const values = Array.from(datalist.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);

    // A real historical reason not among the fixed categories is present…
    expect(values).toContain('Recharging the field-team demo before the client walkthrough');
    // …and a historical reason that duplicates a fixed category verbatim is not offered twice.
    expect(values.filter((v) => v === 'Client escalation / one-off exception')).toHaveLength(1);
  });
});
