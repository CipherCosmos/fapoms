/**
 * FAPOMS — Application Entry Point
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { setupBullBoard } from './infrastructure/queue/bull-board.setup';

import * as express from 'express';
import * as compression from 'compression';

async function bootstrap() {
  const nodeEnv = process.env.NODE_ENV;
  const jwtSecret = process.env.JWT_SECRET;
  if (nodeEnv === 'production' && (!jwtSecret || jwtSecret === 'dev-secret')) {
    throw new Error('CRITICAL: JWT_SECRET must be set to a secure key in production environments!');
  }

  const app = await NestFactory.create(AppModule);

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

bootstrap();
