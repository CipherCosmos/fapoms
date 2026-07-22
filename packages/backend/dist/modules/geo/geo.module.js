"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeoModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const geo_entities_1 = require("./geo.entities");
const routing_provider_1 = require("./routing.provider");
const geo_controller_1 = require("./geo.controller");
let GeoModule = class GeoModule {
};
exports.GeoModule = GeoModule;
exports.GeoModule = GeoModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([geo_entities_1.GeoStateEntity, geo_entities_1.GeoDistrictEntity, geo_entities_1.GeoCityEntity]),
        ],
        controllers: [geo_controller_1.GeoController],
        providers: [routing_provider_1.PostGISRoutingProvider, routing_provider_1.OSRMRoutingProvider, routing_provider_1.RoutingService],
        exports: [routing_provider_1.RoutingService, typeorm_1.TypeOrmModule],
    })
], GeoModule);
//# sourceMappingURL=geo.module.js.map