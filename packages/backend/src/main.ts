/**
 * FAPOMS — Application Entry Point
 */

import * as net from 'net';
import { NestFactory } from '@nestjs/core';
import { INestApplication, Logger } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bull';
import type { Queue } from 'bull';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { setupBullBoard } from './infrastructure/queue/bull-board.setup';
import { RedisIoAdapter } from './infrastructure/realtime/redis-io.adapter';
import { realtimeHealth } from './infrastructure/realtime/realtime-health';
import { correlationIdMiddleware } from './infrastructure/http/correlation-id.middleware';
import { requestContextMiddleware } from './core/context/request-context.middleware';
import { RequestContextInterceptor } from './core/context/request-context.interceptor';
import { GlobalExceptionFilter } from './infrastructure/http/global-exception.filter';
import { CodedValidationPipe } from './infrastructure/http/coded-validation.pipe';
import { ResponseInterceptor } from './infrastructure/http/response.interceptor';
import { AssayerRedactionInterceptor } from './infrastructure/http/assayer-redaction.interceptor';
import { AssayerMoneyRedactionInterceptor } from './infrastructure/http/assayer-money-redaction.interceptor';
import { TrimStringsPipe } from './infrastructure/http/trim-strings.pipe';
import { Reflector } from '@nestjs/core';

import * as express from 'express';
import * as compression from 'compression';
import helmet from 'helmet';
import { createProxyMiddleware } from 'http-proxy-middleware';
import {
  assertConcurrencyWithinPool,
  DEFAULT_DB_POOL_MAX,
  ALL_QUEUE_NAMES,
} from './infrastructure/queue/worker-concurrency';
import { DataSource } from 'typeorm';
import { ROLE_PERMISSIONS } from './modules/auth/role-permissions';
import { MIGRATION_ROLE, RUNTIME_ROLE, RUNTIME_ASSERTIONS } from './infrastructure/database/roles/role-model';

/**
 * Configuration that must never reach production, checked before anything connects.
 *
 * These are fail-fast rather than warnings on purpose: each one is silent in the moment and
 * expensive later, so the only safe behaviour is to refuse to start.
 */
