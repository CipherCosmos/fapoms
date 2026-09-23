import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AssayerLifecycleStatus } from '@fapoms/shared';
import { ApprovalPanel } from './ApprovalPanel';
import { api } from '../../../services/api';

/**
 * THE APPROVAL BEFORE TRAINING, on screen (owner, 2026-09-23): the approver approves, rejects with a
 * reason or asks HR for more; HR answers; the person who sent it up cannot decide it.
 */
jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

const round = (over: Record<string, unknown> = {}) => ({
  id: 'r-1', round: 1, status: 'PENDING', decidedAt: null, preparers: ['hr-1'],
  events: [{ kind: 'SUBMITTED', byId: 'hr-1', byName: 'Asha Menon', at: '2026-09-23T10:00:00Z', text: 'All checks clear.' }],
  ...over,
});
const serve = (rounds: unknown[]) => mockRequest.mockImplementation(async (url: string) => (url.endsWith('/approval') ? rounds : {}));
const draw = (props: Partial<React.ComponentProps<typeof ApprovalPanel>> = {}) => {
  const onChanged = jest.fn();
  render(<ApprovalPanel assayerId="a-1" lifecycleStatus={AssayerLifecycleStatus.FINAL_APPROVAL}
    canManage canApprove currentUserId="boss-1" onChanged={onChanged} {...props} />);
  return { onChanged };
};
const posts = () => mockRequest.mock.calls.filter(([, o]) => o?.method === 'POST');

beforeEach(() => mockRequest.mockReset());

describe('the approval panel', () => {
  it('shows what HR sent up, and lets the approver approve', async () => {
    serve([round()]);
    const { onChanged } = draw();

    expect(await screen.findByText('All checks clear.')).toBeInTheDocument();
    expect(screen.getByText(/Asha Menon/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve — on to training' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe('/assayers/a-1/approval/approve');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('will not reject without a reason, and sends the reason when there is one', async () => {
    serve([round()]);
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Say why/);
    expect(posts()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Your note/), { target: { value: 'Experience could not be confirmed with either employer.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe('/assayers/a-1/approval/reject');
    expect(JSON.parse(posts()[0][1].body)).toEqual({ text: 'Experience could not be confirmed with either employer.' });
  });

  it('tells the person who sent it up that somebody else decides it — and offers no buttons', async () => {
    serve([round()]);
    draw({ currentUserId: 'hr-1' });
    expect(await screen.findByText(/somebody else has to decide it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
  });

  it('lets HR answer what the approver asked, and sends it back', async () => {
    serve([round({
      status: 'INFO_REQUESTED',
      events: [...round().events, { kind: 'INFO_REQUESTED', byId: 'boss-1', byName: 'Rao', at: '2026-09-23T11:00:00Z', text: 'Upload the relieving letter.' }],
    })]);
    draw({ canApprove: false, currentUserId: 'hr-1' });

    expect(await screen.findByText('Upload the relieving letter.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your answer to the approver'), { target: { value: 'Uploaded to Documents as the experience letter.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send back for approval' }));
    await waitFor(() => expect(posts()[0][0]).toBe('/assayers/a-1/approval/answer'));
  });

  it('keeps earlier rounds underneath — a rejection that was re-opened stays on file', async () => {
    serve([
      round({ id: 'r-2', round: 2 }),
      round({ status: 'REJECTED', events: [...round().events, { kind: 'REJECTED', byId: 'boss-1', byName: 'Rao', at: '2026-09-20T10:00:00Z', text: 'Reference unreachable.' }] }),
    ]);
    draw();
    expect(await screen.findByText(/round 2/)).toBeInTheDocument();
    expect(screen.getByText('Earlier round')).toBeInTheDocument();
    expect(screen.getByText('Reference unreachable.')).toBeInTheDocument();
  });

  it('renders nothing for somebody never sent up', async () => {
    serve([]);
    const { container } = render(<ApprovalPanel assayerId="a-1" canManage canApprove currentUserId="x" onChanged={jest.fn()} />);
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
