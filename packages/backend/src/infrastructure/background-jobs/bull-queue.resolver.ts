import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bull';
import type { Queue } from 'bull';

/**
 * Finds a feature's Bull queue by name, for the rows the foundation only TRACKS (`runner_queue`).
 *
 * The foundation imports no feature and registers no feature queue, so it cannot `@InjectQueue`
 * them. It needs one only to ask "does Bull still have this job?" (the recovery sweep) and to take a
 * waiting job off its queue (cancel) — so it looks the queue up, non-strictly, from wherever the
 * feature module registered it. A queue this process has not registered answers null, and the
 * caller treats that as "cannot ask", never as "gone".
 */
@Injectable()
export class BullQueueResolver {
  constructor(@Optional() private readonly moduleRef?: ModuleRef) {}

  get(name: string): Queue | null {
    if (!this.moduleRef || !name) return null;
    try {
      return this.moduleRef.get<Queue>(getQueueToken(name), { strict: false }) ?? null;
    } catch {
      return null;
    }
  }
}
