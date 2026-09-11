import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AddressInfo } from 'net';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { HealthController } from '../../health.controller';
import { probeDatabase } from '../../health-probe';

/**
 * AN ENDPOINT NAMED "status" MUST BE ABLE TO GO RED.
 *
 * ## What went wrong
 *
 * `GET /api/v1/auth/status` answered `{"status":"online","database":"connected"}` where
 * `database` was a **string literal**. The method body referenced no `DataSource`, ran no query,
 * and could not have produced any other answer. It reported the database as connected with the
 * database on fire, and anybody who wired a monitor to it had a green light that could not go
 * red — the most expensive kind of monitoring, because it actively suppresses the alarm.
 *
 * ## Why the happy path is not a test
 *
 * A test that asserts `database === 'connected'` against a working database passes identically
 * against the bug and against the fix. It is exactly the test that would have been written, and
 * exactly the reason this survived. **The only assertion that separates a probe from a literal
 * is one taken while the database is unavailable**, so that is what this file is built around.
 *
 * ## What "unavailable" means here
 *
 * A real `DataSource`, a real `pg` driver, a real TCP connect to a port where nothing is
 * listening, and a real `initialize()` failure — asserted, so the test cannot quietly degrade
 * into "the database happened to be fine and we mocked a rejection". The request then goes over
 * real HTTP through a real Nest router at the real production path, not through a directly
 * invoked controller method, because the defect was in what the endpoint *serves*.
 *
 * The shared rig's database is deliberately NOT taken down to produce this: other lanes are
 * running probes against it, and a regression test that needs a real outage to run is a
 * regression test that never runs.
 */

/** A port nothing can be listening on: binding it requires privileges no test process holds. */
const NOTHING_IS_LISTENING_HERE = 1;

/** A `DataSource` that genuinely cannot reach a database, verified by a failed `initialize()`. */
async function unreachableDataSource(): Promise<DataSource> {
  const dead = new DataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port: NOTHING_IS_LISTENING_HERE,
    username: 'nobody',
    password: 'nobody',
    database: 'nothing',
    connectTimeoutMS: 500,
  });

  // Proving the outage is part of the test. If this ever starts succeeding, the "database down"
  // cases below would be testing a healthy database and silently passing for the wrong reason.
  await expect(dead.initialize()).rejects.toBeDefined();
  expect(dead.isInitialized).toBe(false);
  return dead;
}

/** A database that answers. Stubbed, because the *down* case is the one that discriminates. */
const reachableDataSource = () => ({ query: async () => [{ ok: 1 }] }) as unknown as DataSource;

async function serve(dataSource: DataSource): Promise<{ app: INestApplication; base: string }> {
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController, HealthController],
    providers: [
      // `GET /auth/status` touches no auth service; everything else on the controller does, and
      // none of it is exercised here.
      { provide: AuthService, useValue: {} },
      { provide: getDataSourceToken(), useValue: dataSource },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  // The same prefix `main.ts` sets, so the path asserted below is the path deployed.
  app.setGlobalPrefix('api/v1');
  await app.init();
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}/api/v1` };
}

describe('GET /api/v1/auth/status — the database claim', () => {
  describe('with the database unreachable', () => {
    let app: INestApplication;
    let base: string;
    let dead: DataSource;

    beforeAll(async () => {
      dead = await unreachableDataSource();
      ({ app, base } = await serve(dead));
    }, 20_000);

    afterAll(async () => {
      await app?.close();
      if (dead?.isInitialized) await dead.destroy();
    });

    it('does not claim the database is connected', async () => {
      const body = await (await fetch(`${base}/auth/status`)).json();
      // The whole finding, in one assertion: this line was unreachable before the fix.
      expect(body.data.database).not.toBe('connected');
      expect(body.data.database).toBe('disconnected');
    });

    it('degrades the top-level status too, so a monitor reading only that field still sees it', async () => {
      const body = await (await fetch(`${base}/auth/status`)).json();
      expect(body.data.status).not.toBe('online');
      expect(body.data.status).toBe('degraded');
    });

    it('still answers 200 rather than throwing — an operator reads this to find out why', async () => {
      const res = await fetch(`${base}/auth/status`);
      expect(res.status).toBe(200);
    });

    it('agrees with /health, which was always honest', async () => {
      const [status, health, ready] = await Promise.all([
        (await fetch(`${base}/auth/status`)).json(),
        (await fetch(`${base}/health`)).json(),
        (await fetch(`${base}/health/ready`)).json(),
      ]);
      // Two endpoints, one probe. Re-hardcoding either side breaks this.
      expect(status.data.database).toBe('disconnected');
      expect(health.database).toBe('down');
      expect(ready.database).toBe('down');
    });
  });

  describe('with the database answering', () => {
    let app: INestApplication;
    let base: string;

    beforeAll(async () => {
      ({ app, base } = await serve(reachableDataSource()));
    });

    afterAll(async () => {
      await app?.close();
    });

    it('reports connected, and keeps the wording the deployment contract already used', async () => {
      const body = await (await fetch(`${base}/auth/status`)).json();
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('online');
      expect(body.data.database).toBe('connected');
      expect(typeof body.data.timestamp).toBe('string');
    });

    it('agrees with /health here too', async () => {
      const [status, health] = await Promise.all([
        (await fetch(`${base}/auth/status`)).json(),
        (await fetch(`${base}/health`)).json(),
      ]);
      expect(status.data.database).toBe('connected');
      expect(health.database).toBe('up');
    });
  });
});

describe('probeDatabase', () => {
  it('is up only when a round trip completed', async () => {
    await expect(probeDatabase({ query: async () => [{ ok: 1 }] } as any)).resolves.toBe('up');
  });

  it('is down when the query rejects, for any reason', async () => {
    const reasons = [
      new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      new Error('password authentication failed for user "fapoms_runtime"'),
      new Error('canceling statement due to statement timeout'),
      new Error('remaining connection slots are reserved'),
    ];
    for (const reason of reasons) {
      await expect(
        probeDatabase({ query: async () => { throw reason; } } as any),
      ).resolves.toBe('down');
    }
  });

  it('is down, not an exception, when there is no DataSource at all', async () => {
    await expect(probeDatabase(undefined)).resolves.toBe('down');
    await expect(probeDatabase(null)).resolves.toBe('down');
  });

  it('never throws, so a degraded database cannot turn the probe itself into a 500', async () => {
    const hostile = { query: () => { throw new Error('synchronous throw'); } } as any;
    await expect(probeDatabase(hostile)).resolves.toBe('down');
  });
});
