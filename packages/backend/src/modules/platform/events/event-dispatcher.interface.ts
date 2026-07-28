export interface PlatformDomainEvent {
  eventId: string;
  eventName: string;
  timestamp: string;
  correlationId: string;
  tenantId: string;
  userId: string;
  aggregateId: string;
  payload: any;
}

export type DomainEventHandler = (event: PlatformDomainEvent) => Promise<void> | void;

export interface EventDispatcherInterface {
  publish(event: PlatformDomainEvent): Promise<void>;
  subscribe(eventName: string, handler: DomainEventHandler): void;
}
