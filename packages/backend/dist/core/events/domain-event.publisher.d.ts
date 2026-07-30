export type EventCallback = (eventName: string, payload: any) => void;
export declare class DomainEventPublisher {
    private listeners;
    private globalCallbacks;
    onPublish(callback: EventCallback): void;
    publish(eventName: string, payload: any): void;
    subscribe(eventName: string, callback: (payload: any) => void): void;
}
