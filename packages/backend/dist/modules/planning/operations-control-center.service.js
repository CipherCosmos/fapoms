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
exports.OperationsControlCenterService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const operations_task_entity_1 = require("./operations-task.entity");
const operations_exception_entity_1 = require("./operations-exception.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const shared_1 = require("@fapoms/shared");
let OperationsControlCenterService = class OperationsControlCenterService {
    taskRepository;
    exceptionRepository;
    assignmentRepository;
    metricsProvider;
    constructor(taskRepository, exceptionRepository, assignmentRepository, metricsProvider) {
        this.taskRepository = taskRepository;
        this.exceptionRepository = exceptionRepository;
        this.assignmentRepository = assignmentRepository;
        this.metricsProvider = metricsProvider;
    }
    async getDashboardSummary() {
        const totalProjects = await this.metricsProvider.getTotalProjectsCount();
        const activeProjectsCount = await this.metricsProvider.getActiveProjectsCount();
        const assignments = await this.assignmentRepository.find({ where: { isActive: true } });
        const branchCounts = await this.metricsProvider.getProjectBranchCounts();
        const totalPBs = branchCounts.total;
        const deployedPBs = branchCounts.deployed;
        const deploymentPercentage = totalPBs > 0 ? parseFloat(((deployedPBs / totalPBs) * 100).toFixed(1)) : 0;
        const acceptedCount = assignments.filter((a) => a.status === shared_1.AssignmentStatus.ACCEPTED || a.status === shared_1.AssignmentStatus.SCHEDULED).length;
        const totalAssignments = assignments.length;
        const acceptancePercentage = totalAssignments > 0 ? parseFloat(((acceptedCount / totalAssignments) * 100).toFixed(1)) : 0;
        const pendingAssignmentsCount = assignments.filter((a) => a.status === shared_1.AssignmentStatus.CREATED || a.status === shared_1.AssignmentStatus.CONTACT_INITIATED).length;
        const delayedCount = assignments.filter((a) => a.slaStatus === 'BREACHED').length;
        const openTasks = await this.taskRepository.find({ where: { status: operations_task_entity_1.OperationsTaskStatus.OPEN } });
        const criticalTasksCount = openTasks.filter((t) => t.priority === operations_task_entity_1.OperationsTaskPriority.CRITICAL || t.priority === operations_task_entity_1.OperationsTaskPriority.HIGH).length;
        const breachedCounts = {};
        for (const a of assignments) {
            if (a.slaStatus === 'BREACHED') {
                breachedCounts[a.projectId] = (breachedCounts[a.projectId] || 0) + 1;
            }
        }
        const projectsAtRiskCount = await this.metricsProvider.getProjectsAtRiskCount(breachedCounts);
        return {
            totalProjects,
            activeProjects: activeProjectsCount,
            overallCoveragePercentage: deploymentPercentage,
            overallDeploymentPercentage: deploymentPercentage,
            assignmentAcceptancePercentage: acceptancePercentage,
            pendingAssignmentsCount,
            delayedBranchesCount: delayedCount,
            criticalTasksCount,
            projectsAtRiskCount,
        };
    }
    async createOperationsTask(projectId, title, reason, priority) {
        const task = this.taskRepository.create({
            projectId,
            title,
            reason,
            priority,
            status: operations_task_entity_1.OperationsTaskStatus.OPEN,
        });
        return this.taskRepository.save(task);
    }
    async resolveOperationsTask(taskId, justification) {
        const task = await this.taskRepository.findOne({ where: { id: taskId } });
        if (!task) {
            throw new common_1.NotFoundException(`Operations task ${taskId} not found.`);
        }
        task.status = operations_task_entity_1.OperationsTaskStatus.RESOLVED;
        task.resolutionJustification = justification;
        return this.taskRepository.save(task);
    }
    async flagException(projectId, category, message, targetEntityId) {
        const exc = this.exceptionRepository.create({
            projectId,
            category,
            message,
            targetEntityId: targetEntityId || null,
            status: operations_exception_entity_1.OperationsExceptionStatus.UNRESOLVED,
        });
        return this.exceptionRepository.save(exc);
    }
    async resolveException(exceptionId, justification) {
        const exc = await this.exceptionRepository.findOne({ where: { id: exceptionId } });
        if (!exc) {
            throw new common_1.NotFoundException(`Exception ${exceptionId} not found.`);
        }
        exc.status = operations_exception_entity_1.OperationsExceptionStatus.RESOLVED;
        exc.overrideJustification = justification;
        return this.exceptionRepository.save(exc);
    }
};
exports.OperationsControlCenterService = OperationsControlCenterService;
exports.OperationsControlCenterService = OperationsControlCenterService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(operations_task_entity_1.OperationsTaskEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(operations_exception_entity_1.OperationsExceptionEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __param(3, (0, common_1.Inject)('ProjectMetricsProvider')),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository, Object])
], OperationsControlCenterService);
//# sourceMappingURL=operations-control-center.service.js.map