"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchedulingModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const scheduling_service_1 = require("./scheduling.service");
const scheduling_controller_1 = require("./scheduling.controller");
const schedule_entity_1 = require("./schedule.entity");
const holiday_module_1 = require("../holiday/holiday.module");
const assignment_module_1 = require("../assignment/assignment.module");
const planning_module_1 = require("../planning/planning.module");
let SchedulingModule = class SchedulingModule {
};
exports.SchedulingModule = SchedulingModule;
exports.SchedulingModule = SchedulingModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([schedule_entity_1.ScheduleEntity]),
            holiday_module_1.HolidayModule,
            assignment_module_1.AssignmentModule,
            planning_module_1.PlanningModule,
        ],
        controllers: [scheduling_controller_1.SchedulingController],
        providers: [scheduling_service_1.SchedulingService],
        exports: [scheduling_service_1.SchedulingService],
    })
], SchedulingModule);
//# sourceMappingURL=scheduling.module.js.map