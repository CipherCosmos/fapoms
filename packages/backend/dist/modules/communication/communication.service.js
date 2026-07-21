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
exports.CommunicationService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const communication_entity_1 = require("./communication.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let CommunicationService = class CommunicationService {
    communicationRepository;
    assignmentRepository;
    auditService;
    constructor(communicationRepository, assignmentRepository, auditService) {
        this.communicationRepository = communicationRepository;
        this.assignmentRepository = assignmentRepository;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        const assignment = await this.assignmentRepository.findOne({
            where: { id: dto.assignmentId, isActive: true },
        });
        if (!assignment) {
            throw new common_1.NotFoundException(`Assignment ${dto.assignmentId} not found.`);
        }
        const comm = this.communicationRepository.create({
            assignmentId: assignment.id,
            type: dto.type,
            content: dto.content,
            initiatedBy: userId,
            recipientRef: dto.recipientRef ?? null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.communicationRepository.save(comm);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'COMMUNICATION_LOGGED',
            entityType: 'COMMUNICATION',
            entityId: saved.id,
            userId,
            remarks: `Logged ${dto.type} communication for assignment ${assignment.assignmentNumber}.`,
        });
        return saved;
    }
    async findByAssignment(assignmentId) {
        return this.communicationRepository.find({
            where: { assignmentId, isActive: true },
            order: { createdAt: 'DESC' },
        });
    }
};
exports.CommunicationService = CommunicationService;
exports.CommunicationService = CommunicationService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(communication_entity_1.CommunicationEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        audit_service_1.AuditService])
], CommunicationService);
//# sourceMappingURL=communication.service.js.map