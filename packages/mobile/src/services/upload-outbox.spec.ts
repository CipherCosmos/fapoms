/**
 * The upload outbox is the difference between an audit packet that reaches the desk and one that
 * vanishes the moment the assayer leaves the paperwork screen. It runs on handsets nobody can
 * attach a debugger to, over connections that drop mid-branch, so its behaviour is pinned here.
 *
 * The failure under test is the one that quietly loses evidence: a packet that failed to send but
 * left no trace it had, so the assayer drove away believing the branch was filed.
 */

// The outbox persists through token-store, which reaches for expo-file-system. Mocked with a plain
// in-memory map so these tests exercise the outbox's own logic without a native runtime.
jest.mock('./token-store', () => {
  const store: Record<string, unknown> = {};
  return {
    __store: store,
    readCache: jest.fn(async (key: string) => (key in store ? store[key] : null)),
    writeCache: jest.fn(async (key: string, value: unknown) => {
      // Clone the way a real serialising cache would, so a returned buffer is not the stored one.
      store[key] = JSON.parse(JSON.stringify(value));
    }),
  };
});

import {
  enqueueUpload,
  getUploads,
  processOutbox,
  retryUpload,
  dismissUpload,
  clearOutbox,
  __resetOutboxForTests,
  OutboxUpload,
} from './upload-outbox';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tokenStore = require('./token-store') as { __store: Record<string, unknown> };

const packet = (branchName: string): Parameters<typeof enqueueUpload>[0] => ({
  assignmentId: `asg-${branchName}`,
  branchName,
  fileName: `${branchName}.pdf`,
  fileUri: `file:///cache/${branchName}.pdf`,
});

const ok = jest.fn(async () => ({ success: true as const }));
const fail = jest.fn(async () => ({ success: false as const, error: 'no signal' }));

beforeEach(() => {
  for (const key of Object.keys(tokenStore.__store)) delete tokenStore.__store[key];
  __resetOutboxForTests();
  ok.mockClear();
  fail.mockClear();
});

describe('enqueueing', () => {
  it('writes a packet down as PENDING and survives a restart', async () => {
    await enqueueUpload(packet('kollam'));

    __resetOutboxForTests(); // as if the app had been killed and reopened

    const list = await getUploads();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ branchName: 'kollam', status: 'PENDING', progress: 0 });
  });
});

describe('processing', () => {
  it('sends a queued packet and marks it delivered', async () => {
    await enqueueUpload(packet('kollam'));

    await processOutbox(ok);

    expect(ok).toHaveBeenCalledTimes(1);
    const list = await getUploads();
    expect(list[0].status).toBe('SENT');
    expect(list[0].progress).toBe(100);
  });

  /**
   * The failure that silently destroys evidence. A rejected upload — no signal, a 500, an expired
   * token — must leave the packet in the list, marked failed and retriable, not disappear.
   */
  it('keeps a failed packet visible with its reason', async () => {
    await enqueueUpload(packet('kollam'));

    await processOutbox(fail);

    const list = await getUploads();
    expect(list[0].status).toBe('FAILED');
    expect(list[0].error).toBe('no signal');
  });

  it('a thrown uploader is a failure, not a crash', async () => {
    await enqueueUpload(packet('kollam'));

    await processOutbox(async () => {
      throw new Error('boom');
    });

    const list = await getUploads();
    expect(list[0].status).toBe('FAILED');
    expect(list[0].error).toBe('boom');
  });

  it('reports progress to the UI while sending', async () => {
    await enqueueUpload(packet('kollam'));
    const upload = jest.fn(async (_e: OutboxUpload, onProgress: (p: number) => void) => {
      onProgress(40);
      return { success: true as const };
    });

    await processOutbox(upload);

    expect(upload.mock.calls[0][1]).toBeInstanceOf(Function);
  });

  /**
   * The whole point of a durable outbox: a packet left failed on a bad connection is retried on
   * its own the next time the outbox drains — the assayer does not have to press anything.
   */
  it('auto-retries a previously failed packet on the next drain', async () => {
    await enqueueUpload(packet('kollam'));
    await processOutbox(fail);
    expect((await getUploads())[0].status).toBe('FAILED');

    await processOutbox(ok);

    expect((await getUploads())[0].status).toBe('SENT');
  });

  it('does nothing when there is nothing to send', async () => {
    await processOutbox(ok);
    expect(ok).not.toHaveBeenCalled();
  });

  /**
   * A foreground return, a reconnect and a manual retry can all fire at once. Two concurrent
   * drains racing on the same list would upload the same packet twice.
   */
  it('will not run two drains at the same time', async () => {
    await enqueueUpload(packet('kollam'));
    let release: (v: { success: true }) => void = () => {};
    const slow = jest.fn(() => new Promise<{ success: true }>((res) => { release = res; }));

    const first = processOutbox(slow as any);
    // Let the first drain advance to the point it is parked inside the (slow) upload.
    await new Promise((r) => setTimeout(r, 0));
    expect(slow).toHaveBeenCalledTimes(1);

    // A second drain fired while the first is still in flight must not start its own — the
    // re-entry guard makes it a no-op, so the same packet is never sent twice.
    await processOutbox(slow as any);
    expect(slow).toHaveBeenCalledTimes(1);

    release({ success: true });
    await first;
  });
});

describe('retry and dismiss', () => {
  it('a manual retry re-queues a failed packet for the next send', async () => {
    await enqueueUpload(packet('kollam'));
    await processOutbox(fail);

    await retryUpload((await getUploads())[0].id);
    expect((await getUploads())[0].status).toBe('PENDING');

    await processOutbox(ok);
    expect((await getUploads())[0].status).toBe('SENT');
  });

  it('dismiss removes a packet from the list', async () => {
    await enqueueUpload(packet('kollam'));
    await dismissUpload((await getUploads())[0].id);
    expect(await getUploads()).toHaveLength(0);
  });
});

describe('sign-out', () => {
  it('empties the outbox so one assayer never uploads under another login', async () => {
    await enqueueUpload(packet('kollam'));

    await clearOutbox();

    expect(await getUploads()).toHaveLength(0);
  });
});
