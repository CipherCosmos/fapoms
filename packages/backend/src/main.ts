/**
 * FAPOMS — Application Entry Point
 */

import { NestFactory } from '@nestjs/core';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bull';
import type { Queue } from 'bull';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { setupBullBoard } from './infrastructure/queue/bull-board.setup';
import { RedisIoAdapter } from './infrastructure/realtime/redis-io.adapter';
import { realtimeHealth } from './infrastructure/realtime/realtime-health';
import { correlationIdMiddleware } from './infrastructure/http/correlation-id.middleware';
import { GlobalExceptionFilter } from './infrastructure/http/global-exception.filter';
import { ResponseInterceptor } from './infrastructure/http/response.interceptor';
import { TrimStringsPipe } from './infrastructure/http/trim-strings.pipe';
import { Reflector } from '@nestjs/core';

/**
 * Every Bull queue in the system. Used only to pause local processing on API-role
 * replicas; unknown names are skipped rather than fatal (see pauseLocalQueues).
 */
const ALL_QUEUE_NAMES = [
  'background-jobs',
  'ocr',
  'sla-scanner',
  'document-dispatch',
  'notification-delivery',
  'outbox',
];

import * as express from 'express';
import * as compression from 'compression';
import helmet from 'helmet';
import { createProxyMiddleware } from 'http-proxy-middleware';

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

  if (!process.env.CORS_ORIGINS) {
    fatal.push('CORS_ORIGINS is unset, so the API would fall back to localhost development origins and reject the real frontend.');
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

  if (fatal.length > 0) {
    throw new Error(
      `Refusing to start in production with unsafe configuration:\n  - ${fatal.join('\n  - ')}`,
    );
  }
}

async function bootstrap() {
  assertProductionSafeConfig();

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

  if (processRole === 'worker') {
    // Dedicated worker: runs Bull processors + scheduled crons, serves no HTTP, so
    // heavy jobs (OCR, dispatch, SLA sweeps, notification delivery) never contend
    // with request handling. init() runs the module lifecycle hooks that register
    // the processors and repeatable jobs.
    await app.init();
    logger.log('PROCESS_ROLE=worker — processing background jobs and schedules; not serving HTTP.');
    return;
  }

  // Correlation id first — before anything can fail — so every request (including one that
  // errors before it reaches a handler) carries an id the exception filter and logs share.
  app.use(correlationIdMiddleware);

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
  app.useGlobalPipes(
    new TrimStringsPipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
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
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));

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

// Only start the server when this file is the entry point. Importing it (for example to unit
// test the production-config guard above) must not boot the whole application.
if (require.main === module) {
  bootstrap().catch((err) => {
    // A boot failure must crash loudly, not become a swallowed unhandled rejection.
    console.error('Fatal: application failed to start', err);
    process.exit(1);
  });
}
