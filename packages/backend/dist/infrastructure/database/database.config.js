"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseConfig = void 0;
const databaseConfig = (configService) => ({
    type: 'postgres',
    host: configService.get('DB_HOST', 'localhost'),
    port: configService.get('DB_PORT', 5432),
    username: configService.get('DB_USERNAME', 'fapoms'),
    password: configService.get('DB_PASSWORD', 'fapoms_dev'),
    database: configService.get('DB_DATABASE', 'fapoms'),
    autoLoadEntities: true,
    synchronize: configService.get('DB_SYNCHRONIZE', false),
    logging: configService.get('DB_LOGGING', 'false') === 'true',
    extra: {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    },
});
exports.databaseConfig = databaseConfig;
//# sourceMappingURL=database.config.js.map