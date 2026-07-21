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
exports.BranchController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const platform_express_1 = require("@nestjs/platform-express");
const class_validator_1 = require("class-validator");
const branch_service_1 = require("./branch.service");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
class CreateBranchRequestDto {
    branchCode;
    solId;
    name;
    address;
    state;
    district;
    city;
    pincode;
    latitude;
    longitude;
    clientId;
}
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateBranchRequestDto.prototype, "branchCode", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateBranchRequestDto.prototype, "solId", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateBranchRequestDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateBranchRequestDto.prototype, "address", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateBranchRequestDto.prototype, "state", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateBranchRequestDto.prototype, "district", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateBranchRequestDto.prototype, "city", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateBranchRequestDto.prototype, "pincode", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], CreateBranchRequestDto.prototype, "latitude", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], CreateBranchRequestDto.prototype, "longitude", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateBranchRequestDto.prototype, "clientId", void 0);
let BranchController = class BranchController {
    branchService;
    constructor(branchService) {
        this.branchService = branchService;
    }
    async create(dto, req) {
        const branch = await this.branchService.create(dto, req.user.id);
        return {
            success: true,
            data: branch,
        };
    }
    async findAll(page = 1, limit = 20, clientId) {
        const { branches, total } = await this.branchService.findAll(page, limit, clientId);
        return {
            success: true,
            data: branches,
            meta: {
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNext: page * limit < total,
                    hasPrevious: page > 1,
                },
            },
        };
    }
    async findOne(id) {
        const branch = await this.branchService.findOne(id);
        return {
            success: true,
            data: branch,
        };
    }
    async update(id, dto, req) {
        const branch = await this.branchService.update(id, dto, req.user.id);
        return {
            success: true,
            data: branch,
        };
    }
    async remove(id, req) {
        await this.branchService.remove(id, req.user.id);
        return {
            success: true,
            data: { message: 'Branch deleted successfully' },
        };
    }
    async importExcel(clientId, file, req) {
        if (!file) {
            return { success: false, error: 'No file uploaded.' };
        }
        const result = await this.branchService.importExcel(file.buffer, clientId, req.user.id);
        return {
            success: true,
            data: result,
        };
    }
};
exports.BranchController = BranchController;
__decorate([
    (0, common_1.Post)(),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Create a new branch manually with geolocation point' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [CreateBranchRequestDto, Object]),
    __metadata("design:returntype", Promise)
], BranchController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'List and filter master bank branches' }),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __param(2, (0, common_1.Query)('clientId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", Promise)
], BranchController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Get details for a single branch by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], BranchController.prototype, "findOne", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, swagger_1.ApiOperation)({ summary: 'Update branch details manually' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, CreateBranchRequestDto, Object]),
    __metadata("design:returntype", Promise)
], BranchController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Soft delete branch record' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], BranchController.prototype, "remove", null);
__decorate([
    (0, common_1.Post)('import/:clientId'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file')),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiOperation)({ summary: 'Upload and parse an Excel sheet branch list based on Client column mappings' }),
    (0, swagger_1.ApiBody)({
        schema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    format: 'binary',
                },
            },
        },
    }),
    __param(0, (0, common_1.Param)('clientId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.UploadedFile)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], BranchController.prototype, "importExcel", null);
exports.BranchController = BranchController = __decorate([
    (0, swagger_1.ApiTags)('Branches'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard),
    (0, common_1.Controller)('branches'),
    __metadata("design:paramtypes", [branch_service_1.BranchService])
], BranchController);
//# sourceMappingURL=branch.controller.js.map