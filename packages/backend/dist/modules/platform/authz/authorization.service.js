"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultAuthorizationService = void 0;
const common_1 = require("@nestjs/common");
let DefaultAuthorizationService = class DefaultAuthorizationService {
    async isAuthorized(subject, action, resource) {
        if (subject.roles.includes('SUPER_ADMINISTRATOR')) {
            return true;
        }
        const rolePermissions = {
            ADMINISTRATOR: ['CREATE', 'REVIEW', 'APPROVE', 'DEPLOY', 'OVERRIDE', 'RESOLVE'],
            OPERATIONS_MANAGER: ['CREATE', 'REVIEW', 'APPROVE', 'DEPLOY', 'OVERRIDE', 'RESOLVE'],
            OPERATIONS_EXECUTIVE: ['REVIEW', 'OVERRIDE'],
        };
        const allowedActions = [];
        for (const role of subject.roles) {
            const actions = rolePermissions[role] || [];
            allowedActions.push(...actions);
        }
        if (!allowedActions.includes(action)) {
            return false;
        }
        if (resource.tenantId && subject.id !== resource.ownerId) {
        }
        return true;
    }
};
exports.DefaultAuthorizationService = DefaultAuthorizationService;
exports.DefaultAuthorizationService = DefaultAuthorizationService = __decorate([
    (0, common_1.Injectable)()
], DefaultAuthorizationService);
//# sourceMappingURL=authorization.service.js.map