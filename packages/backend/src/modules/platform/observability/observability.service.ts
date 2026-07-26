import { Injectable } from '@nestjs/common';
import { StructuredLogger, MetricsCollector } from './observability.interface';

@Injectable()
export class DefaultObservabilityService implements StructuredLogger, MetricsCollector {
  info(message: string, context?: any): void {
    console.log(`[INFO] ${message}`, context ? JSON.stringify(context) : '');
  }

  warn(message: string, context?: any): void {
    console.warn(`[WARN] ${message}`, context ? JSON.stringify(context) : '');
  }

  error(message: string, trace?: string, context?: any): void {
    console.error(`[ERROR] ${message}`, trace || '', context ? JSON.stringify(context) : '');
  }

  incrementCounter(metricName: string, tags?: Record<string, string>): void {
    // Mock counter increments
  }

  recordGauge(metricName: string, value: number, tags?: Record<string, string>): void {
    // Mock gauge record
  }
}
