"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssayerModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const assayer_entity_1 = require("./assayer.entity");
const assayer_service_1 = require("./assayer.service");
const assayer_controller_1 = require("./assayer.controller");
let AssayerModule = class AssayerModule {
};
exports.AssayerModule = AssayerModule;
exports.AssayerModule = AssayerModule = __decorate([
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([assayer_entity_1.AssayerEntity])],
        controllers: [assayer_controller_1.AssayerController],
        providers: [assayer_service_1.AssayerService],
        exports: [assayer_service_1.AssayerService],
    })
], AssayerModule);
//# sourceMappingURL=assayer.module.js.map