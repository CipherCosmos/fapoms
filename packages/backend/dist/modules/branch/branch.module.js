"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BranchModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const branch_entity_1 = require("./branch.entity");
const branch_contact_entity_1 = require("./branch-contact.entity");
const branch_document_entity_1 = require("./branch-document.entity");
const branch_service_1 = require("./branch.service");
const branch_controller_1 = require("./branch.controller");
const client_module_1 = require("../client/client.module");
const zone_entity_1 = require("../zone/zone.entity");
const geo_entities_1 = require("../geo/geo.entities");
let BranchModule = class BranchModule {
};
exports.BranchModule = BranchModule;
exports.BranchModule = BranchModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([
                branch_entity_1.BranchEntity,
                branch_contact_entity_1.BranchContactEntity,
                branch_document_entity_1.BranchDocumentEntity,
                zone_entity_1.ZoneEntity,
                geo_entities_1.GeoStateEntity,
                geo_entities_1.GeoDistrictEntity,
                geo_entities_1.GeoCityEntity,
            ]),
            client_module_1.ClientModule,
        ],
        controllers: [branch_controller_1.BranchController],
        providers: [branch_service_1.BranchService],
        exports: [branch_service_1.BranchService],
    })
], BranchModule);
//# sourceMappingURL=branch.module.js.map