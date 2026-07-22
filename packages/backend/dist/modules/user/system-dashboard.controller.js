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
exports.SystemDashboardController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
let SystemDashboardController = class SystemDashboardController {
    dataSource;
    constructor(dataSource) {
        this.dataSource = dataSource;
    }
    async getMetrics() {
        const clientsCount = await this.dataSource.query('SELECT COUNT(*) AS count FROM clients WHERE is_active = true');
        const projectsCount = await this.dataSource.query('SELECT COUNT(*) AS count FROM projects WHERE is_active = true');
        const activeProjectsCount = await this.dataSource.query("SELECT COUNT(*) AS count FROM projects WHERE is_active = true AND status = 'EXECUTION'");
        const branchesCount = await this.dataSource.query('SELECT COUNT(*) AS count FROM branches WHERE is_active = true');
        const activeBranchesCount = await this.dataSource.query("SELECT COUNT(*) AS count FROM project_branches WHERE is_active = true AND status = 'ASSIGNMENT_CONFIRMED'");
        const usersCount = await this.dataSource.query('SELECT COUNT(*) AS count FROM users WHERE is_active = true');
        const recentActivities = await this.dataSource.query(`
      SELECT id, event_type AS action, remarks AS detail, occurred_at AS "occurredAt"
      FROM audit_events
      ORDER BY occurred_at DESC
      LIMIT 10
    `);
        return {
            success: true,
            data: {
                clients: Number(clientsCount[0]?.count || 0),
                projects: Number(projectsCount[0]?.count || 0),
                activeProjects: Number(activeProjectsCount[0]?.count || 0),
                branches: Number(branchesCount[0]?.count || 0),
                activeBranches: Number(activeBranchesCount[0]?.count || 0),
                users: Number(usersCount[0]?.count || 0),
                activities: recentActivities,
            },
        };
    }
};
exports.SystemDashboardController = SystemDashboardController;
__decorate([
    (0, common_1.Get)('metrics'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Retrieve live aggregated system counts and event history metrics' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SystemDashboardController.prototype, "getMetrics", null);
exports.SystemDashboardController = SystemDashboardController = __decorate([
    (0, swagger_1.ApiTags)('System Dashboard'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard),
    (0, common_1.Controller)('system-dashboard'),
    __param(0, (0, typeorm_1.InjectDataSource)()),
    __metadata("design:paramtypes", [typeorm_2.DataSource])
], SystemDashboardController);
//# sourceMappingURL=system-dashboard.controller.js.map