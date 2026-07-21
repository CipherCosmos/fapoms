"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppDataSource = void 0;
const typeorm_1 = require("typeorm");
const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.join(process.cwd(), '.env') });
dotenv.config({ path: path.join(process.cwd(), '.env.local') });
exports.AppDataSource = new typeorm_1.DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'fapoms',
    password: process.env.DB_PASSWORD || 'fapoms_dev',
    database: process.env.DB_DATABASE || 'fapoms',
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
    logging: process.env.DB_LOGGING === 'true',
    entities: [path.join(process.cwd(), 'dist/**/*.entity.js'), path.join(process.cwd(), 'dist/modules/**/*.entities.js')],
    migrations: [path.join(process.cwd(), 'dist/infrastructure/database/migrations/*.js')],
    subscribers: [],
});
//# sourceMappingURL=data-source.js.map