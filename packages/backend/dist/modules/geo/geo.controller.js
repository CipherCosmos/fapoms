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
exports.GeoController = exports.OptimizeRouteDto = exports.DestinationDto = exports.CoordinateDto = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const routing_provider_1 = require("./routing.provider");
const guards_1 = require("../auth/guards");
class CoordinateDto {
    latitude;
    longitude;
}
exports.CoordinateDto = CoordinateDto;
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Number)
], CoordinateDto.prototype, "latitude", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Number)
], CoordinateDto.prototype, "longitude", void 0);
class DestinationDto extends CoordinateDto {
    id;
}
exports.DestinationDto = DestinationDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], DestinationDto.prototype, "id", void 0);
class OptimizeRouteDto {
    origin;
    destinations;
    roundTrip;
}
exports.OptimizeRouteDto = OptimizeRouteDto;
__decorate([
    (0, class_validator_1.ValidateNested)(),
    (0, class_transformer_1.Type)(() => CoordinateDto),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", CoordinateDto)
], OptimizeRouteDto.prototype, "origin", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => DestinationDto),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Array)
], OptimizeRouteDto.prototype, "destinations", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsBoolean)(),
    __metadata("design:type", Boolean)
], OptimizeRouteDto.prototype, "roundTrip", void 0);
let GeoController = class GeoController {
    routingService;
    constructor(routingService) {
        this.routingService = routingService;
    }
    async optimizeRoute(dto) {
        if (dto.destinations.length > 20) {
            throw new common_1.BadRequestException('Optimization limit exceeded: Cannot optimize more than 20 destinations at once.');
        }
        const result = await this.routingService.optimizeRoute(dto.origin, dto.destinations, dto.roundTrip);
        return {
            success: true,
            data: result,
        };
    }
};
exports.GeoController = GeoController;
__decorate([
    (0, common_1.Post)('route/optimize'),
    (0, swagger_1.ApiOperation)({ summary: 'Calculate optimized route sequence (TSP solver) for multiple destinations' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [OptimizeRouteDto]),
    __metadata("design:returntype", Promise)
], GeoController.prototype, "optimizeRoute", null);
exports.GeoController = GeoController = __decorate([
    (0, swagger_1.ApiTags)('Geo'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard),
    (0, common_1.Controller)('geo'),
    __metadata("design:paramtypes", [routing_provider_1.RoutingService])
], GeoController);
//# sourceMappingURL=geo.controller.js.map