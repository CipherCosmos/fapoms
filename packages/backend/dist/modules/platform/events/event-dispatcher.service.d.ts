import { EventDispatcherInterface, PlatformDomainEvent, DomainEventHandler } from './event-dispatcher.interface';
export declare class DefaultEventDispatcher implements EventDispatcherInterface {
    private handlers;
    publish(event: PlatformDomainEvent): Promise<void>;
    subscribe(eventName: string, handler: DomainEventHandler): void;
}
