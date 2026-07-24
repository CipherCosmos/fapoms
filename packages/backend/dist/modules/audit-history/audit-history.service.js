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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditHistoryService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const audit_history_entity_1 = require("./audit-history.entity");
const audit_evidence_entity_1 = require("./audit-evidence.entity");
let AuditHistoryService = class AuditHistoryService {
    historyRepository;
    evidenceRepository;
    constructor(historyRepository, evidenceRepository) {
        this.historyRepository = historyRepository;
        this.evidenceRepository = evidenceRepository;
    }
    async createRecord(dto) {
        const record = this.historyRepository.create(dto);
        return this.historyRepository.save(record);
    }
    async addEvidence(dto) {
        const evidence = this.evidenceRepository.create(dto);
        return this.evidenceRepository.save(evidence);
    }
    async getAssayerAudits(assayerId) {
        return this.historyRepository.find({ where: { assayerId } });
    }
    async getAuditEvidence(auditId) {
        return this.evidenceRepository.find({ where: { auditId } });
    }
};
exports.AuditHistoryService = AuditHistoryService;
exports.AuditHistoryService = AuditHistoryService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(audit_history_entity_1.AuditHistoryRecord)),
    __param(1, (0, typeorm_1.InjectRepository)(audit_evidence_entity_1.AuditEvidence)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository])
], AuditHistoryService);
//# sourceMappingURL=audit-history.service.js.map