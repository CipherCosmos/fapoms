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
exports.WorkflowEngine = void 0;
const common_1 = require("@nestjs/common");
const audit_service_1 = require("../../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let WorkflowEngine = class WorkflowEngine {
    auditService;
    registries = new Map();
    constructor(auditService) {
        this.auditService = auditService;
    }
    registerWorkflow(workflowKey, transitions) {
        this.registries.set(workflowKey, transitions);
    }
    async canTransition(workflowKey, fromState, toState, context) {
        const transitions = this.registries.get(workflowKey);
        if (!transitions)
            return false;
        const matched = transitions.find((t) => t.from.includes(fromState) && t.to === toState);
        if (!matched)
            return false;
        if (matched.guards) {
            for (const guard of matched.guards) {
                const ok = await guard(context);
                if (!ok)
                    return false;
            }
        }
        return true;
    }
    async executeTransition(workflowKey, entityId, fromState, toState, context) {
        const transitions = this.registries.get(workflowKey);
        if (!transitions) {
            throw new common_1.BadRequestException(`No transitions registered for workflow: ${workflowKey}`);
        }
        const matched = transitions.find((t) => t.from.includes(fromState) && t.to === toState);
        if (!matched) {
            throw new common_1.BadRequestException(`Invalid transition path from '${fromState}' to '${toState}' for workflow ${workflowKey}`);
        }
        if (matched.guards) {
            for (const guard of matched.guards) {
                const ok = await guard(context);
                if (!ok) {
                    throw new common_1.BadRequestException(`Transition guards failed from '${fromState}' to '${toState}'`);
                }
            }
        }
        if (matched.beforeTransition) {
            await matched.beforeTransition(context);
        }
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'WORKFLOW_TRANSITION',
            entityType: workflowKey.toUpperCase(),
            entityId,
            userId: context.userId,
            remarks: `Transitioned '${workflowKey}' ${entityId} from ${fromState} -> ${toState}`,
        });
        if (matched.afterTransition) {
            await matched.afterTransition(context);
        }
    }
};
exports.WorkflowEngine = WorkflowEngine;
exports.WorkflowEngine = WorkflowEngine = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [audit_service_1.AuditService])
], WorkflowEngine);
//# sourceMappingURL=workflow.engine.js.map