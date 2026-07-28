import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter';
import { ExpressAdapter } from '@bull-board/express';

export function setupBullBoard(app: any) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/bull-board');

  const queues = ['background-jobs', 'ocr', 'sla-scanner']
    .map((name) => {
      try {
        return app.get(`BullQueue_${name}`, { strict: false });
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (queues.length === 0) return;

  createBullBoard({
    queues: queues.map((q: any) => new BullAdapter(q)),
    serverAdapter,
  });

  app.use('/bull-board', serverAdapter.getRouter());
}
