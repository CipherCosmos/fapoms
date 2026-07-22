import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), '.env') });
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'fapoms',
  password: process.env.DB_PASSWORD || 'fapoms_dev',
  database: process.env.DB_DATABASE || 'fapoms',
  synchronize: process.env.DB_SYNCHRONIZE === 'true',
  logging: process.env.DB_LOGGING === 'true',
  entities: [
    path.join(process.cwd(), 'src/**/*.entity.ts'),
    path.join(process.cwd(), 'src/modules/**/*.entities.ts'),
    path.join(process.cwd(), 'dist/**/*.entity.js'),
    path.join(process.cwd(), 'dist/modules/**/*.entities.js')
  ],
  migrations: [
    path.join(process.cwd(), 'src/infrastructure/database/migrations/*.ts'),
    path.join(process.cwd(), 'dist/infrastructure/database/migrations/*.js')
  ],
  subscribers: [],
});
