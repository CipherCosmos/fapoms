"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DomainEventPublisher = void 0;
const common_1 = require("@nestjs/common");
let DomainEventPublisher = class DomainEventPublisher {
    listeners = {};
    publish(eventName, payload) {
        console.log(`[DomainEventPublisher] Publishing event: ${eventName}`, payload);
        const list = this.listeners[eventName] || [];
        for (const cb of list) {
            try {
                cb(payload);
            }
            catch (err) {
                console.error(`Error handling event ${eventName}`, err);
            }
        }
    }
    subscribe(eventName, callback) {
        if (!this.listeners[eventName]) {
            this.listeners[eventName] = [];
        }
        this.listeners[eventName].push(callback);
    }
};
exports.DomainEventPublisher = DomainEventPublisher;
exports.DomainEventPublisher = DomainEventPublisher = __decorate([
    (0, common_1.Injectable)()
], DomainEventPublisher);
//# sourceMappingURL=domain-event.publisher.js.map