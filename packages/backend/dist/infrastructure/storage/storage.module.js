"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const local_storage_service_1 = require("./local-storage.service");
const s3_storage_service_1 = require("./s3-storage.service");
const storageProvider = {
    provide: 'StorageEngine',
    inject: [config_1.ConfigService],
    useFactory: (config) => {
        const driver = config.get('STORAGE_DRIVER', 'local');
        if (driver === 's3') {
            return new s3_storage_service_1.S3StorageService(config);
        }
        return new local_storage_service_1.LocalStorageService();
    },
};
let StorageModule = class StorageModule {
};
exports.StorageModule = StorageModule;
exports.StorageModule = StorageModule = __decorate([
    (0, common_1.Module)({
        providers: [local_storage_service_1.LocalStorageService, s3_storage_service_1.S3StorageService, storageProvider],
        exports: ['StorageEngine', local_storage_service_1.LocalStorageService],
    })
], StorageModule);
//# sourceMappingURL=storage.module.js.map