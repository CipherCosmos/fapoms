import { Injectable } from '@nestjs/common';

export type EventCallback = (eventName: string, payload: any) => void;

@Injectable()
export class DomainEventPublisher {
  private listeners: Record<string, ((payload: any) => void)[]> = {};
  private globalCallbacks: EventCallback[] = [];

  onPublish(callback: EventCallback) {
    this.globalCallbacks.push(callback);
  }

  publish(eventName: string, payload: any) {
    const list = this.listeners[eventName] || [];
    for (const cb of list) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`Error handling event ${eventName}`, err);
      }
    }

    for (const cb of this.globalCallbacks) {
      try {
        cb(eventName, payload);
      } catch (err) {
        console.error(`Error in global callback for event ${eventName}`, err);
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
