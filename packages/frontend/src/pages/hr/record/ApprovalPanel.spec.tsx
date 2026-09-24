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
    fireEvent.click(screen.getByRole('button', { name: 'Approve — send to training' }));

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

  /**
   * 24 SEP 2026: an approver asked HR for more, was shown HR's "Send back for approval" box right
   * beside his own buttons, answered himself — and with the only other approver being the one who
   * sent the person up, nobody could decide. The answer box is HR's side of the round only.
   */
  describe('while HR is asked for more', () => {
    const asked = round({
      status: 'INFO_REQUESTED',
      events: [
        { kind: 'SUBMITTED', byId: 'hr-1', byName: 'Asha Menon', at: '2026-09-23T10:00:00Z', text: 'All checks clear.' },
        { kind: 'INFO_REQUESTED', byId: 'boss-1', byName: 'Rao', at: '2026-09-23T11:00:00Z', text: 'Where is the police certificate?' },
      ],
    });

    it('shows the approver who asked only their decision — no answer box to answer themselves', async () => {
      serve([asked]);
      draw({ currentUserId: 'boss-1', canManage: true, canApprove: true });

      expect(await screen.findByText(/You asked HR for more/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Approve — send to training' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Send back for approval' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Your answer to the approver')).not.toBeInTheDocument();
    });

    it('does not offer another approver the answer box either — they decide, HR answers', async () => {
      serve([asked]);
      draw({ currentUserId: 'boss-2', canManage: true, canApprove: true });

      expect(await screen.findByText(/HR has been asked for more/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send back for approval' })).not.toBeInTheDocument();
    });

    it('gives the answer box to HR', async () => {
      serve([asked]);
      draw({ currentUserId: 'hr-2', canManage: true, canApprove: false });

      expect(await screen.findByLabelText('Your answer to the approver')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send back for approval' })).toBeInTheDocument();
    });

    /** An Admin who sent the person up is on HR's side of this round, so the answer is theirs to give. */
    it('gives it to the admin who sent them up, who may not decide it anyway', async () => {
      serve([asked]);
      draw({ currentUserId: 'hr-1', canManage: true, canApprove: true });

      expect(await screen.findByRole('button', { name: 'Send back for approval' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Approve — send to training' })).not.toBeInTheDocument();
    });
  });

  /**
   * TWO WAYS TO APPROVE (owner, 2026-09-24): "after approving the approver can also send them to
   * training or make them active". Where it sent them is the decision, so it travels with it and
   * is on the round's conversation afterwards.
   */
  describe('approving to training, or straight to work', () => {
    it('sends them to training by the first button, saying so', async () => {
      serve([round()]);
      draw({ activationBlockers: [] });
      fireEvent.click(await screen.findByRole('button', { name: 'Approve — send to training' }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(JSON.parse(posts()[0][1].body)).toEqual({ to: 'TRAINING' });
    });

    it('makes them Active by the second, when nothing activation needs is missing', async () => {
      serve([round()]);
      draw({ activationBlockers: [] });
      fireEvent.click(await screen.findByRole('button', { name: 'Approve — make Active' }));
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0][0]).toBe('/assayers/a-1/approval/approve');
      expect(JSON.parse(posts()[0][1].body)).toEqual({ to: 'ACTIVE' });
    });

    /** A button the server will refuse is a trap; say what is missing instead. */
    it('will not offer Make Active while something it needs is missing, and says what', async () => {
      serve([round()]);
      draw({ activationBlockers: ['Bank account number', 'Home location pinned'] });
      expect(await screen.findByRole('button', { name: 'Approve — make Active' })).toBeDisabled();
      expect(screen.getByTestId('make-active-blockers')).toHaveTextContent('Bank account number, Home location pinned');
      // Training is still there — it does not wait for the bank details.
      expect(screen.getByRole('button', { name: 'Approve — send to training' })).toBeEnabled();
    });

    it('shows where each approval sent them, and training for the ones from before the choice', async () => {
      serve([
        round({ status: 'APPROVED', events: [
          { kind: 'SUBMITTED', byId: 'hr-1', byName: 'Asha', at: '2026-09-24T10:00:00Z', text: null },
          { kind: 'APPROVED', byId: 'boss-2', byName: 'Rao', at: '2026-09-24T11:00:00Z', text: null, to: 'ACTIVE' },
        ] }),
        round({ id: 'r-0', round: 0, status: 'APPROVED', events: [
          { kind: 'APPROVED', byId: 'boss-2', byName: 'Rao', at: '2026-09-20T11:00:00Z', text: null },
        ] }),
      ]);
      draw({ lifecycleStatus: AssayerLifecycleStatus.ACTIVE });
      expect(await screen.findByText(/Approved — now Active — ready for work/)).toBeInTheDocument();
      expect(screen.getByText(/Approved — on to training/)).toBeInTheDocument();
    });
  });
});

