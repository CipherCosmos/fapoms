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
var DocumentModule_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const bull_1 = require("@nestjs/bull");
const document_service_1 = require("./document.service");
const document_controller_1 = require("./document.controller");
const document_dispatch_worker_1 = require("./document-dispatch.worker");
const document_access_token_service_1 = require("./document-access-token.service");
const chunked_upload_service_1 = require("./chunked-upload.service");
const document_entity_1 = require("./document.entity");
const assessment_entity_1 = require("../project/assessment.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const notifications_module_1 = require("../notifications/notifications.module");
const storage_module_1 = require("../../infrastructure/storage/storage.module");
const ocr_module_1 = require("../../infrastructure/ocr/ocr.module");
const validation_module_1 = require("../validation/validation.module");
const assignment_module_1 = require("../assignment/assignment.module");
let DocumentModule = class DocumentModule {
    static { DocumentModule_1 = this; }
    dispatchQueue;
    logger = new common_1.Logger(DocumentModule_1.name);
    constructor(dispatchQueue) {
        this.dispatchQueue = dispatchQueue;
    }
    static CRON = '0 * * * *';
    async onModuleInit() {
        if (process.env.NODE_ENV === 'test')
            return;
        const existing = await this.dispatchQueue.getRepeatableJobs();
        for (const job of existing) {
            if (job.name === 'auto-dispatch' && job.cron !== DocumentModule_1.CRON) {
                await this.dispatchQueue.removeRepeatableByKey(job.key);
                this.logger.warn(`Removed stale auto-dispatch schedule: ${job.cron}`);
            }
        }
        await this.dispatchQueue.add('auto-dispatch', {}, { repeat: { cron: DocumentModule_1.CRON }, removeOnComplete: true, removeOnFail: false });
        this.logger.log('Document auto-dispatch repeatable job registered (hourly)');
    }
};
exports.DocumentModule = DocumentModule;
exports.DocumentModule = DocumentModule = DocumentModule_1 = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([document_entity_1.DocumentEntity, assessment_entity_1.AssessmentEntity, project_branch_entity_1.ProjectBranchEntity, assignment_entity_1.AssignmentEntity]),
            bull_1.BullModule.registerQueue({ name: 'document-dispatch' }),
            notifications_module_1.NotificationsModule,
            storage_module_1.StorageModule,
            ocr_module_1.OcrModule,
            validation_module_1.ValidationModule,
            assignment_module_1.AssignmentModule,
        ],
        controllers: [document_controller_1.DocumentController],
        providers: [document_service_1.DocumentService, document_dispatch_worker_1.DocumentDispatchWorker, document_access_token_service_1.DocumentAccessTokenService, chunked_upload_service_1.ChunkedUploadService],
        exports: [document_service_1.DocumentService, document_access_token_service_1.DocumentAccessTokenService],
    }),
    __param(0, (0, bull_1.InjectQueue)('document-dispatch')),
    __metadata("design:paramtypes", [Object])
], DocumentModule);
//# sourceMappingURL=document.module.js.map