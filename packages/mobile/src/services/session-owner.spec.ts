import { claimQueuedWorkFor, decideQueueClaim, type QueueOwnerDeps } from './session-owner';

function deps(previous: string | null) {
  const calls: string[] = [];
  const d: QueueOwnerDeps = {
    readOwner: jest.fn(async () => previous),
    writeOwner: jest.fn(async (id: string) => { calls.push(`write:${id}`); }),
    clearQueues: jest.fn(async () => { calls.push('clear'); }),
    adoptUnowned: jest.fn(async (id: string) => { calls.push(`adopt:${id}`); }),
    setOwner: jest.fn((id: string | null) => { calls.push(`owner:${id}`); }),
  };
  return { d, calls };
}

describe('decideQueueClaim', () => {
  it("somebody else's queued work is cleared, whichever way the session started", () => {
    expect(decideQueueClaim('A', 'B', 'signed-in')).toBe('cleared');
    expect(decideQueueClaim('A', 'B', 'restored')).toBe('cleared');
  });

  it('the same person keeps their own unsent work', () => {
    expect(decideQueueClaim('A', 'A', 'signed-in')).toBe('kept');
    expect(decideQueueClaim('A', 'A', 'restored')).toBe('kept');
  });

  it('with no record, only a restored session adopts what is on the phone', () => {
    expect(decideQueueClaim(null, 'A', 'restored')).toBe('adopted');
    expect(decideQueueClaim(null, 'A', 'signed-in')).toBe('kept');
  });
});

describe('claimQueuedWorkFor', () => {
  /**
   * A session can end without a sign-out (the server revoking it), which leaves the previous
   * person's queues on the phone. The next person to sign in must not send them.
   */
  it('clears before recording the new owner, so nothing drains in between', async () => {
    const { d, calls } = deps('A');
    expect(await claimQueuedWorkFor('B', 'signed-in', d)).toBe('cleared');
    expect(calls).toEqual(['clear', 'write:B', 'owner:B']);
  });

  it('keeps and re-records for the same person', async () => {
    const { d, calls } = deps('A');
    expect(await claimQueuedWorkFor('A', 'signed-in', d)).toBe('kept');
    expect(calls).toEqual(['write:A', 'owner:A']);
  });

  it('adopts legacy entries on the first restored launch of this build', async () => {
    const { d, calls } = deps(null);
    expect(await claimQueuedWorkFor('A', 'restored', d)).toBe('adopted');
    expect(calls).toEqual(['adopt:A', 'write:A', 'owner:A']);
  });

  it('an unreadable record is treated as no record', async () => {
    const { d } = deps(null);
    (d.readOwner as jest.Mock).mockRejectedValueOnce(new Error('disk'));
    expect(await claimQueuedWorkFor('A', 'signed-in', d)).toBe('kept');
    expect(d.clearQueues).not.toHaveBeenCalled();
  });
});
