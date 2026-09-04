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
  outboxTitle,
  __resetOutboxForTests,
  __reviveStaleSendingForTests,
  OutboxUpload,
} from './upload-outbox';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tokenStore = require('./token-store') as { __store: Record<string, unknown> };

const packet = (branchName: string): Parameters<typeof enqueueUpload>[0] => ({
  target: { kind: 'ASSIGNMENT_PACKET', assignmentId: `asg-${branchName}`, branchName },
  fileName: `${branchName}.pdf`,
  fileUri: `file:///cache/${branchName}.pdf`,
});

/** A registration scan: same queue, different destination and no assignment anywhere in it. */
const paper = (requirement: string, documentLabel: string): Parameters<typeof enqueueUpload>[0] => ({
  target: { kind: 'REGISTRATION_DOCUMENT', assayerId: 'me-1', requirement, documentLabel },
  fileName: `${requirement}.jpg`,
  fileUri: `file:///cache/${requirement}.jpg`,
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
    expect(list[0]).toMatchObject({
      target: { kind: 'ASSIGNMENT_PACKET', branchName: 'kollam' },
      status: 'PENDING',
      progress: 0,
    });
  });

  it('carries a registration document with no assignment attached to it', async () => {
    await enqueueUpload(paper('PAN_CARD', 'PAN card'));

    __resetOutboxForTests();

    const [entry] = await getUploads();
    expect(entry.target).toEqual({
      kind: 'REGISTRATION_DOCUMENT',
      assayerId: 'me-1',
      requirement: 'PAN_CARD',
      documentLabel: 'PAN card',
    });
  });

  /**
   * An entry written by a build that predates targets is a field worker's evidence sitting on
   * disk waiting for signal. An upgrade that dropped it, or left it with no destination for
   * `sendOne` to read, would lose exactly what this queue exists to protect.
   */
  it('adopts a packet queued before uploads had a target', async () => {
    tokenStore.__store['upload_outbox'] = [
      {
        id: 'legacy-1',
        assignmentId: 'asg-old',
        branchName: 'Kollam Main Branch',
        fileName: 'old.pdf',
        fileUri: 'file:///cache/old.pdf',
        status: 'FAILED',
        progress: 0,
        error: 'no signal',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const [entry] = await getUploads();

    expect(entry.target).toEqual({
      kind: 'ASSIGNMENT_PACKET',
      assignmentId: 'asg-old',
      branchName: 'Kollam Main Branch',
    });
    // Still retriable, which is the whole point of keeping it.
    expect(entry.status).toBe('FAILED');
    expect(outboxTitle(entry)).toBe('Kollam Main Branch');
  });

  it('an adopted legacy packet still sends', async () => {
    tokenStore.__store['upload_outbox'] = [
      {
        id: 'legacy-2', assignmentId: 'asg-old', branchName: 'Kollam', fileName: 'old.pdf',
        fileUri: 'file:///cache/old.pdf', status: 'PENDING', progress: 0,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    await processOutbox(ok);

    expect(ok).toHaveBeenCalledTimes(1);
    expect((await getUploads())[0].status).toBe('SENT');
  });
});

describe('what the list calls each entry', () => {
  it('names an audit packet by its branch and a document by its paper', async () => {
    await enqueueUpload(packet('kollam'));
    await enqueueUpload(paper('AADHAAR_FRONT', 'Aadhaar — front'));

    const [assignment, document] = await getUploads();

    expect(outboxTitle(assignment)).toBe('kollam');
    expect(outboxTitle(document)).toBe('Aadhaar — front');
  });

  /** A packet whose branch name never arrived still needs something to show in the list. */
  it('falls back rather than rendering an empty row', async () => {
    await enqueueUpload({
      target: { kind: 'ASSIGNMENT_PACKET', assignmentId: 'a1', branchName: '' },
      fileName: 'x.pdf',
    });

    expect(outboxTitle((await getUploads())[0])).toBe('Audit packet');
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

describe('stale SENDING revival', () => {
  /**
   * A packet killed mid-upload is the failure this exists to catch: the process dies with the
   * entry still marked SENDING, and `processOutbox` only ever picks up PENDING/FAILED, so
   * without this the packet is invisible to every future drain forever.
   */
  it('requeues a SENDING entry old enough to be from a dead process', () => {
    const stuck: OutboxUpload = {
      ...(packet('kollam') as any),
      id: '1',
      status: 'SENDING',
      progress: 40,
      createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    };
    const list = [stuck];
    __reviveStaleSendingForTests(list);
    expect(list[0].status).toBe('PENDING');
  });

  it('leaves a SENDING entry alone while it could still be a live transfer', () => {
    const inFlight: OutboxUpload = {
      ...(packet('kollam') as any),
      id: '1',
      status: 'SENDING',
      progress: 40,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const list = [inFlight];
    __reviveStaleSendingForTests(list);
    expect(list[0].status).toBe('SENDING');
  });

  it('a drain revives a stuck SENDING packet and resends it', async () => {
    // Simulate a launch that finds a packet the previous, now-dead process left SENDING —
    // written straight to the mocked store, the way a real cold start reads it off disk.
    tokenStore.__store['upload_outbox'] = [
      {
        ...packet('kollam'),
        id: '1',
        status: 'SENDING',
        progress: 40,
        createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      },
    ];

    await processOutbox(ok);
    expect((await getUploads())[0].status).toBe('SENT');
  });

  /**
   * The gap the two tests above do not cover: a SENDING entry that is only *seconds* old, found
   * on a genuinely fresh process — force-kill the app mid-upload, reopen it immediately.
   *
   * Before this fix, that packet waited out the full fifteen minutes: `reviveStaleSending` only
   * requeues entries older than `STALE_SENDING_MS`, and a kill-and-reopen a moment later is far
   * younger than that. Proven live against the real app: the packet sat at SENDING/0%, "Starting…
   * you can leave this screen, it keeps going", with zero requests reaching the server, and no
   * Retry button — `UploadRow` only renders one for FAILED — so there was nothing to tap either.
   *
   * The fix does not touch `STALE_SENDING_MS` or `reviveStaleSending`; it revives on the very
   * first disk read of a process's life instead, which is provably safe: nothing has called
   * `processOutbox` yet at that point, so no live transfer in *this* process can be the one that
   * SENDING entry belongs to.
   */
  it('revives a freshly-stuck SENDING packet on the very first read of a new process, without waiting out the stale timer', async () => {
    tokenStore.__store['upload_outbox'] = [
      {
        ...packet('kollam'),
        id: '1',
        status: 'SENDING',
        progress: 40,
        // Seconds old, not the twenty minutes the other cold-start test uses — this is the
        // "killed it and reopened right away" case, not the "left it alone for a while" case.
        createdAt: new Date(Date.now() - 5000).toISOString(),
        updatedAt: new Date(Date.now() - 5000).toISOString(),
      },
    ];
    __resetOutboxForTests(); // buffer is null again — the next load() is this process's first.

    // Reading the list at all (no drain yet) must already show it as retriable, not stuck.
    expect((await getUploads())[0].status).toBe('PENDING');

    await processOutbox(ok);
    expect(ok).toHaveBeenCalledTimes(1);
    expect((await getUploads())[0].status).toBe('SENT');
  });

  it('does not touch a SENDING entry the current process itself just set (no false revival mid-upload)', async () => {
    await enqueueUpload(packet('kollam'));
    let release: (v: { success: true }) => void = () => {};
    const slow = jest.fn(() => new Promise<{ success: true }>((res) => { release = res; }));

    const drain = processOutbox(slow as any);
    await new Promise((r) => setTimeout(r, 0)); // let it reach SENDING and park inside `slow`

    // A second load() within the same still-running process (e.g. a screen re-reading the list)
    // must see the transfer as still genuinely in flight, not revive it out from under itself.
    expect((await getUploads())[0].status).toBe('SENDING');

    release({ success: true });
    await drain;
    expect((await getUploads())[0].status).toBe('SENT');
  });

  /**
   * The bug the cold-start revival above shipped with, found live rather than in review: on a
   * real device, `useUploadOutbox` fires two mount-time effects in the same tick — one calls
   * `getUploads()` to render the list, the other calls `processOutbox()` to drain it — and both
   * reach `load()` before either's `await readCache(...)` resolves. Each then saw `buffer` as
   * `null`, each read the same on-disk snapshot, and each ran its own copy of the revival: two
   * independent arrays, both correctly revived in memory, but only one could become the module's
   * real `buffer`. The other's revival — and its `persist()` — were silently discarded, so
   * `processOutbox` sometimes read the losing copy, in which the packet still said SENDING, and
   * skipped it exactly as if this fix did not exist. Caught by adding a temporary trace and
   * watching the "first read" branch run twice for one launch.
   */
  it('two callers racing the very first read both see the packet revived, not just one of them', async () => {
    tokenStore.__store['upload_outbox'] = [
      {
        ...packet('kollam'),
        id: '1',
        status: 'SENDING',
        progress: 40,
        createdAt: new Date(Date.now() - 5000).toISOString(),
        updatedAt: new Date(Date.now() - 5000).toISOString(),
      },
    ];
    __resetOutboxForTests();

    // Fired together, exactly as useUploadOutbox's two mount effects do — neither awaited before
    // the other starts, so both must reach `readCache` before either's promise settles.
    const [fromRefresh, fromProcessDrain] = await Promise.all([
      getUploads(),
      processOutbox(ok).then(getUploads),
    ]);

    expect(fromRefresh[0].status).not.toBe('SENDING');
    expect(fromProcessDrain[0].status).toBe('SENT');
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('sign-out', () => {
  it('empties the outbox so one assayer never uploads under another login', async () => {
    await enqueueUpload(packet('kollam'));

    await clearOutbox();

    expect(await getUploads()).toHaveLength(0);
  });
});
