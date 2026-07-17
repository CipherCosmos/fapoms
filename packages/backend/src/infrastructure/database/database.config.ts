/**
 * FAPOMS — Database Configuration
 *
 * PostgreSQL connection factory for TypeORM.
 * Reads configuration from environment variables.
 */

import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const databaseConfig = (
  configService: ConfigService,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get<string>('DB_HOST', 'localhost'),
  port: configService.get<number>('DB_PORT', 5432),
  username: configService.get<string>('DB_USERNAME', 'fapoms'),
  password: configService.get<string>('DB_PASSWORD', 'fapoms_dev'),
  database: configService.get<string>('DB_DATABASE', 'fapoms'),
  autoLoadEntities: true,
  synchronize: configService.get<boolean>('DB_SYNCHRONIZE', false),
  logging: configService.get<string>('DB_LOGGING', 'false') === 'true',
  // Connection pool settings for enterprise workloads
  extra: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },
});
