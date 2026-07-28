export interface StructuredLogger {
  info(message: string, context?: any): void;
  warn(message: string, context?: any): void;
  error(message: string, trace?: string, context?: any): void;
}

export interface MetricsCollector {
  incrementCounter(metricName: string, tags?: Record<string, string>): void;
  recordGauge(metricName: string, value: number, tags?: Record<string, string>): void;
}
