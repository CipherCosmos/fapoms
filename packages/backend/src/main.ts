/**
 * FAPOMS — Application Entry Point
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

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

  // CORS configuration
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
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

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`FAPOMS API running on http://localhost:${port}`);
  console.log(`API Documentation: http://localhost:${port}/api/docs`);
}

bootstrap();