export function assertProductionSafeConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const fatal: string[] = [];

  const jwtSecret = process.env.JWT_SECRET;
  // These literals were committed to git history in .env.docker, so they must be treated as
  // public and permanently burned — not merely "a default someone might still be using".
  const BURNED_SECRETS = ['dev-secret', 'fapoms-docker-dev-secret-key-change-in-production'];
  if (!jwtSecret || BURNED_SECRETS.includes(jwtSecret)) {
    fatal.push('JWT_SECRET is unset or a value that was committed to this repository. Every access token would be forgeable by anyone who has read the git history. Rotate it.');
  } else if (jwtSecret.length < 32) {
    fatal.push('JWT_SECRET is shorter than 32 characters. Use a high-entropy random value.');
  }

  /**
   * The one that would quietly destroy data.
   *
   * `synchronize: true` lets TypeORM reshape the live schema to match the entity classes on
   * every boot — dropping columns, indexes and constraints it does not recognise, with no
   * migration and no confirmation. This repository has already lost a unique index to it once
   * (see notification.entity.ts, where a raw-SQL index had to be moved into a decorator after
   * synchronize deleted it). Against a production database holding audit evidence for a bank,
   * a single deploy could silently drop columns and the data in them.
   */
  if (process.env.DB_SYNCHRONIZE === 'true') {
    fatal.push('DB_SYNCHRONIZE=true is not permitted in production — it rewrites the live schema from the entity classes and drops anything it does not recognise. Run migrations instead.');
  }

  /**
   * The application must not be the identity that can change the schema.
   *
   * The audit trail is append-only by trigger, and a trigger can be removed by whoever owns the
   * table. FAPOMS used to connect as a superuser, so the application's own credential could
   * `ALTER TABLE audit_events DISABLE TRIGGER` and then delete freely — demonstrated in a
   * throwaway database on 2026-09-09. `database/roles/role-model.ts` splits the deploy identity
   * from the runtime one; these two checks are what stop a deployment quietly putting them back
   * together.
   *
   * Migrations running in the API process is the way that happens by accident: it is the reason
   * the connection would need DDL at all. `StartupChecksService` then asks the database what the
   * runtime identity can actually do, which is the check that cannot be satisfied by configuration
   * alone.
   */
  if (process.env.DB_USERNAME === RUNTIME_ROLE && process.env.DB_MIGRATIONS_RUN !== 'false') {
    fatal.push(
      `DB_MIGRATIONS_RUN must be "false" when the API connects as ${RUNTIME_ROLE}. Migrations are a deploy step run as ${MIGRATION_ROLE}; an API that migrates needs schema privileges, and a runtime identity with schema privileges can remove the audit triggers.`,
    );
  }
  if (process.env.DB_USERNAME === MIGRATION_ROLE) {
    fatal.push(
      `The API must not connect as ${MIGRATION_ROLE}. That credential exists for migrations and for \`npm run db:harden\`, and it can alter the audit structures; set DB_USERNAME to ${RUNTIME_ROLE}.`,
    );
  }

  if (!process.env.CORS_ORIGINS) {
    fatal.push('CORS_ORIGINS is unset, so the API would fall back to localhost development origins and reject the real frontend.');
  }

  /**
   * PII at rest must actually be encrypted.
   *
   * The field-encryption layer degrades to plaintext passthrough (with only a log warning) when
   * `PII_ENCRYPTION_KEY` is unset — so a production deploy that forgets it writes PAN, bank
   * account numbers and government-ID numbers as cleartext into Postgres, and every subsequent
   * write silently "migrates" more of them to plaintext, with no failure signal. That is a
   * data-protection breach that is invisible until someone reads the table. Fail fast instead,
   * the same as the secrets above: a missing or too-short key is a one-line fix at deploy time.
   */
  const piiKey = process.env.PII_ENCRYPTION_KEY;
  // Exactly the two canonical forms resolveKey() uses verbatim. The previous test accepted any
  // string whose lossy base64 decode reached 32 bytes, which then took the SHA-256 stretch path —
  // so a pasted sentence could pass this gate while the encryption layer quietly derived a key
  // from it. Generate a real one: `openssl rand -hex 32`.
  const piiKeyOk =
    !!piiKey &&
    (/^[0-9a-fA-F]{64}$/.test(piiKey) ||
      (/^[A-Za-z0-9+/=]+$/.test(piiKey) && Buffer.from(piiKey, 'base64').length === 32));
  if (!piiKeyOk) {
    fatal.push('PII_ENCRYPTION_KEY is unset or not a canonical 32-byte key (64 hex chars, or 32-byte base64). Without it, sensitive fields (PAN, bank account, government IDs) are stored UNENCRYPTED. Generate one with: openssl rand -hex 32');
  }

  // A production database reachable with the development password is not a production database.
  // 'fapoms_dev' is included because it was committed to git history in .env.docker.
  const dbPassword = process.env.DB_PASSWORD;
  if (!dbPassword || ['postgres', 'password', 'fapoms', 'fapoms_dev', 'changeme'].includes(dbPassword)) {
    fatal.push('DB_PASSWORD is unset, a well-known default, or a value committed to this repository.');
  }

  /**
   * Audit evidence must not live on a container's local disk in production.
   *
   * STORAGE_DRIVER defaults to 'local', which writes scanned audit PDFs into the container
   * filesystem. On more than one replica the same document 404s from whichever replica did
   * not receive the upload, and every file is destroyed when the container is replaced — the
   * ordinary outcome of any deploy. Only 's3' (MinIO/S3) is safe for a multi-replica bank
   * audit system, so refuse to start in production without it.
   */
  if ((process.env.STORAGE_DRIVER || 'local') !== 's3') {
    fatal.push('STORAGE_DRIVER must be "s3" in production. Local-disk storage loses audit evidence on every container replacement and 404s across replicas.');
  }

  /**
   * Malware scanning must be REQUIRED in production. This system stores KYC scans and audit PDFs
   * uploaded from the field; accepting a file it cannot scan is the wrong default for that content.
   * A ClamAV sidecar now ships in deploy/docker-compose.prod.yml, so this is a one-line config the
   * operator can satisfy (set FILE_SCAN_REQUIRED=true, point CLAMAV_HOST at the sidecar) rather than
   * a demand to stand up new infrastructure. With it true, every upload path fails CLOSED when the
   * scanner is unreachable (FileScanService.scanBuffer throws), which is the intended posture.
   */
  if (process.env.FILE_SCAN_REQUIRED !== 'true') {
    fatal.push('FILE_SCAN_REQUIRED must be "true" in production so KYC/audit uploads are malware-scanned and the upload path fails closed when the scanner is unavailable. Set it and point CLAMAV_HOST at the ClamAV sidecar.');
  }



