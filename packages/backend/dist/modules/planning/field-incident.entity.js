"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FieldIncidentEntity = exports.IncidentStatus = exports.IncidentSeverity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
var IncidentSeverity;
(function (IncidentSeverity) {
    IncidentSeverity["LOW"] = "LOW";
    IncidentSeverity["MEDIUM"] = "MEDIUM";
    IncidentSeverity["HIGH"] = "HIGH";
    IncidentSeverity["CRITICAL"] = "CRITICAL";
})(IncidentSeverity || (exports.IncidentSeverity = IncidentSeverity = {}));
var IncidentStatus;
(function (IncidentStatus) {
    IncidentStatus["REPORTED"] = "REPORTED";
    IncidentStatus["INVESTIGATING"] = "INVESTIGATING";
    IncidentStatus["RESOLVED"] = "RESOLVED";
    IncidentStatus["ESCALATED"] = "ESCALATED";
})(IncidentStatus || (exports.IncidentStatus = IncidentStatus = {}));
let FieldIncidentEntity = class FieldIncidentEntity extends base_entity_1.BaseEntity {
    visitId;
    title;
    description;
    severity;
    status;
    resolutionDetails;
};
exports.FieldIncidentEntity = FieldIncidentEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'visit_id', type: 'uuid' }),
    __metadata("design:type", String)
], FieldIncidentEntity.prototype, "visitId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], FieldIncidentEntity.prototype, "title", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], FieldIncidentEntity.prototype, "description", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: IncidentSeverity,
        default: IncidentSeverity.MEDIUM,
    }),
    __metadata("design:type", String)
], FieldIncidentEntity.prototype, "severity", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: IncidentStatus,
        default: IncidentStatus.REPORTED,
    }),
    __metadata("design:type", String)
], FieldIncidentEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], FieldIncidentEntity.prototype, "resolutionDetails", void 0);
exports.FieldIncidentEntity = FieldIncidentEntity = __decorate([
    (0, typeorm_1.Entity)('operations_field_incidents'),
    (0, typeorm_1.Index)(['visitId']),
    (0, typeorm_1.Index)(['status'])
], FieldIncidentEntity);
//# sourceMappingURL=field-incident.entity.js.map