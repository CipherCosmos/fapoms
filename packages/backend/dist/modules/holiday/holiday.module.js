"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HolidayModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const holiday_entity_1 = require("./holiday.entity");
const holiday_service_1 = require("./holiday.service");
const holiday_controller_1 = require("./holiday.controller");
let HolidayModule = class HolidayModule {
};
exports.HolidayModule = HolidayModule;
exports.HolidayModule = HolidayModule = __decorate([
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([holiday_entity_1.HolidayEntity])],
        controllers: [holiday_controller_1.HolidayController],
        providers: [holiday_service_1.HolidayService],
        exports: [holiday_service_1.HolidayService],
    })
], HolidayModule);
//# sourceMappingURL=holiday.module.js.map