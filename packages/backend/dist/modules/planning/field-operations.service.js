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
exports.FieldOperationsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const field_visit_entity_1 = require("./field-visit.entity");
const field_incident_entity_1 = require("./field-incident.entity");
let FieldOperationsService = class FieldOperationsService {
    visitRepository;
    incidentRepository;
    constructor(visitRepository, incidentRepository) {
        this.visitRepository = visitRepository;
        this.incidentRepository = incidentRepository;
    }
    async createFieldVisit(coveragePlanId, executionGroupId, branchId, assayerId, plannedDate) {
        const visit = this.visitRepository.create({
            coveragePlanId,
            executionGroupId,
            branchId,
            assayerId,
            plannedDate,
            status: field_visit_entity_1.FieldVisitStatus.READY,
            evidenceReadiness: {
                documentsCollected: false,
                photosCollected: false,
                formsCompleted: false,
                missingEvidenceList: ['Mandatory Form 1A', 'Store Front Photo'],
            },
        });
        return this.visitRepository.save(visit);
    }
    async transitionVisitStatus(visitId, targetStatus) {
        const visit = await this.visitRepository.findOne({ where: { id: visitId } });
        if (!visit) {
            throw new common_1.NotFoundException(`Field visit ${visitId} not found.`);
        }
        if (targetStatus === field_visit_entity_1.FieldVisitStatus.AUDIT_STARTED) {
            visit.actualStartTime = new Date();
        }
        else if (targetStatus === field_visit_entity_1.FieldVisitStatus.AUDIT_COMPLETED) {
            visit.actualEndTime = new Date();
        }
        visit.status = targetStatus;
        return this.visitRepository.save(visit);
    }
    async reportIncident(visitId, title, description, severity) {
        const visit = await this.visitRepository.findOne({ where: { id: visitId } });
        if (!visit) {
            throw new common_1.NotFoundException(`Field visit ${visitId} not found.`);
        }
        const incident = this.incidentRepository.create({
            visitId,
            title,
            description,
            severity,
            status: field_incident_entity_1.IncidentStatus.REPORTED,
        });
        return this.incidentRepository.save(incident);
    }
    async resolveIncident(incidentId, details) {
        const incident = await this.incidentRepository.findOne({ where: { id: incidentId } });
        if (!incident) {
            throw new common_1.NotFoundException(`Incident ${incidentId} not found.`);
        }
        incident.status = field_incident_entity_1.IncidentStatus.RESOLVED;
        incident.resolutionDetails = details;
        return this.incidentRepository.save(incident);
    }
    async generateHandoverPackage(visitId) {
        const visit = await this.visitRepository.findOne({ where: { id: visitId } });
        if (!visit) {
            throw new common_1.NotFoundException(`Field visit ${visitId} not found.`);
        }
        if (visit.status !== field_visit_entity_1.FieldVisitStatus.SUBMITTED && visit.status !== field_visit_entity_1.FieldVisitStatus.HANDOVER_READY) {
            throw new common_1.BadRequestException('Handover package can only be built for completed/submitted visits.');
        }
        return {
            visitId: visit.id,
            branchId: visit.branchId,
            assayerId: visit.assayerId,
            timestamp: new Date().toISOString(),
            evidenceMetadata: {
                hasFormPayload: visit.evidenceReadiness.formsCompleted,
                totalImageAttachments: visit.evidenceReadiness.photosCollected ? 3 : 0,
            },
            ocrDeliveryTarget: `/ocr-processing/incoming/${visit.id}`,
        };
    }
    async getFieldOperationsDashboard(coveragePlanId) {
        const visits = await this.visitRepository.find({ where: { coveragePlanId } });
        const incidents = await this.incidentRepository.find();
        const inProgress = visits.filter((v) => v.status === field_visit_entity_1.FieldVisitStatus.AUDIT_STARTED || v.status === field_visit_entity_1.FieldVisitStatus.EVIDENCE_COLLECTION).length;
        const completed = visits.filter((v) => v.status === field_visit_entity_1.FieldVisitStatus.AUDIT_COMPLETED || v.status === field_visit_entity_1.FieldVisitStatus.SUBMITTED || v.status === field_visit_entity_1.FieldVisitStatus.HANDOVER_READY).length;
        const totalCount = visits.length;
        const completionPercentage = totalCount > 0 ? parseFloat(((completed / totalCount) * 100).toFixed(1)) : 0;
        const activeIncidents = incidents.filter((i) => i.status !== field_incident_entity_1.IncidentStatus.RESOLVED);
        const criticalIncidents = activeIncidents.filter((i) => i.severity === field_incident_entity_1.IncidentSeverity.CRITICAL || i.severity === field_incident_entity_1.IncidentSeverity.HIGH);
        return {
            visitsInProgress: inProgress,
            visitsDelayed: 0,
            awaitingSubmission: visits.filter((v) => v.status === field_visit_entity_1.FieldVisitStatus.AUDIT_COMPLETED).length,
            awaitingEvidence: visits.filter((v) => !v.evidenceReadiness.documentsCollected).length,
            activeIncidentsCount: activeIncidents.length,
            criticalIncidentsCount: criticalIncidents.length,
            completionPercentage,
        };
    }
};
exports.FieldOperationsService = FieldOperationsService;
exports.FieldOperationsService = FieldOperationsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(field_visit_entity_1.FieldVisitEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(field_incident_entity_1.FieldIncidentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository])
], FieldOperationsService);
//# sourceMappingURL=field-operations.service.js.map