/**
   * MinIO's root credential creates the account the backend then signs every S3 request with —
   * a compose-level default here is not a placeholder waiting to be overridden, it is the actual
   * password on the actual account holding every audit document, KYC scan and government ID in
   * the system. `docker-compose.yml` falls back to `fapoms_minio_secret` (the same literal that
   * lives in git history) when the env var is unset, so "unset in production" and "using the
   * burned dev password" are the same failure.
   *
   * Deliberately does NOT check LIVEKIT_API_SECRET here: LiveKit is not in
   * deploy/docker-compose.prod.yml at all today, so making it fatal would not catch a
   * misconfiguration — it would simply stop the API from booting until that infrastructure exists.
   * (FILE_SCAN_REQUIRED IS now checked above, because the ClamAV sidecar it needs now ships in the
   * prod compose, so it is a one-line config the operator can satisfy.)
   */
  const minioPassword = process.env.MINIO_ROOT_PASSWORD;
  if (process.env.STORAGE_DRIVER === 's3' && process.env.S3_ENDPOINT && !/amazonaws\.com/.test(process.env.S3_ENDPOINT)) {
    if (!minioPassword || minioPassword === 'fapoms_minio_secret') {
      fatal.push('MINIO_ROOT_PASSWORD is unset or the burned dev default. This is the actual root credential on the bucket holding every audit document and KYC scan.');
    }
  }

  if (fatal.length > 0) {
    throw new Error(
      `Refusing to start in production with unsafe configuration:\n  - ${fatal.join('\n  - ')}`,
    );
  }
}

/**
 * Say so when a role holds fewer permissions in the database than the code grants it.
 *
 * `ROLE_PERMISSIONS` is the grant table; the seed unions it into each role, so re-running the seed
 * reconciles any difference. Nothing announced that a re-run was owed, and the application reads
 * the database while `route-permission-parity.spec.ts` reads the code table — so the two could
 * disagree with every test green.
 *
 * They did. PRODUCT_SUPPORT was given three grants in code and never seeded here, so at runtime it
 * held none at all. That was invisible while `@Roles(...)` was the only gate — the role's NAME
 * opened its routes and the permission table was never consulted — and became load-bearing the
 * moment permissions turned authoritative, because a role with no grants can be granted nothing.
 *
 * A warning, not a refusal: the reconciliation is additive and a deployment that is merely behind
 * on it should not fail to boot over it.
 *
 * This warning was right, and its advice was the cause. It printed at every boot of the live
 * deployment naming all nineteen missing grants, and told the reader to run the seed — which was
 * the thing removing them. The seed loaded each role without its `permissions` relation and then
 * assigned the array, and TypeORM deletes every junction row an assigned many-to-many does not
 * name. Both faults are fixed in `seed.ts`, `ReconcileRolePermissions3` repairs the databases
 * they already ran against, and `verify-migrations-from-empty.mjs` fails CI if a fresh migrate
 * and seed ever leaves a role short again.
 */
async function warnOnRoleGrantDrift(app: any, logger: Logger): Promise<void> {
  try {
    const dataSource = app.get(DataSource, { strict: false });
    if (!dataSource?.isInitialized) return;

    const rows: Array<{ name: string; held: string }> = await dataSource.query(`
      SELECT r.name, coalesce(string_agg(p.resource || ':' || p.action, ','), '') AS held
        FROM roles r
        LEFT JOIN role_permissions rp ON rp.role_id = r.id
        LEFT JOIN permissions p ON p.id = rp.permission_id
       GROUP BY r.name
    `);

    const behind: string[] = [];
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      const row = rows.find((r) => r.name === role);
      if (!row) continue;
      const held = new Set(row.held ? row.held.split(',') : []);
      // Compared on resource:action — the stored rows carry a scope column the code key repeats,
      // and a scope mismatch is a different fault from a missing grant.
      const missing = (granted as string[])
        .map((key) => key.split(':').slice(0, 2).join(':'))
        .filter((key) => !held.has(key));
      if (missing.length) behind.push(`${role} is missing ${missing.length} (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''})`);
    }

    if (behind.length) {
      logger.warn(
        `Role grants in this database are behind ROLE_PERMISSIONS: ${behind.join('; ')}. `
        + 'Routes are authorised from the DATABASE, so these roles can reach less than the code '
        + 'says they should. Deploying reconciles it: ReconcileRolePermissions replays the grant '
        + 'table additively at migration time. Do not hand-write the rows.',
      );
    }
  } catch (err: any) {
    // Never let a diagnostic stop the API booting.
    logger.warn(`Could not check role grants against ROLE_PERMISSIONS: ${err?.message ?? err}`);
  }
}

