"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryQueueManager = void 0;
const common_1 = require("@nestjs/common");
let InMemoryQueueManager = class InMemoryQueueManager {
    workers = {};
    async enqueue(job) {
        const jobId = `job-${Math.random().toString(36).substring(2, 9)}`;
        const handler = this.workers[job.name];
        if (handler) {
            setTimeout(async () => {
                try {
                    await handler(job.payload);
                }
                catch (err) {
                    console.error(`Background job ${job.name} execution failed:`, err);
                }
            }, 0);
        }
        return jobId;
    }
    registerWorker(jobName, handler) {
        this.workers[jobName] = handler;
    }
};
exports.InMemoryQueueManager = InMemoryQueueManager;
exports.InMemoryQueueManager = InMemoryQueueManager = __decorate([
    (0, common_1.Injectable)()
], InMemoryQueueManager);
//# sourceMappingURL=queue-manager.service.js.map