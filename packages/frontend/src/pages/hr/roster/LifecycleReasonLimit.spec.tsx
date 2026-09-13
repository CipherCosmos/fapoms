import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AssayerLifecycleStatus, LIFECYCLE_REASON_MAX_LENGTH } from '@fapoms/shared';

// The modal's type-only import of AssayerRecord drags in the api → session → socket chain, which
// does not load under jest's CommonJS transform. None of it is exercised here.
jest.mock('../../../services/socket', () => ({
  socket: { on: jest.fn(), off: jest.fn() },
  disconnectSocket: jest.fn(),
  useSocketConnection: jest.fn(),
}));
jest.mock('../../../services/api', () => ({ api: { request: jest.fn().mockResolvedValue([]) } }));

import { LifecycleTransitionModal } from './LifecycleTransitionModal';

/**
 * The reason box knowing what the server will accept.
 *
 * `AssayerService.doTransitionLifecycle` rejects a reason longer than
 * LIFECYCLE_REASON_MAX_LENGTH at the authority boundary, and it is right to. The problem was that
 * the number lived in a backend module the frontend could not import, so the box had no limit and
 * no counter: somebody could write several paragraphs justifying a termination, submit, and meet
 * the ceiling for the first time in the rejection.
 *
 * The constant now lives in @fapoms/shared and both ends read the same one, which is what these
 * tests are really pinning — not the value 2000, but that the box is bounded by whatever the
 * server enforces.
 */
const open = (onConfirm = jest.fn().mockResolvedValue(undefined)) =>
  render(
    <LifecycleTransitionModal
      open
      onClose={jest.fn()}
      assayerName="A. Kulkarni"
      assayerCode="AS0007"
      currentStatus={AssayerLifecycleStatus.ACTIVE}
      // TERMINATED is one of the transitions that demands a reason, which is what puts the box on
      // screen at all.
      targetStatus={AssayerLifecycleStatus.TERMINATED}
      onConfirm={onConfirm}
    />,
  );

const reasonBox = () => screen.getByLabelText(/Reason for transition/i) as HTMLTextAreaElement;

describe('the lifecycle reason box', () => {
  it('is bounded by the same limit the server enforces', () => {
    open();

    expect(reasonBox()).toHaveAttribute('maxlength', String(LIFECYCLE_REASON_MAX_LENGTH));
  });

  it('stays quiet for the short reasons that make up almost all of them', () => {
    open();

    fireEvent.change(reasonBox(), { target: { value: 'Repeated no-shows, see case 4471.' } });

    // A counter under every reason box is noise. It has nothing to say until text is actually at
    // risk, so nothing should be on screen here.
    expect(screen.queryByText(/characters left/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Maximum length reached/i)).not.toBeInTheDocument();
  });

  it('starts counting down before anything can be lost', () => {
    open();

    fireEvent.change(reasonBox(), { target: { value: 'x'.repeat(LIFECYCLE_REASON_MAX_LENGTH - 50) } });

    expect(screen.getByText('50 characters left')).toBeInTheDocument();
  });

  it('says so plainly at the ceiling, rather than silently swallowing keystrokes', () => {
    open();

    fireEvent.change(reasonBox(), { target: { value: 'x'.repeat(LIFECYCLE_REASON_MAX_LENGTH) } });

    // The browser stops accepting input here. Without a message, typing simply stops working and
    // nothing on screen explains why — which is its own small mystery to be stuck in.
    expect(screen.getByText(/Maximum length reached/i)).toBeInTheDocument();
  });
});