/**
 * Ask the database what this connection can do, BEFORE Nest builds anything.
 *
 * `StartupChecksService` already runs this list, and on the one database it was written for it
 * never gets to speak. It lives in `onApplicationBootstrap`, and Nest runs every `onModuleInit`
 * first — so against a provisioned-but-unhardened database `GeoSeedService` queries `geo_states`,
 * dies on the grants `db:harden` would have created, and the operator is told a geo table is
 * unreadable. Fail-closed survived; the diagnosis did not.
 *
 * So the same list runs here, on its own connection, before `NestFactory.create`. It is the first
 * thing to touch the database and therefore the first thing that can explain it.
 *
 * Fatal only where the answer means something: in production, or under `STARTUP_CHECKS_STRICT`.
 * A developer running against a single-role database gets one warning and their application.
 */
async function assertDatabaseIdentity(): Promise<void> {
  const strict = process.env.NODE_ENV === 'production' || process.env.STARTUP_CHECKS_STRICT === 'true';
  // Nothing to check before the roles exist. A developer on one role is not a misconfiguration.
  if (!strict && process.env.DB_USERNAME !== RUNTIME_ROLE) return;

  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE || 'fapoms',
    entities: [],
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  const failures: string[] = [];
  try {
    await ds.initialize();
    for (const { what, sql } of RUNTIME_ASSERTIONS) {
      const rows = await ds.query(sql);
      if (rows?.[0]?.ok !== true) failures.push(what);
    }
  } catch (err) {
    // Cannot reach the database, or cannot read its catalogue. Not this check's job to decide
    // whether that is fatal — TypeORM is about to say so far more precisely.
    console.warn(`[startup] could not determine the database identity: ${(err as Error).message}`);
    return;
  } finally {
    if (ds.isInitialized) await ds.destroy().catch(() => undefined);
  }

  if (failures.length === 0) return;

  const detail = failures.map((f) => `  - ${f}`).join('\n');
  if (!strict) {
    console.warn(
      `[startup] this database has not been hardened:\n${detail}\n`
      + '  Run `npm run db:harden`. Continuing because this is not production.',
    );
    return;
  }

  console.error(
    `FATAL: the database this application is connecting to has not been hardened.\n${detail}\n\n`
    + '  Run `npm run db:harden` against it, and check DB_USERNAME is the runtime role.\n'
    + '  See docs/database-roles.md. Refusing to start: an unhardened database is not a reduced\n'
    + '  deployment, it is one where the application credential can remove the audit triggers.',
  );
  process.exit(1);
}

