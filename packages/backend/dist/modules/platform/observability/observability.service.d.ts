import { StructuredLogger, MetricsCollector } from './observability.interface';
export declare class DefaultObservabilityService implements StructuredLogger, MetricsCollector {
    info(message: string, context?: any): void;
    warn(message: string, context?: any): void;
    error(message: string, trace?: string, context?: any): void;
    incrementCounter(metricName: string, tags?: Record<string, string>): void;
    recordGauge(metricName: string, value: number, tags?: Record<string, string>): void;
}
