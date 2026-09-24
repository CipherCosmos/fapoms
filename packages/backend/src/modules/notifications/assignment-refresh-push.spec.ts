import { AssignmentRefreshPushService, REFRESH_COALESCE_MS } from './assignment-refresh-push.service';

import { FcmProvider, buildDataOnlyMessage } from '../../infrastructure/notifications/fcm-provider';

/**
 * Owner decision 2026-09-24: every job change also sends a SILENT, data-only push so the field app
 * refreshes in the background — coalesced, so one save is one message.
 */
describe('the silent refresh push', () => {
  let push: { sendDataToUser: jest.Mock };
  let svc: AssignmentRefreshPushService;
  beforeEach(() => {
    push = { sendDataToUser: jest.fn().mockResolvedValue(1) };
    svc = new AssignmentRefreshPushService(push as any);
  });
  // Anything a test left pending is sent (to the mock) and its timer cleared.
  afterEach(async () => { await svc.onModuleDestroy(); });

  it('waits out the coalescing window before sending, then sends once', () => {
    jest.useFakeTimers();
    try {
      svc.assignmentChanged('assayer-1', 'asn-1');
      expect(push.sendDataToUser).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(1);
      svc.assignmentChanged('assayer-1', 'asn-1');
      expect(jest.getTimerCount()).toBe(1); // a later change joins the open window, it does not extend it
      jest.advanceTimersByTime(REFRESH_COALESCE_MS);
      expect(push.sendDataToUser).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('one change: one message naming the job', async () => {
    svc.assignmentChanged('assayer-1', 'asn-1');
    await svc.flush('assayer-1');
    expect(push.sendDataToUser).toHaveBeenCalledTimes(1);
    expect(push.sendDataToUser).toHaveBeenCalledWith('assayer-1', { type: 'refresh', scope: 'assignments', assignmentId: 'asn-1' });
  });

  it('five changes to one job in one save: still one message', async () => {
    for (let i = 0; i < 5; i++) svc.assignmentChanged('assayer-1', 'asn-1');
    await svc.flush('assayer-1');
    await svc.flush('assayer-1');
    expect(push.sendDataToUser).toHaveBeenCalledTimes(1);
  });

  it('a burst across several jobs (bulk assign): one message asking for the whole list', async () => {
    for (let i = 0; i < 40; i++) svc.assignmentChanged('assayer-1', `asn-${i}`);
    await svc.flush('assayer-1');
    expect(push.sendDataToUser).toHaveBeenCalledTimes(1);
    expect(push.sendDataToUser).toHaveBeenCalledWith('assayer-1', { type: 'refresh', scope: 'assignments' });
  });

  it('different assayers are separate messages; no assayer, no message', async () => {
    svc.assignmentChanged('assayer-1', 'asn-1');
    svc.assignmentChanged('assayer-2', 'asn-2');
    svc.assignmentChanged(null, 'asn-3');
    await svc.onModuleDestroy();
    expect(push.sendDataToUser).toHaveBeenCalledTimes(2);
  });

  it('a failed send is swallowed — a refresh never breaks the change that caused it', async () => {
    push.sendDataToUser.mockRejectedValue(new Error('fcm down'));
    (svc as any).logger = { warn: jest.fn() };
    svc.assignmentChanged('assayer-1', 'asn-1');
    await expect(svc.flush('assayer-1')).resolves.toBeUndefined();
    expect((svc as any).logger.warn).toHaveBeenCalled();
  });
});

describe('FcmProvider.sendDataOnlyMulticast — nothing shown, app woken', () => {
  it('sends data only: no notification block, Android high priority, iOS background content-available', () => {
    const msg: any = buildDataOnlyMessage(['tok'], { type: 'refresh', scope: 'assignments', assignmentId: 'asn-1' });
    expect(msg.notification).toBeUndefined();
    expect(msg.tokens).toEqual(['tok']);
    expect(msg.android).toEqual({ priority: 'high' });
    expect(msg.apns.headers).toEqual({ 'apns-push-type': 'background', 'apns-priority': '5' });
    expect(msg.apns.payload).toEqual({ aps: { contentAvailable: true } });
    expect(msg.data).toEqual({ type: 'refresh', scope: 'assignments', assignmentId: 'asn-1' });
  });

  it('does nothing when push is not set up', async () => {
    const fcm: any = Object.create(FcmProvider.prototype);
    fcm.initialized = false;
    expect(await fcm.sendDataOnlyMulticast(['a', 'b'], {})).toHaveLength(2);
  });
});
