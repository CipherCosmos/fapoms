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
var DayPlannerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DayPlannerService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const project_branch_entity_1 = require("../project/project-branch.entity");
const project_entity_1 = require("../project/project.entity");
const branch_entity_1 = require("../branch/branch.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
const assayer_service_1 = require("../assayer/assayer.service");
const client_entity_1 = require("../client/client.entity");
const assayer_commercial_profile_entity_1 = require("../assayer/assayer-commercial-profile.entity");
const routing_provider_1 = require("../geo/routing.provider");
const recommendation_engine_1 = require("./recommendation.engine");
const constraint_evaluator_1 = require("./constraint.evaluator");
const shared_1 = require("@fapoms/shared");
const MAX_DAILY_WORK_HOURS = 10;
const DAY_START_HOUR = 9;
const CLUSTER_RADIUS_KM = 80;
const TRAVEL_FEE_PER_KM = 8;
let DayPlannerService = DayPlannerService_1 = class DayPlannerService {
    projectBranchRepository;
    projectRepository;
    branchRepository;
    assayerRepository;
    clientRepository;
    commercialRepository;
    routingService;
    recommendationEngine;
    constraintEvaluator;
    assayerService;
    logger = new common_1.Logger(DayPlannerService_1.name);
    constructor(projectBranchRepository, projectRepository, branchRepository, assayerRepository, clientRepository, commercialRepository, routingService, recommendationEngine, constraintEvaluator, assayerService) {
        this.projectBranchRepository = projectBranchRepository;
        this.projectRepository = projectRepository;
        this.branchRepository = branchRepository;
        this.assayerRepository = assayerRepository;
        this.clientRepository = clientRepository;
        this.commercialRepository = commercialRepository;
        this.routingService = routingService;
        this.recommendationEngine = recommendationEngine;
        this.constraintEvaluator = constraintEvaluator;
        this.assayerService = assayerService;
    }
    async generateDayPlans(projectId, targetDate) {
        const project = await this.projectRepository.findOne({ where: { id: projectId } });
        if (!project)
            throw new common_1.NotFoundException(`Project ${projectId} not found.`);
        const client = project.clientId
            ? await this.clientRepository.findOne({ where: { id: project.clientId }, relations: ['configuration'] })
            : null;
        const scheduledDate = targetDate ? new Date(targetDate) : new Date();
        const dateStr = scheduledDate.toISOString().split('T')[0];
        const projectBranches = await this.projectBranchRepository.find({
            where: { projectId, isActive: true },
            relations: ['branch'],
        });
        const unassigned = projectBranches.filter((pb) => pb.status === 'IMPORTED' || pb.status === 'PLANNING' || pb.status === 'CANDIDATE_SEARCH');
        if (unassigned.length === 0) {
            return this.emptyPlan(projectId, project.name, dateStr);
        }
        const clusters = this.clusterBranches(unassigned);
        const assayers = await this.assayerRepository.find({
            where: { isActive: true, status: 'ACTIVE' },
        });
        await this.assayerService.hydrateAllWorkforceAttributes(assayers);
        const clusterResults = [];
        const unclusteredBranches = [];
        for (const cluster of clusters) {
            if (!cluster.feasibleForOneDay) {
                for (const b of cluster.branches) {
                    unclusteredBranches.push({
                        branchId: b.branchId,
                        branchName: b.branchName,
                        reason: `Cluster total audit time (${cluster.totalEstimatedAuditHours.toFixed(1)}h) exceeds daily capacity (${MAX_DAILY_WORK_HOURS}h)`,
                    });
                }
                continue;
            }
            if (cluster.branches.length <= 1)
                continue;
            let dayPlans = await this.generateClusterDayPlans(cluster, assayers, client, scheduledDate);
            if (dayPlans.length === 0) {
                dayPlans = await this.generateClusterDayPlans(cluster, assayers, client, scheduledDate, true);
            }
            const bestPlan = dayPlans.length > 0 ? dayPlans[0] : null;
            clusterResults.push({
                cluster,
                dayPlans: dayPlans.slice(0, 5),
                bestPlan,
            });
        }
        this.globalOptimizeAssignments(clusterResults);
        const bestPlans = clusterResults.filter((r) => r.bestPlan).map((r) => r.bestPlan);
        const uniqueAssayers = new Set(bestPlans.map((p) => p.assayerId));
        const summary = {
            totalClusters: clusterResults.length,
            totalBranchesCovered: bestPlans.reduce((sum, p) => sum + p.totalBranches, 0),
            totalAssayersNeeded: uniqueAssayers.size,
            estimatedTotalCost: bestPlans.reduce((sum, p) => sum + p.estimatedTotalCost, 0),
            averageUtilization: bestPlans.length > 0
                ? bestPlans.reduce((sum, p) => sum + p.utilizationPercent, 0) / bestPlans.length
                : 0,
        };
        return {
            projectId,
            projectName: project.name,
            targetDate: dateStr,
            clusters: clusterResults,
            unclusteredBranches,
            summary,
        };
    }
    clusterBranches(projectBranches) {
        const branchesWithCoords = projectBranches
            .filter((pb) => pb.branch?.latitude && pb.branch?.longitude)
            .map((pb) => ({
            id: pb.id,
            branchId: pb.branchId,
            branchName: pb.branch.name,
            branchCode: pb.branch.branchCode,
            latitude: Number(pb.branch.latitude),
            longitude: Number(pb.branch.longitude),
            packetCount: pb.packetCount || 40,
            estimatedDurationHours: Number(pb.branch.estimatedDurationHours) || 4,
            district: pb.branch.district,
            city: pb.branch.city,
        }))
            .sort((a, b) => b.packetCount - a.packetCount);
        const visited = new Set();
        const clusters = [];
        let clusterIdx = 0;
        for (const branch of branchesWithCoords) {
            if (visited.has(branch.id))
                continue;
            const clusterMembers = [branch];
            visited.add(branch.id);
            let expanded = true;
            while (expanded) {
                expanded = false;
                for (const other of branchesWithCoords) {
                    if (visited.has(other.id))
                        continue;
                    const nearAny = clusterMembers.some((m) => (0, shared_1.calculateHaversineDistance)(m.latitude, m.longitude, other.latitude, other.longitude) <= CLUSTER_RADIUS_KM);
                    if (nearAny) {
                        clusterMembers.push(other);
                        visited.add(other.id);
                        expanded = true;
                    }
                }
            }
            const totalAuditHours = clusterMembers.reduce((sum, b) => sum + b.estimatedDurationHours, 0);
            if (totalAuditHours <= MAX_DAILY_WORK_HOURS) {
                clusters.push(this.buildCluster(clusterMembers, clusterIdx));
                clusterIdx++;
            }
            else {
                const subClusters = this.splitInfeasibleCluster(clusterMembers);
                for (const sub of subClusters) {
                    clusters.push(this.buildCluster(sub, clusterIdx));
                    clusterIdx++;
                }
            }
        }
        return clusters;
    }
    buildCluster(members, index) {
        const totalAuditHours = members.reduce((sum, b) => sum + b.estimatedDurationHours, 0);
        const centerLat = members.reduce((s, b) => s + b.latitude, 0) / members.length;
        const centerLng = members.reduce((s, b) => s + b.longitude, 0) / members.length;
        const maxDist = Math.max(...members.map((b) => (0, shared_1.calculateHaversineDistance)(centerLat, centerLng, b.latitude, b.longitude)));
        return {
            clusterId: `CLU-${String(index + 1).padStart(3, '0')}`,
            centerLatitude: parseFloat(centerLat.toFixed(4)),
            centerLongitude: parseFloat(centerLng.toFixed(4)),
            radiusKm: parseFloat(maxDist.toFixed(1)),
            branches: members,
            totalEstimatedAuditHours: parseFloat(totalAuditHours.toFixed(1)),
            feasibleForOneDay: totalAuditHours <= MAX_DAILY_WORK_HOURS,
        };
    }
    splitInfeasibleCluster(members) {
        const sorted = [...members].sort((a, b) => b.estimatedDurationHours - a.estimatedDurationHours);
        const subClusters = [];
        for (const branch of sorted) {
            let placed = false;
            for (const sub of subClusters) {
                const currentLoad = sub.reduce((s, b) => s + b.estimatedDurationHours, 0);
                if (currentLoad + branch.estimatedDurationHours <= MAX_DAILY_WORK_HOURS) {
                    sub.push(branch);
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                subClusters.push([branch]);
            }
        }
        return subClusters;
    }
    async generateClusterDayPlans(cluster, assayers, client, scheduledDate, relaxDistance = false) {
        const planningPreferences = client?.planningPreferences || {};
        const requiredSkills = planningPreferences.requiredSkills || [];
        const requiredCerts = planningPreferences.requiredCertifications || [];
        const maxDistKm = relaxDistance ? Infinity : (Number(planningPreferences.maxDistanceKm) || Infinity);
        const candidates = [];
        for (const assayer of assayers) {
            if (!assayer.latitude || !assayer.longitude)
                continue;
            if (client?.restrictedAssayers?.includes(assayer.id))
                continue;
            const assayerSkills = (assayer.skills || []).map((s) => s.toLowerCase());
            if (requiredSkills.length > 0) {
                const hasAll = requiredSkills.every((s) => assayerSkills.includes(s.toLowerCase()));
                if (!hasAll)
                    continue;
            }
            const assayerCerts = (assayer.certifications || []).map((c) => (typeof c === 'string' ? c : c.name || '').toLowerCase());
            if (requiredCerts.length > 0) {
                const hasAll = requiredCerts.every((c) => assayerCerts.includes(c.toLowerCase()));
                if (!hasAll)
                    continue;
            }
            const aLat = assayer.latitude;
            const aLng = assayer.longitude;
            const branchDistances = cluster.branches.map((b) => (0, shared_1.calculateHaversineDistance)(aLat, aLng, b.latitude, b.longitude));
            const maxBranchDist = Math.max(...branchDistances);
            if (maxBranchDist > maxDistKm)
                continue;
            const dbCheck = await this.constraintEvaluator.checkDoubleBooking(assayer.id, scheduledDate);
            if (!dbCheck.passed)
                continue;
            const leaveCheck = this.constraintEvaluator.checkLeaves(assayer, scheduledDate);
            if (!leaveCheck.passed)
                continue;
            const destinations = cluster.branches.map((b) => ({
                id: b.branchId,
                latitude: b.latitude,
                longitude: b.longitude,
            }));
            const routeResult = await this.routingService.optimizeRoute({ latitude: assayer.latitude, longitude: assayer.longitude }, destinations, true);
            let currentMinutes = DAY_START_HOUR * 60;
            const stops = [];
            for (let i = 0; i < routeResult.optimizedSequence.length; i++) {
                const destId = routeResult.optimizedSequence[i];
                const step = routeResult.steps[i];
                const branchData = cluster.branches.find((b) => b.branchId === destId);
                if (!branchData)
                    continue;
                const travelMinutes = step.durationMinutes;
                currentMinutes += travelMinutes;
                const arrivalTime = this.minutesToTime(currentMinutes);
                const auditMinutes = branchData.estimatedDurationHours * 60;
                const departureTime = this.minutesToTime(currentMinutes + auditMinutes);
                stops.push({
                    order: i + 1,
                    branchId: branchData.branchId,
                    branchName: branchData.branchName,
                    branchCode: branchData.branchCode,
                    address: `${branchData.city}, ${branchData.district}`,
                    latitude: branchData.latitude,
                    longitude: branchData.longitude,
                    estimatedAuditHours: branchData.estimatedDurationHours,
                    travelFromPreviousKm: parseFloat(step.distanceKm.toFixed(1)),
                    travelFromPreviousMinutes: parseFloat(step.durationMinutes.toFixed(0)),
                    estimatedArrival: arrivalTime,
                    estimatedDeparture: departureTime,
                });
                currentMinutes += auditMinutes;
            }
            const totalTravelMinutes = routeResult.totalDurationMinutes;
            const totalTravelKm = routeResult.totalDistanceKm;
            const totalAuditHours = cluster.totalEstimatedAuditHours;
            const totalDayHours = totalAuditHours + totalTravelMinutes / 60;
            if (totalDayHours > MAX_DAILY_WORK_HOURS + 2)
                continue;
            const stepMins = routeResult.steps.reduce((s, st) => s + st.durationMinutes, 0);
            const returnTravelMinutes = totalTravelMinutes - stepMins;
            const dayEndMinutes = currentMinutes + Math.max(0, returnTravelMinutes);
            const dayEndTime = this.minutesToTime(dayEndMinutes);
            const profile = await this.commercialRepository.findOne({
                where: { assayerId: assayer.id, isActive: true },
                order: { effectiveStartDate: 'DESC' },
            });
            const baseFee = profile ? Number(profile.baseFee) || 1500 : 1500;
            const travelFee = parseFloat((totalTravelKm * TRAVEL_FEE_PER_KM).toFixed(0));
            const totalCost = baseFee * cluster.branches.length + travelFee;
            let totalScore = 0;
            for (const branch of cluster.branches) {
                const branchEntity = await this.branchRepository.findOne({ where: { id: branch.branchId } });
                if (branchEntity) {
                    const results = await this.recommendationEngine.recommend(branchEntity, scheduledDate);
                    const match = results.find((r) => r.assayer.id === assayer.id);
                    totalScore += match ? match.score : 0;
                }
            }
            const avgScore = cluster.branches.length > 0
                ? parseFloat((totalScore / cluster.branches.length).toFixed(1))
                : 0;
            const utilizationPercent = totalDayHours > 0
                ? parseFloat(((totalAuditHours / totalDayHours) * 100).toFixed(1))
                : 0;
            if (utilizationPercent < 60)
                continue;
            const preferredSkills = planningPreferences.preferredSkills || [];
            const preferredCerts = planningPreferences.preferredCertifications || [];
            candidates.push({
                assayerId: assayer.id,
                assayerName: assayer.displayName,
                assayerCode: assayer.assayerCode,
                assayerCity: assayer.city,
                assayerPhone: assayer.phone,
                overallScore: avgScore,
                totalBranches: cluster.branches.length,
                totalAuditHours: parseFloat(totalAuditHours.toFixed(1)),
                totalTravelKm: parseFloat(totalTravelKm.toFixed(1)),
                totalTravelMinutes: parseFloat(totalTravelMinutes.toFixed(0)),
                totalDayHours: parseFloat(totalDayHours.toFixed(1)),
                estimatedBaseFee: baseFee * cluster.branches.length,
                estimatedTravelFee: travelFee,
                estimatedTotalCost: totalCost,
                dayStartTime: this.minutesToTime(DAY_START_HOUR * 60),
                dayEndTime,
                utilizationPercent,
                stops,
                clientPreferencesMatch: {
                    skillsMatch: requiredSkills.length === 0 || requiredSkills.every((s) => assayerSkills.includes(s.toLowerCase())),
                    certificationsMatch: requiredCerts.length === 0 || requiredCerts.every((c) => assayerCerts.includes(c.toLowerCase())),
                    distanceWithinRange: maxBranchDist >= 0 && maxBranchDist <= maxDistKm,
                    isPreferredAssayer: client?.preferredAssayers?.includes(assayer.id) || false,
                },
            });
        }
        candidates.sort((a, b) => {
            if (b.overallScore !== a.overallScore)
                return b.overallScore - a.overallScore;
            return a.estimatedTotalCost - b.estimatedTotalCost;
        });
        return candidates;
    }
    globalOptimizeAssignments(clusterResults) {
        const n = clusterResults.length;
        const candidates = clusterResults.map((c) => c.dayPlans.filter((p) => p.overallScore > 0));
        const maxRemaining = new Array(n + 1).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            const topScore = candidates[i].length > 0 ? candidates[i][0].overallScore : 0;
            maxRemaining[i] = maxRemaining[i + 1] + topScore;
        }
        let bestScore = -1;
        let bestAssignment = new Array(n).fill(null);
        const dfs = (idx, assigned, currentScore, assignment) => {
            if (currentScore + maxRemaining[idx] <= bestScore)
                return;
            if (idx === n) {
                bestScore = currentScore;
                bestAssignment = [...assignment];
                return;
            }
            for (const plan of candidates[idx]) {
                if (assigned.has(plan.assayerId))
                    continue;
                assigned.add(plan.assayerId);
                assignment.push(plan);
                dfs(idx + 1, assigned, currentScore + plan.overallScore, assignment);
                assignment.pop();
                assigned.delete(plan.assayerId);
            }
            assignment.push(null);
            dfs(idx + 1, assigned, currentScore, assignment);
            assignment.pop();
        };
        dfs(0, new Set(), 0, []);
        for (let i = 0; i < n; i++) {
            clusterResults[i].bestPlan = bestAssignment[i];
        }
    }
    minutesToTime(minutes) {
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes % 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    emptyPlan(projectId, projectName, dateStr) {
        return {
            projectId,
            projectName,
            targetDate: dateStr,
            clusters: [],
            unclusteredBranches: [],
            summary: {
                totalClusters: 0,
                totalBranchesCovered: 0,
                totalAssayersNeeded: 0,
                estimatedTotalCost: 0,
                averageUtilization: 0,
            },
        };
    }
};
exports.DayPlannerService = DayPlannerService;
exports.DayPlannerService = DayPlannerService = DayPlannerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(project_branch_entity_1.ProjectBranchEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(project_entity_1.ProjectEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(branch_entity_1.BranchEntity)),
    __param(3, (0, typeorm_1.InjectRepository)(assayer_entity_1.AssayerEntity)),
    __param(4, (0, typeorm_1.InjectRepository)(client_entity_1.ClientEntity)),
    __param(5, (0, typeorm_1.InjectRepository)(assayer_commercial_profile_entity_1.AssayerCommercialProfileEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        routing_provider_1.RoutingService,
        recommendation_engine_1.RecommendationEngine,
        constraint_evaluator_1.ConstraintEvaluator,
        assayer_service_1.AssayerService])
], DayPlannerService);
//# sourceMappingURL=day-planner.service.js.map