async function bootstrap() {
  assertProductionSafeConfig();
  await assertDatabaseIdentity();

  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const logger = new Logger('Bootstrap');

  // ── Multi-node realtime ───────────────────────────────────────────────────────
  // Back Socket.IO with the Redis adapter so room-scoped emits reach clients on
  // every replica, not just the one that produced the event. Without it the API is
  // capped at a single instance for anything realtime. If Redis is unreachable at
  // boot we log and fall back to the in-memory adapter, which is correct for one node
  // and lets local/test runs work without Redis.
  if (process.env.NODE_ENV !== 'test') {
    // REDIS_HOST being set means multi-node realtime is intended, so a failed adapter becomes a
    // readiness failure rather than a silent single-node fallback that keeps taking traffic.
    realtimeHealth.redisConfigured = !!process.env.REDIS_HOST;
    try {
      const redisIoAdapter = new RedisIoAdapter(app);
      await redisIoAdapter.connectToRedis();
      app.useWebSocketAdapter(redisIoAdapter);
      realtimeHealth.redisAdapterConnected = true;
    } catch (err: any) {
      realtimeHealth.redisAdapterConnected = false;
      logger.warn(
        `Redis Socket.IO adapter unavailable (${err?.message}); falling back to single-node in-memory adapter. Readiness reports degraded while REDIS_HOST is set.`,
      );
    }
  }

  // Close DB pools, Redis clients, Bull queues and open sockets cleanly on SIGTERM/
  // SIGINT so rolling deploys and autoscaling drain in-flight work instead of
  // dropping connections mid-request.
  app.enableShutdownHooks();

  // ── Process role (api | worker | all) ─────────────────────────────────────────
  // Lets API replicas and background workers scale independently. Default 'all'
  // preserves the single-process behaviour exactly, so existing deployments are
  // unaffected; opt into the split by setting PROCESS_ROLE per replica set. (An
  // all-'api' deployment with no worker would never process jobs — run at least one
  // 'worker' or 'all' replica.)
  const processRole = (process.env.PROCESS_ROLE || 'all').toLowerCase();

  // The queues each picked a sensible concurrency; nobody added them up. Counted 2026-08-17 the
  // sum is 29 slots against a default pool of 20, and with the shipped PROCESS_ROLE=all those
  // slots share the pool with every request handler. Say so at boot rather than letting it
  // surface later as unattributable request timeouts. See `worker-concurrency.ts`.
  assertConcurrencyWithinPool(
    Number(process.env.DB_POOL_MAX) || DEFAULT_DB_POOL_MAX,
    processRole,
    logger,
  );

  if (processRole === 'worker') {
    /**
     * Still needs ONE thing HTTP-shaped: liveness. The prod healthcheck
     * (deploy/docker-compose.prod.yml) wgets `/api/v1/health` on every container in the compose
     * file, worker included — a worker with no listener there fails its healthcheck forever and
     * the orchestrator kills a process that was never actually broken. `HealthController` is
     * already registered on this app (AppModule), so this is the global prefix plus `listen` and
     * nothing else — not a second Express app, not a duplicate of the health logic, just skipping
     * the api-only middleware above.
     *
     * BEFORE `init()`, and that ordering is the whole point.
     *
     * `setGlobalPrefix` rewrites the route table, and `init()` is what builds it. Called after,
     * it silently does nothing: the routes stay where they were mapped. So the worker served its
     * health endpoint at `/health` while the healthcheck asked for `/api/v1/health` and got a 404
     * — for a failing streak of 297 probes, on a container that was sealing audit events and
     * running integrity scans perfectly the whole time.
     *
     * That is worse than a cosmetic wrong colour in `podman ps`. `depends_on: service_healthy`
     * means a permanently-unhealthy worker blocks anything declared to wait for it, and an
     * orchestrator with a restart-on-unhealthy policy will keep killing a healthy process. It
     * also trains whoever reads the dashboard to ignore the one signal that is supposed to mean
     * something.
     */
    app.setGlobalPrefix('api/v1');

    // Dedicated worker: runs Bull processors + scheduled crons and skips the request-serving
    // middleware stack below (compression, LiveKit proxy, body parsers, Swagger) because nothing
    // here ever takes a real user request. init() runs the module lifecycle hooks that register
    // the processors and repeatable jobs.
    await app.init();

    const workerPort = process.env.WORKER_HEALTH_PORT || process.env.PORT || 3000;
    await app.listen(workerPort);

    logger.log(
      `PROCESS_ROLE=worker — processing background jobs and schedules; ` +
        `serving only /api/v1/health on port ${workerPort} for the container healthcheck.`,
    );
    return;
  }

  /**
   * Trust the reverse proxy so `req.ip` is the client, not Caddy.
   *
   * Without this Express ignores X-Forwarded-For and every request appears to come from the
   * proxy's address: the rate limiter counted the whole organisation as one caller (300 req/min
   * for everyone, 20 logins/min for everyone) and every login audit row recorded Caddy's IP.
   *
   * The value is a list of trusted RANGES, not a hop count, on purpose. Requests reach the API
   * as `X-Forwarded-For: <client>, <caddy>` — Funnel sets the client, Caddy appends itself —
   * and the trusted set (loopback, link-local, RFC 1918 / ULA) covers every hop this deployment
   * puts in front of the API while excluding the client's own address, so the resolved IP is the
   * rightmost UNtrusted entry: the real client. A spoofed X-Forwarded-For prepended by an
   * attacker sits further left and is never reached. `TRUST_PROXY=false` disables it for a
   * deployment with no proxy at all.
   */
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy !== 'false') {
    app.getHttpAdapter().getInstance().set(
      'trust proxy',
      trustProxy && trustProxy !== 'true' ? trustProxy : ['loopback', 'linklocal', 'uniquelocal'],
    );
  }

  // Correlation id first — before anything can fail — so every request (including one that
  // errors before it reaches a handler) carries an id the exception filter and logs share.
  app.use(correlationIdMiddleware);

  // Immediately after: open the ambient request context (IP, user-agent, request id) and keep it
  // open for the whole request, so every audit event recorded downstream names who acted, from
  // where, on which request — without threading those values through every service. The
  // authenticated actor is added later by RequestContextInterceptor once the JWT guard has run.
  app.use(requestContextMiddleware);

  // ── Response compression ──────────────────────────────────────────────────────
  // Field assayers work on rural 2G/weak-3G links, and the app polls JSON constantly
  // (assignments, schedules, documents, notifications). JSON compresses ~70-80%, so this is
  // the single cheapest latency win on a slow connection.
  //
  // Files are deliberately skipped: PDFs and images are already compressed, so re-compressing
  // burns CPU for ~0% gain and, worse, forces chunked encoding that breaks the Content-Length
  // and HTTP Range handling the resumable download path depends on.
  app.use(
    compression({
      threshold: 1024, // below ~1KB the header overhead outweighs the saving
      filter: (req: any, res: any) => {
        const type = String(res.getHeader('Content-Type') || '');
        if (/^(application\/pdf|image\/|video\/|application\/zip|application\/octet-stream)/.test(type)) {
          return false;
        }
        return compression.filter(req, res);
      },
    }),
  );

  // Payload limit. Large scans should go through the resumable chunked or binary upload endpoints
  // rather than a single body; the high ceiling only remains for the legacy base64-JSON upload
  // (document.controller — a PDF inflates ~33% as base64). It's env-tunable so a deployment that has
  // moved off that path can shrink the JSON DoS surface (e.g. MAX_JSON_BODY=2mb). Rate limiting
  // (the throttler) already caps how fast large bodies can be sent.
  /**
   * LiveKit signaling proxy. Clients never talk to the SFU directly — the browser/app
   * connects to `/livekit` on THIS server, and the WebSocket is piped to the livekit
   * container over the docker network. Its 7880 port is not published on the host.
   * Mounted before the body parsers so proxied requests stream through untouched.
   * (Voice media itself is WebRTC — encrypted SRTP over the SFU's UDP range — which
   * cannot ride an HTTP proxy; only signaling/auth/discovery pass through here.)
   */
  const livekitProxy = createProxyMiddleware({
    pathFilter: '/livekit',
    target: process.env.LIVEKIT_HOST || 'http://livekit:7880',
    ws: true,
    changeOrigin: true,
    pathRewrite: { '^/livekit': '' },
  });
  app.use(livekitProxy);

  const bodyLimit = process.env.MAX_JSON_BODY || '50mb';
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ limit: bodyLimit, extended: true }));

  // Global prefix for all API routes
  app.setGlobalPrefix('api/v1');

  // Global validation pipe — enforces DTO validation.
  //
  // TrimStringsPipe runs FIRST, so `@IsNotEmpty()` sees `""` rather than `"   "` and refuses it.
  // Without it a field of spaces passed both the browser's `required` attribute and every
  // non-empty check, and was stored as-is — see the pipe for the records that produced.
  // CodedValidationPipe is the stock ValidationPipe with the same options; it adds
  // `code: VALIDATION_FAILED` and a per-field `fields` array to the 400 body. The `message`
  // array is produced by Nest's own flattening and is unchanged — see the pipe for why that
  // matters to the mobile app.
  app.useGlobalPipes(
    new TrimStringsPipe(),
    new CodedValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
    }),
  );

  // Single HTTP error boundary: preserves the existing shape for deliberate HttpExceptions
  // (validation messages included) and redacts everything else so TypeORM/Redis/S3 internals
  // never reach a client. Registered after the pipe so validation failures flow through it too.
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Single success-response boundary, mirroring the error boundary above. Idempotent by
  // design: the 285 controller sites that already hand-build `{ success, data }` pass straight
  // through, so this ships without touching them and they can be de-enveloped one at a time.
  /**
   * Order matters: redaction runs before the envelope wraps the payload, so it walks the
   * response the handler actually returned rather than an `{ success, data }` shell.
   */
  app.useGlobalInterceptors(
    // First: fold the authenticated actor into the ambient request context, before any handler
    // runs, so audit events recorded during the request carry userId/role/session.
    new RequestContextInterceptor(),
    new AssayerRedactionInterceptor(),
    // The assayer sees no money (2026-09): assignment fee fields are stripped from every
    // response to an assayer-only principal, at the same boundary — and for the same reasons —
    // as the PII redaction above it. See the interceptor for the policy.
    new AssayerMoneyRedactionInterceptor(),
    new ResponseInterceptor(app.get(Reflector)),
  );

  /**
   * Security response headers.
   *
   * There were none. The API serves audit documents and is called from a browser SPA, so the
   * defaults that matter here are clickjacking protection, MIME-sniffing prevention and
   * referrer suppression.
   *
   * `contentSecurityPolicy` is disabled deliberately: this process serves JSON and file
   * downloads, not HTML pages, and helmet's default CSP breaks the Swagger UI that ops uses.
   * `crossOriginResourcePolicy` is relaxed to cross-origin because the frontend is served from
   * a different origin and fetches document blobs from here.
   */
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      // Explicit HSTS (defense in depth behind the Caddy edge, which also sets it): one year,
      // includeSubDomains, NO preload — preload is an irreversible commitment and is added at the
      // edge/preload-list level only after every subdomain is verified HTTPS-only.
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
    }),
  );

  // CORS configuration — allows frontend web and mobile app
  const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:8081,http://localhost:19006')
    .split(',')
    .map(s => s.trim());
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  /**
   * API documentation — never in production.
   *
   * This was mounted unconditionally, so `/api/docs` and `/api/docs-json` served the complete
   * API surface — 302 endpoints with their parameters, request shapes and auth requirements — to
   * anyone who asked, with no authentication. On an internal deployment that is untidy; behind a
   * public tunnel it is a map of the entire application handed to whoever finds the URL.
   *
   * `NODE_ENV=production` is already set on real deployments, so this needs no new configuration.
   * Set `ENABLE_API_DOCS=true` to bring it back deliberately — for a staging box, say — rather
   * than having it on by default everywhere.
   */
  const docsEnabled =
    process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true';
  if (docsEnabled) {
    const config = new DocumentBuilder()
      .setTitle('FAPOMS API')
      .setDescription('Field Audit Planning & Operations Management System')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  if (process.env.NODE_ENV !== 'test') {
    setupBullBoard(app);
  }

  if (processRole === 'api') {
    // API replica: stop this process from executing background jobs so they run on
    // worker replicas instead. pause(true) is a LOCAL pause — enqueuing from request
    // handlers still works.
    await pauseLocalQueues(app, logger);
    logger.log('PROCESS_ROLE=api — serving HTTP; background jobs deferred to worker replicas.');
  }

  await warnOnRoleGrantDrift(app, logger);

  const port = process.env.PORT || 3000;
  await app.listen(port);

  // Server-level timeouts. `headersTimeout` defends against slow-header (slow-loris) clients holding
  // connections open; `keepAliveTimeout` is set to exceed a typical upstream load-balancer idle timeout
  // to avoid the well-known connection-reuse race. `requestTimeout` stays generous so a slow field-network
  // upload (chunked/base64 on 2G) still completes — shrink it where uploads go direct-to-storage.
  const httpServer = app.getHttpServer();

  // WebSocket upgrades for the LiveKit signaling proxy. Scoped strictly to /livekit so
  // socket.io's own upgrade handling (path /socket.io) is untouched.
  httpServer.on('upgrade', (req: any, socket: any, head: any) => {
    if (req.url?.startsWith('/livekit')) {
      (livekitProxy as any).upgrade(req, socket, head);
    }
  });

  httpServer.keepAliveTimeout = Number(process.env.HTTP_KEEPALIVE_TIMEOUT_MS) || 61_000;
  httpServer.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS) || 65_000;
  httpServer.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 300_000;
  console.log(`FAPOMS API running on http://localhost:${port}`);
  if (docsEnabled) console.log(`API Documentation: http://localhost:${port}/api/docs`);
  console.log(`Bull Board: http://localhost:${port}/bull-board`);
}

