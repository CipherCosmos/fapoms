import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { BackgroundJobEntity } from './background-job.entity';
import { BackgroundJobStore, ExclusiveSlotBusyError } from './background-job.store';
import { purgeExpiredBackgroundJobs } from './background-jobs.retention';

/**
 * The two rules the background-job lifecycle leans on, against real Postgres.
 *
 * `background-jobs.lifecycle.spec.ts` proves the service and the runner use the store correctly,
 * with an in-memory stand-in. This proves the stand-in is honest: that the partial unique indexes
 * really refuse a second OPEN duplicate and a second RUNNING holder of an exclusive key, that
 * `ON CONFLICT DO NOTHING` really answers with the first row, and that the transitions' WHERE
 * clauses really refuse to leave from the wrong status.
 *
 * Run with `npm run test:db` against a migrated database (`DB_HOST`/`DB_PORT`/... as for
 * `migration:run`).
 */
describe('BackgroundJobStore against Postgres', () => {
  jest.setTimeout(60_000);

  let ds: DataSource;
  let store: BackgroundJobStore;
  const created: string[] = [];
  const USER = randomUUID();

  const values = (over: Partial<BackgroundJobEntity> = {}): Partial<BackgroundJobEntity> => ({
    kind: 'BRANCH_IMPORT',
    status: 'QUEUED',
    title: 'store spec',
    requestedBy: USER,
    actor: { userId: USER, roleNames: ['OPERATIONS'] },
    progress: { processed: 0, total: null, percent: null, stage: 'Waiting to start' },
    dedupeKey: randomUUID().replace(/-/g, ''),
    ...over,
  });

  const insert = async (over: Partial<BackgroundJobEntity> = {}) => {
    const out = await store.insert(values(over));
    if (out.inserted) created.push(out.job.id);
    return out;
  };

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    ds = AppDataSource;
    store = new BackgroundJobStore(ds.getRepository(BackgroundJobEntity));
  });

  afterAll(async () => {
    if (created.length) await ds.query(`DELETE FROM background_jobs WHERE id = ANY($1::uuid[])`, [created]);
    await ds.destroy();
  });

  it('one OPEN row per dedupe key: a racing duplicate gets the first row back', async () => {
    const key = randomUUID().replace(/-/g, '');
    const [a, b] = await Promise.all([insert({ dedupeKey: key }), insert({ dedupeKey: key })]);
    expect([a.inserted, b.inserted].sort()).toEqual([false, true]);
    expect(a.job.id).toBe(b.job.id);
  });

  it('a settled row frees its dedupe key', async () => {
    const key = randomUUID().replace(/-/g, '');
    const first = await insert({ dedupeKey: key });
    await store.transition(first.job.id, ['QUEUED'], { status: 'FAILED', finishedAt: new Date() });
    const second = await insert({ dedupeKey: key });
    expect(second.inserted).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it('one RUNNING holder per exclusive key; the slot frees when the holder finishes', async () => {
    const exclusive = `BRANCH_IMPORT|CLIENT|${randomUUID()}`;
    const a = await insert();
    const b = await insert();

    const claimedA = await store.claim(a.job.id, exclusive);
    expect(claimedA).toEqual(expect.objectContaining({ status: 'RUNNING', attempts: 1 }));
    expect(claimedA!.startedAt).toBeInstanceOf(Date);
    await expect(store.claim(b.job.id, exclusive)).rejects.toBeInstanceOf(ExclusiveSlotBusyError);
    expect((await store.findById(b.job.id))!.status).toBe('QUEUED');

    // Re-claiming its own row (an idempotent restart) is not a clash with itself.
    expect((await store.claim(a.job.id, exclusive))!.attempts).toBe(2);

    await store.transition(a.job.id, ['RUNNING'], { status: 'SUCCEEDED', finishedAt: new Date() });
    expect((await store.claim(b.job.id, exclusive))!.status).toBe('RUNNING');
  });

  it('transitions leave only from the statuses they name', async () => {
    const { job } = await insert();
    expect(await store.transition(job.id, ['RUNNING'], { status: 'SUCCEEDED' })).toBeNull();
    expect(await store.writeProgress(job.id, { processed: 1, total: 1, percent: 100, stage: 'x' })).toBe(false);
    const cancelled = await store.transition(job.id, ['QUEUED'], { status: 'CANCELLED', finishedAt: new Date() });
    expect(cancelled!.status).toBe('CANCELLED');
    expect(await store.claim(job.id, null)).toBeNull();
    expect(await store.requestCancel(job.id, USER)).toBeNull();
  });

  it('lists a regional administrator only the jobs wholly inside their regions', async () => {
    const scopeId = randomUUID();
    const north = await insert({ regions: ['NORTH'], scopeType: 'CLIENT', scopeId });
    await insert({ regions: ['NORTH', 'SOUTH'], scopeType: 'CLIENT', scopeId });
    await insert({ regions: null, scopeType: 'CLIENT', scopeId });

    const rows = await store.list({ statuses: ['QUEUED'], withinRegions: ['NORTH'], scopeType: 'CLIENT', scopeId, limit: 10 });
    expect(rows.map((r) => r.id)).toEqual([north.job.id]);
    const all = await store.list({ statuses: ['QUEUED'], withinRegions: null, scopeType: 'CLIENT', scopeId, limit: 10 });
    expect(all).toHaveLength(3);
  });

  it('retention removes finished rows past the cutoff and never an open one', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    const finished = await insert({ status: 'SUCCEEDED', finishedAt: old, inputObjectKey: `spec/${randomUUID()}` });
    const stuckOpen = await insert({ status: 'RUNNING' });
    await ds.query(`UPDATE background_jobs SET updated_at = $2 WHERE id = $1`, [stuckOpen.job.id, old]);

    const deleted: string[] = [];
    const storage = { deleteFile: async (k: string) => { deleted.push(k); } };
    await purgeExpiredBackgroundJobs(ds, storage as any, new Date(Date.now() - 30 * 86_400_000), 500, 1);

    expect(await store.findById(finished.job.id)).toBeNull();
    expect(deleted).toContain(finished.job.inputObjectKey);
    expect(await store.findById(stuckOpen.job.id)).not.toBeNull();
  });

  it('retention deletes every file of a several-file job, but keeps one a younger job still lists', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    const shared = `spec/${randomUUID()}`;
    const own = `spec/${randomUUID()}`;
    const object = (key: string) => ({ key, fileName: 'a.pdf', mimeType: 'application/pdf', size: 1, sha256: '0'.repeat(64) });
    const batch = await insert({ status: 'SUCCEEDED', finishedAt: old, inputObjects: [object(own), object(shared)] });
    await insert({ status: 'SUCCEEDED', finishedAt: new Date(), inputObjects: [object(shared)] });

    const deleted: string[] = [];
    const storage = { deleteFile: async (k: string) => { deleted.push(k); } };
    await purgeExpiredBackgroundJobs(ds, storage as any, new Date(Date.now() - 30 * 86_400_000), 500, 1);

    expect(await store.findById(batch.job.id)).toBeNull();
    expect(deleted).toContain(own);
    expect(deleted).not.toContain(shared);
  });

  it('a tracked row records the feature queue it runs on', async () => {
    const { job } = await insert({ runnerQueue: 'billing-bulk', dedupeKey: null });
    expect((await store.findById(job.id))!.runnerQueue).toBe('billing-bulk');
  });
});
