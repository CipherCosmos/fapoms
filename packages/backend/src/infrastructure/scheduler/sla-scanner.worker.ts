import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { AssignmentService } from '../../modules/assignment/assignment.service';

@Injectable()
export class SlaScannerWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly assignmentService: AssignmentService) {}

  onModuleInit() {
    if (process.env.NODE_ENV !== 'test') {
      console.log('[SlaScannerWorker] Starting periodic SLA breach scanner...');
      // Run every 5 minutes
      this.timer = setInterval(() => {
        this.runScan();
      }, 5 * 60 * 1000);
      this.timer.unref();
    }
  }

  private async runScan() {
    try {
      const breachedCount = await this.assignmentService.checkSlaBreaches();
      if (breachedCount > 0) {
        console.log(`[SlaScannerWorker] SLA scan complete. Flagged ${breachedCount} breached assignments.`);
      }
    } catch (err) {
      console.error('[SlaScannerWorker] Error during periodic SLA scan:', err);
    }
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