/**
 * Pause local processing of every Bull queue so an API-role replica serves requests
 * without executing background jobs. Local-only: producers (request handlers adding
 * jobs) are unaffected and worker replicas keep processing. Unknown queue names are
 * skipped rather than fatal, so adding or renaming a queue never breaks boot.
 */
async function pauseLocalQueues(app: INestApplication, logger: Logger): Promise<void> {
  for (const name of ALL_QUEUE_NAMES) {
    try {
      const queue = app.get<Queue>(getQueueToken(name), { strict: false });
      if (queue && typeof queue.pause === 'function') {
        await queue.pause(true); // isLocal = true → pause only this worker's processing
      }
    } catch (err: any) {
      logger.warn(`Skipped pausing queue "${name}": ${err?.message ?? err}`);
    }
  }
}

/**
 * A stray promise rejection must not take the process down with it.
 *
 * Node 20 terminates on an unhandled rejection by default. This codebase deliberately runs work
 * fire-and-forget in several places — notification fan-out (`emitSafe`), assayer stats refresh,
 * the socket gateway's region resolution, the outbox fast path — because none of them should be
 * able to fail the request that triggered them. Every one of those guards itself today, but the
 * pattern is one forgotten `.catch()` away from killing an API that is otherwise healthy, and
 * `restart: unless-stopped` would then drop every in-flight request and socket to recover from a
 * background task nobody was waiting on.
 *
 * Logged loudly rather than swallowed: an unhandled rejection is a real defect and must be
 * findable. `uncaughtException` is different — the process state is genuinely unknown after one,
 * so it exits, but only after the reason has been written down.
 */
