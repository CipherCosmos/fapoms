"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReusableWorkflowEngine = void 0;
const common_1 = require("@nestjs/common");
let ReusableWorkflowEngine = class ReusableWorkflowEngine {
    workflows = {};
    registerWorkflow(definition) {
        this.workflows[definition.name] = definition;
    }
    async executeTransition(workflowName, fromState, toState, context) {
        const wf = this.workflows[workflowName];
        if (!wf)
            return false;
        const transition = wf.transitions.find((t) => t.fromState === fromState && t.toState === toState);
        if (!transition)
            return false;
        if (transition.guards) {
            for (const guard of transition.guards) {
                const ok = await guard.validate(context);
                if (!ok)
                    return false;
            }
        }
        if (transition.actions) {
            for (const act of transition.actions) {
                await act.execute(context);
            }
        }
        return true;
    }
};
exports.ReusableWorkflowEngine = ReusableWorkflowEngine;
exports.ReusableWorkflowEngine = ReusableWorkflowEngine = __decorate([
    (0, common_1.Injectable)()
], ReusableWorkflowEngine);
//# sourceMappingURL=workflow-engine.service.js.map