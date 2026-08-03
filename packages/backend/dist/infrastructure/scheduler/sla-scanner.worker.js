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
var SlaScannerWorker_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlaScannerWorker = void 0;
const common_1 = require("@nestjs/common");
const bull_1 = require("@nestjs/bull");
const assignment_service_1 = require("../../modules/assignment/assignment.service");
let SlaScannerWorker = SlaScannerWorker_1 = class SlaScannerWorker {
    assignmentService;
    logger = new common_1.Logger(SlaScannerWorker_1.name);
    constructor(assignmentService) {
        this.assignmentService = assignmentService;
    }
    async runScan(job) {
        try {
            const breachedCount = await this.assignmentService.checkSlaBreaches();
            if (breachedCount > 0) {
                this.logger.log(`SLA scan complete. Flagged ${breachedCount} breached assignments.`);
            }
        }
        catch (err) {
            this.logger.error('Error during periodic SLA scan:', err);
            throw err;
        }
        try {
            const declinedCount = await this.assignmentService.autoDeclineExpiredOffers();
            if (declinedCount > 0) {
                this.logger.log(`Auto-declined ${declinedCount} assignment offer(s) with no response within the SLA window.`);
            }
        }
        catch (err) {
            this.logger.error('Error during periodic auto-decline scan:', err);
            throw err;
        }
    }
};
exports.SlaScannerWorker = SlaScannerWorker;
__decorate([
    (0, bull_1.Process)('scan'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SlaScannerWorker.prototype, "runScan", null);
exports.SlaScannerWorker = SlaScannerWorker = SlaScannerWorker_1 = __decorate([
    (0, common_1.Injectable)(),
    (0, bull_1.Processor)('sla-scanner'),
    __metadata("design:paramtypes", [assignment_service_1.AssignmentService])
], SlaScannerWorker);
//# sourceMappingURL=sla-scanner.worker.js.map