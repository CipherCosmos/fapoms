/**
 * FAPOMS — Application Entry Point
 */

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { setupBullBoard } from './infrastructure/queue/bull-board.setup';
import { RedisIoAdapter } from './infrastructure/realtime/redis-io.adapter';

import * as express from 'express';
import * as compression from 'compression';
import helmet from 'helmet';

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
  if (!jwtSecret || jwtSecret === 'dev-secret') {
    fatal.push('JWT_SECRET is unset or still the development default. Every access token would be forgeable by anyone who has read this repository.');
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
  const dbPassword = process.env.DB_PASSWORD;
  if (!dbPassword || ['postgres', 'password', 'fapoms', 'changeme'].includes(dbPassword)) {
    fatal.push('DB_PASSWORD is unset or a well-known default.');
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
    try {
      const redisIoAdapter = new RedisIoAdapter(app);
      await redisIoAdapter.connectToRedis();
      app.useWebSocketAdapter(redisIoAdapter);
    } catch (err: any) {
      logger.warn(
        `Redis Socket.IO adapter unavailable (${err?.message}); falling back to single-node in-memory adapter. Do not run more than one replica in this state.`,
      );
    }
  }

  // Close DB pools, Redis clients, Bull queues and open sockets cleanly on SIGTERM/
  // SIGINT so rolling deploys and autoscaling drain in-flight work instead of
  // dropping connections mid-request.
  app.enableShutdownHooks();

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

  // Payload limit. Large scans should go through the resumable chunked upload endpoints
  // rather than a single body, but this ceiling still covers legacy single-shot uploads.
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Global prefix for all API routes
  app.setGlobalPrefix('api/v1');

  // Global validation pipe — enforces DTO validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
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

  // Swagger API documentation
  const config = new DocumentBuilder()
    .setTitle('FAPOMS API')
    .setDescription('Field Audit Planning & Operations Management System')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  if (process.env.NODE_ENV !== 'test') {
    setupBullBoard(app);
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`FAPOMS API running on http://localhost:${port}`);
  console.log(`API Documentation: http://localhost:${port}/api/docs`);
  console.log(`Bull Board: http://localhost:${port}/bull-board`);
}

// Only start the server when this file is the entry point. Importing it (for example to unit
// test the production-config guard above) must not boot the whole application.
if (require.main === module) {
  bootstrap();
}
