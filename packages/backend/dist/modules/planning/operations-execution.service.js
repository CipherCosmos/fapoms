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
exports.OperationsExecutionService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const operations_execution_group_entity_1 = require("./operations-execution-group.entity");
const operations_execution_conversation_entity_1 = require("./operations-execution-conversation.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
let OperationsExecutionService = class OperationsExecutionService {
    groupRepository;
    conversationRepository;
    assignmentRepository;
    constructor(groupRepository, conversationRepository, assignmentRepository) {
        this.groupRepository = groupRepository;
        this.conversationRepository = conversationRepository;
        this.assignmentRepository = assignmentRepository;
    }
    async packageAssignments(dto) {
        if (dto.assignmentIds.length === 0) {
            throw new common_1.BadRequestException('At least one assignment ID must be provided to create a package.');
        }
        let group = this.groupRepository.create({
            assayerId: dto.assayerId,
            name: dto.name || 'Execution Package Route',
            status: operations_execution_group_entity_1.ExecutionGroupStatus.DRAFT,
            logisticsPreferences: dto.logisticsPreferences || {},
        });
        group = await this.groupRepository.save(group);
        for (const aid of dto.assignmentIds) {
            const assignment = await this.assignmentRepository.findOne({ where: { id: aid } });
            if (assignment) {
                assignment.executionGroupId = group.id;
                await this.assignmentRepository.save(assignment);
            }
        }
        return this.groupRepository.findOne({ where: { id: group.id }, relations: ['assignments'] });
    }
    async postConversationMessage(groupId, sender, message, feeOverride, dateOverride) {
        const group = await this.groupRepository.findOne({ where: { id: groupId } });
        if (!group) {
            throw new common_1.NotFoundException(`Execution group ${groupId} not found.`);
        }
        const msg = this.conversationRepository.create({
            groupId,
            sender,
            message,
            proposedFeeOverride: feeOverride || null,
            proposedDateOverride: dateOverride || null,
        });
        await this.conversationRepository.save(msg);
        if (sender === operations_execution_conversation_entity_1.NegotiationParticipant.ASSAYER) {
            group.status = operations_execution_group_entity_1.ExecutionGroupStatus.DISPATCHED;
            await this.groupRepository.save(group);
        }
        return msg;
    }
    async evaluateOperationalReadiness(groupId) {
        const group = await this.groupRepository.findOne({ where: { id: groupId }, relations: ['assignments'] });
        if (!group) {
            throw new common_1.NotFoundException(`Execution group ${groupId} not found.`);
        }
        const checks = {
            assayerConfirmed: group.status === operations_execution_group_entity_1.ExecutionGroupStatus.CONFIRMED || group.status === operations_execution_group_entity_1.ExecutionGroupStatus.READY,
            hasAssignments: group.assignments && group.assignments.length > 0,
            commercialApproved: group.totalFee !== null,
        };
        const isReady = Object.values(checks).every((v) => v === true);
        return {
            isReady,
            checks,
        };
    }
};
exports.OperationsExecutionService = OperationsExecutionService;
exports.OperationsExecutionService = OperationsExecutionService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(operations_execution_group_entity_1.OperationsExecutionGroupEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(operations_execution_conversation_entity_1.OperationsExecutionConversationEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository])
], OperationsExecutionService);
//# sourceMappingURL=operations-execution.service.js.map