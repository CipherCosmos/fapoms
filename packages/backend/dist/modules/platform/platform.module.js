"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlatformModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const business_rule_entity_1 = require("./rules/business-rule.entity");
const rule_engine_1 = require("./rules/rule.engine");
const workflow_engine_1 = require("./workflow/workflow.engine");
const configuration_resolver_1 = require("./configuration/configuration.resolver");
let PlatformModule = class PlatformModule {
};
exports.PlatformModule = PlatformModule;
exports.PlatformModule = PlatformModule = __decorate([
    (0, common_1.Global)(),
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([business_rule_entity_1.BusinessRuleEntity])],
        providers: [rule_engine_1.RuleEngine, workflow_engine_1.WorkflowEngine, configuration_resolver_1.ConfigurationResolver],
        exports: [typeorm_1.TypeOrmModule, rule_engine_1.RuleEngine, workflow_engine_1.WorkflowEngine, configuration_resolver_1.ConfigurationResolver],
    })
], PlatformModule);
//# sourceMappingURL=platform.module.js.map