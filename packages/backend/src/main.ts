/**
 * FAPOMS — Application Entry Point
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { setupBullBoard } from './infrastructure/queue/bull-board.setup';

async function bootstrap() {
  const nodeEnv = process.env.NODE_ENV;
  const jwtSecret = process.env.JWT_SECRET;
  if (nodeEnv === 'production' && (!jwtSecret || jwtSecret === 'dev-secret')) {
    throw new Error('CRITICAL: JWT_SECRET must be set to a secure key in production environments!');
  }

  const app = await NestFactory.create(AppModule);

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

  // CORS configuration — allows frontend web (5173) and mobile app (8081)
  app.enableCors({
    origin: ['http://localhost:5173', 'http://localhost:8081', 'http://localhost:19006'],
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
