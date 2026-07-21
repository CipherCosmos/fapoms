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
exports.RoutingService = exports.OSRMRoutingProvider = exports.PostGISRoutingProvider = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const config_1 = require("@nestjs/config");
let PostGISRoutingProvider = class PostGISRoutingProvider {
    dataSource;
    constructor(dataSource) {
        this.dataSource = dataSource;
    }
    async calculateRoute(origin, destination) {
        const raw = await this.dataSource.query(`SELECT ST_DistanceSphere(
        ST_SetSRID(ST_MakePoint($1, $2), 4326),
        ST_SetSRID(ST_MakePoint($3, $4), 4326)
      ) / 1000 AS "distanceKm"`, [origin.longitude, origin.latitude, destination.longitude, destination.latitude]);
        const distanceKm = raw[0]?.distanceKm ? parseFloat(raw[0].distanceKm) : 0;
        const durationMinutes = (distanceKm / 50) * 60;
        return {
            distanceKm: parseFloat(distanceKm.toFixed(2)),
            durationMinutes: parseFloat(durationMinutes.toFixed(2)),
        };
    }
    async calculateDistances(origin, destinations) {
        const results = {};
        for (const dest of destinations) {
            results[dest.id] = await this.calculateRoute(origin, dest);
        }
        return results;
    }
};
exports.PostGISRoutingProvider = PostGISRoutingProvider;
exports.PostGISRoutingProvider = PostGISRoutingProvider = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectDataSource)()),
    __metadata("design:paramtypes", [typeorm_2.DataSource])
], PostGISRoutingProvider);
let OSRMRoutingProvider = class OSRMRoutingProvider {
    configService;
    postGISProvider;
    baseUrl;
    constructor(configService, postGISProvider) {
        this.configService = configService;
        this.postGISProvider = postGISProvider;
        this.baseUrl = this.configService.get('OSRM_URL', 'https://router.project-osrm.org');
    }
    async calculateRoute(origin, destination) {
        try {
            const url = `${this.baseUrl}/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=false`;
            const res = await fetch(url);
            if (!res.ok)
                throw new Error(`OSRM HTTP error: ${res.status}`);
            const data = await res.json();
            if (data.code === 'Ok' && data.routes?.[0]) {
                const route = data.routes[0];
                return {
                    distanceKm: parseFloat((route.distance / 1000).toFixed(2)),
                    durationMinutes: parseFloat((route.duration / 60).toFixed(2)),
                };
            }
        }
        catch (e) {
        }
        return this.postGISProvider.calculateRoute(origin, destination);
    }
    async calculateDistances(origin, destinations) {
        try {
            const coords = [
                `${origin.longitude},${origin.latitude}`,
                ...destinations.map((d) => `${d.longitude},${d.latitude}`),
            ].join(';');
            const url = `${this.baseUrl}/table/v1/driving/${coords}?sources=0`;
            const res = await fetch(url);
            if (!res.ok)
                throw new Error(`OSRM HTTP error: ${res.status}`);
            const data = await res.json();
            if (data.code === 'Ok' && data.durations?.[0] && data.distances?.[0]) {
                const results = {};
                destinations.forEach((dest, idx) => {
                    const distance = data.distances[0][idx + 1];
                    const duration = data.durations[0][idx + 1];
                    results[dest.id] = {
                        distanceKm: parseFloat((distance / 1000).toFixed(2)),
                        durationMinutes: parseFloat((duration / 60).toFixed(2)),
                    };
                });
                return results;
            }
        }
        catch (e) {
        }
        return this.postGISProvider.calculateDistances(origin, destinations);
    }
};
exports.OSRMRoutingProvider = OSRMRoutingProvider;
exports.OSRMRoutingProvider = OSRMRoutingProvider = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        PostGISRoutingProvider])
], OSRMRoutingProvider);
let RoutingService = class RoutingService {
    configService;
    postGISProvider;
    osrmProvider;
    activeProvider;
    constructor(configService, postGISProvider, osrmProvider) {
        this.configService = configService;
        this.postGISProvider = postGISProvider;
        this.osrmProvider = osrmProvider;
        const providerName = this.configService.get('ROUTING_PROVIDER', 'POSTGIS');
        this.activeProvider =
            providerName.toUpperCase() === 'OSRM' ? this.osrmProvider : this.postGISProvider;
    }
    async calculateRoute(origin, destination) {
        return this.activeProvider.calculateRoute(origin, destination);
    }
    async calculateDistances(origin, destinations) {
        return this.activeProvider.calculateDistances(origin, destinations);
    }
};
exports.RoutingService = RoutingService;
exports.RoutingService = RoutingService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        PostGISRoutingProvider,
        OSRMRoutingProvider])
], RoutingService);
//# sourceMappingURL=routing.provider.js.map