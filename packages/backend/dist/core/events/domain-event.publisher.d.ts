export declare class DomainEventPublisher {
    private listeners;
    publish(eventName: string, payload: any): void;
    subscribe(eventName: string, callback: (payload: any) => void): void;
}
