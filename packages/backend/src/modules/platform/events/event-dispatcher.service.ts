import { Injectable } from '@nestjs/common';
import { EventDispatcherInterface, PlatformDomainEvent, DomainEventHandler } from './event-dispatcher.interface';

@Injectable()
export class DefaultEventDispatcher implements EventDispatcherInterface {
  private handlers: Record<string, DomainEventHandler[]> = {};

  async publish(event: PlatformDomainEvent): Promise<void> {
    const list = this.handlers[event.eventName] || [];
    for (const h of list) {
      try {
        await h(event);
      } catch (err) {
        console.error(`Error executing subscriber handler for event ${event.eventName}:`, err);
      }
    }
  }

  subscribe(eventName: string, handler: DomainEventHandler): void {
    if (!this.handlers[eventName]) {
      this.handlers[eventName] = [];
    }
    this.handlers[eventName].push(handler);
  }
}
