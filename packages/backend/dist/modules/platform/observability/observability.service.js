"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultObservabilityService = void 0;
const common_1 = require("@nestjs/common");
let DefaultObservabilityService = class DefaultObservabilityService {
    info(message, context) {
        console.log(`[INFO] ${message}`, context ? JSON.stringify(context) : '');
    }
    warn(message, context) {
        console.warn(`[WARN] ${message}`, context ? JSON.stringify(context) : '');
    }
    error(message, trace, context) {
        console.error(`[ERROR] ${message}`, trace || '', context ? JSON.stringify(context) : '');
    }
    incrementCounter(metricName, tags) {
    }
    recordGauge(metricName, value, tags) {
    }
};
exports.DefaultObservabilityService = DefaultObservabilityService;
exports.DefaultObservabilityService = DefaultObservabilityService = __decorate([
    (0, common_1.Injectable)()
], DefaultObservabilityService);
//# sourceMappingURL=observability.service.js.map