import { Injectable } from '@nestjs/common';

@Injectable()
export class DomainEventPublisher {
  private listeners: Record<string, ((payload: any) => void)[]> = {};

  publish(eventName: string, payload: any) {
    console.log(`[DomainEventPublisher] Publishing event: ${eventName}`, payload);
    const list = this.listeners[eventName] || [];
    for (const cb of list) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`Error handling event ${eventName}`, err);
      }
    }
  }

  subscribe(eventName: string, callback: (payload: any) => void) {
    if (!this.listeners[eventName]) {
      this.listeners[eventName] = [];
    }
    this.listeners[eventName].push(callback);
  }
}
