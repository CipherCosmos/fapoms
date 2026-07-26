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
exports.GeoSeedService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const geo_entities_1 = require("./geo.entities");
let GeoSeedService = class GeoSeedService {
    stateRepo;
    districtRepo;
    cityRepo;
    constructor(stateRepo, districtRepo, cityRepo) {
        this.stateRepo = stateRepo;
        this.districtRepo = districtRepo;
        this.cityRepo = cityRepo;
    }
    async onModuleInit() {
        const count = await this.stateRepo.count();
        if (count > 0)
            return;
        const statesData = [
            { name: 'Maharashtra', code: 'MH', districts: [
                    { name: 'Mumbai', cities: [{ name: 'Mumbai City', pincode: '400001' }] },
                    { name: 'Pune', cities: [{ name: 'Pune City', pincode: '411001' }, { name: 'Pimpri-Chinchwad', pincode: '411018' }] },
                    { name: 'Nagpur', cities: [{ name: 'Nagpur', pincode: '440001' }] },
                    { name: 'Thane', cities: [{ name: 'Thane', pincode: '400601' }] },
                    { name: 'Nashik', cities: [{ name: 'Nashik', pincode: '422001' }] },
                    { name: 'Aurangabad', cities: [{ name: 'Aurangabad', pincode: '431001' }] },
                    { name: 'Solapur', cities: [{ name: 'Solapur', pincode: '413001' }] },
                ] },
            { name: 'Gujarat', code: 'GJ', districts: [
                    { name: 'Ahmedabad', cities: [{ name: 'Ahmedabad City', pincode: '380001' }] },
                    { name: 'Surat', cities: [{ name: 'Surat City', pincode: '395003' }] },
                    { name: 'Vadodara', cities: [{ name: 'Vadodara', pincode: '390001' }] },
                    { name: 'Rajkot', cities: [{ name: 'Rajkot', pincode: '360001' }] },
                ] },
            { name: 'Karnataka', code: 'KA', districts: [
                    { name: 'Bangalore Urban', cities: [{ name: 'Bangalore', pincode: '560001' }] },
                    { name: 'Mysore', cities: [{ name: 'Mysore', pincode: '570001' }] },
                    { name: 'Hubli', cities: [{ name: 'Hubli', pincode: '580001' }] },
                ] },
            { name: 'Tamil Nadu', code: 'TN', districts: [
                    { name: 'Chennai', cities: [{ name: 'Chennai', pincode: '600001' }] },
                    { name: 'Coimbatore', cities: [{ name: 'Coimbatore', pincode: '641001' }] },
                ] },
            { name: 'Uttar Pradesh', code: 'UP', districts: [
                    { name: 'Lucknow', cities: [{ name: 'Lucknow', pincode: '226001' }] },
                    { name: 'Kanpur', cities: [{ name: 'Kanpur', pincode: '208001' }] },
                ] },
            { name: 'West Bengal', code: 'WB', districts: [
                    { name: 'Kolkata', cities: [{ name: 'Kolkata', pincode: '700001' }] },
                ] },
            { name: 'Rajasthan', code: 'RJ', districts: [
                    { name: 'Jaipur', cities: [{ name: 'Jaipur', pincode: '302001' }] },
                ] },
            { name: 'Delhi', code: 'DL', districts: [
                    { name: 'New Delhi', cities: [{ name: 'New Delhi', pincode: '110001' }] },
                ] },
        ];
        for (const sd of statesData) {
            const state = this.stateRepo.create({ name: sd.name, code: sd.code, createdBy: 'system', updatedBy: 'system' });
            await this.stateRepo.save(state);
            for (const dd of sd.districts) {
                const district = this.districtRepo.create({ name: dd.name, stateId: state.id, createdBy: 'system', updatedBy: 'system' });
                await this.districtRepo.save(district);
                for (const cd of dd.cities) {
                    const city = this.cityRepo.create({ name: cd.name, districtId: district.id, pincode: cd.pincode, createdBy: 'system', updatedBy: 'system' });
                    await this.cityRepo.save(city);
                }
            }
        }
    }
};
exports.GeoSeedService = GeoSeedService;
exports.GeoSeedService = GeoSeedService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(geo_entities_1.GeoStateEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(geo_entities_1.GeoDistrictEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(geo_entities_1.GeoCityEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository])
], GeoSeedService);
//# sourceMappingURL=geo-seed.service.js.map