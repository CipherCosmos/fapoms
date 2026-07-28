"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultEventDispatcher = void 0;
const common_1 = require("@nestjs/common");
let DefaultEventDispatcher = class DefaultEventDispatcher {
    handlers = {};
    async publish(event) {
        const list = this.handlers[event.eventName] || [];
        for (const h of list) {
            try {
                await h(event);
            }
            catch (err) {
                console.error(`Error executing subscriber handler for event ${event.eventName}:`, err);
            }
        }
    }
    subscribe(eventName, handler) {
        if (!this.handlers[eventName]) {
            this.handlers[eventName] = [];
        }
        this.handlers[eventName].push(handler);
    }
};
exports.DefaultEventDispatcher = DefaultEventDispatcher;
exports.DefaultEventDispatcher = DefaultEventDispatcher = __decorate([
    (0, common_1.Injectable)()
], DefaultEventDispatcher);
//# sourceMappingURL=event-dispatcher.service.js.map