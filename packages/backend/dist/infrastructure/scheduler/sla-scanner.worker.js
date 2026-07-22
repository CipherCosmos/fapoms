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
exports.SlaScannerWorker = void 0;
const common_1 = require("@nestjs/common");
const assignment_service_1 = require("../../modules/assignment/assignment.service");
let SlaScannerWorker = class SlaScannerWorker {
    assignmentService;
    timer = null;
    constructor(assignmentService) {
        this.assignmentService = assignmentService;
    }
    onModuleInit() {
        if (process.env.NODE_ENV !== 'test') {
            console.log('[SlaScannerWorker] Starting periodic SLA breach scanner...');
            this.timer = setInterval(() => {
                this.runScan();
            }, 5 * 60 * 1000);
            this.timer.unref();
        }
    }
    async runScan() {
        try {
            const breachedCount = await this.assignmentService.checkSlaBreaches();
            if (breachedCount > 0) {
                console.log(`[SlaScannerWorker] SLA scan complete. Flagged ${breachedCount} breached assignments.`);
            }
        }
        catch (err) {
            console.error('[SlaScannerWorker] Error during periodic SLA scan:', err);
        }
    }
    onModuleDestroy() {
        if (this.timer) {
            clearInterval(this.timer);
        }
    }
};
exports.SlaScannerWorker = SlaScannerWorker;
exports.SlaScannerWorker = SlaScannerWorker = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [assignment_service_1.AssignmentService])
], SlaScannerWorker);
//# sourceMappingURL=sla-scanner.worker.js.map