function installProcessGuards(): void {
  const logger = new Logger('Process');

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error(
      `Unhandled promise rejection — a fire-and-forget task failed without a catch: ${
        reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)
      }`,
    );
  });

  process.on('uncaughtException', (err: Error) => {
    logger.error(`Uncaught exception — exiting so the supervisor restarts a known-good process: ${err.message}`, err.stack);
    process.exit(1);
  });
}

/**
 * Give an outbound TCP connect a full second before Node gives up on an address.
 *
 * Node's "happy eyeballs" (`net.autoSelectFamily`, on by default since v20) tries a host's
 * addresses one after another and abandons each attempt after 250 ms. That is tuned for a
 * laptop next to its router; from the backend container it is too tight for a real Internet
 * round trip. router.project-osrm.org resolves to an A and an AAAA record, and the container has
 * no IPv6 route: when the server's SYN-ACK takes longer than 250 ms to arrive — which it does in
 * bursts on this network — Node drops the IPv4 attempt, the IPv6 attempt fails instantly, and
 * fetch() reports ETIMEDOUT after ~265 ms with a healthy server on the other end. Measured from
 * inside the container on 2026-08-17, 15 fetches per run, runs alternated: default 250 ms →
 * 23 of 90 failed, including one run of 15/15; 1000 ms → 0 of 90. `--dns-result-order=ipv4first`
 * did not help (the A record was already first; the attempt still timed out), and turning
 * autoselect off cured the connect failures but forfeits the fallback where IPv6 does work.
 *
 * Process-wide: S3/MinIO, the geocoders and FCM connect through the same code path, and none
 * of them is hurt by waiting up to a second for a first address that is not answering. Only
 * ever raised — an operator who set `--network-family-autoselection-attempt-timeout` higher in
 * NODE_OPTIONS keeps their value. The OSRM provider additionally retries one fast connect
 * failure (see routing.provider.ts `fetchJson`), which covers what a single late SYN-ACK still
 * costs under load.
 */
function tuneOutboundConnectTimeout(): void {
  const target = 1000;
  if (typeof net.getDefaultAutoSelectFamilyAttemptTimeout === 'function' &&
      net.getDefaultAutoSelectFamilyAttemptTimeout() < target) {
    net.setDefaultAutoSelectFamilyAttemptTimeout(target);
  }
}

// Only start the server when this file is the entry point. Importing it (for example to unit
// test the production-config guard above) must not boot the whole application.
if (require.main === module) {
  tuneOutboundConnectTimeout();
  installProcessGuards();
  bootstrap().catch((err) => {
    // A boot failure must crash loudly, not become a swallowed unhandled rejection.
    console.error('Fatal: application failed to start', err);
    process.exit(1);
  });
}
