import { classifyMailError } from '../../infrastructure/notifications/email-provider';
import { isPermanentHttpStatus, isTransportHttpStatus } from '../../infrastructure/notifications/sms/sms-transport';
import { deliverOutboundMessage } from './outbound-message.delivery';
import { NOT_SET_UP_REASONS, messagingStatus, readChannelHealth } from './messaging-health';
import { EMAIL_NOT_SET_UP_REASON } from './outbound-message.service';
import { SMS_NOT_SET_UP_REASON } from './sms.service';

/**
 * A broken CHANNEL (credentials refused, server unreachable) is not a failed message.
 *
 * EAUTH/535 were classed "permanent", so a revoked mail password settled every message FAILED for
 * good, and nothing said every send was failing. Now: channel faults are retried, then deferred on a
 * long backoff (QUEUED + retry_after) rather than failed, and the sweep reports a channel with
 * failures and no sends.
 */
describe('mail error classification', () => {
  it.each([
    [{ code: 'EAUTH', responseCode: 535 }],
    [{ responseCode: 530 }],
    [{ code: 'ECONNECTION' }],
    [{ code: 'ETIMEDOUT' }],
    [{ responseCode: 421 }],
  ])('treats %j as a channel fault, not a permanent refusal', (err) => {
    expect(classifyMailError(err)).toEqual({ permanent: false, transportFault: true });
  });

  it.each([[{ code: 'EENVELOPE' }], [{ responseCode: 550 }], [{ responseCode: 553 }]])(
    'keeps %j a permanent refusal of this message', (err) => {
      expect(classifyMailError(err)).toEqual({ permanent: true, transportFault: false });
    },
  );

  it('SMS: a refused key or a gateway 5xx is a channel fault; a 400 still refuses the text', () => {
    expect([401, 403, 500, 503].map(isTransportHttpStatus)).toEqual([true, true, true, true]);
    expect([401, 403].map(isPermanentHttpStatus)).toEqual([false, false]);
    expect(isPermanentHttpStatus(400)).toBe(true);
    expect(isTransportHttpStatus(400)).toBe(false);
  });
});

describe('deliverOutboundMessage — channel faults', () => {
  const wording = { notSetUp: 'off', refused: (e: string) => `refused: ${e}`, noAnswer: 'no answer' };
  const outbound = () => ({
    claim: jest.fn(async () => ({ row: {}, message: { channel: 'EMAIL', to: 'a@b.c', subject: 's', text: 't' } })),
    markSent: jest.fn(), markFailed: jest.fn(), release: jest.fn(), deferForTransport: jest.fn(),
  });
  const job = (attemptsMade: number) => ({ data: { outboundMessageId: 'm1' }, opts: { attempts: 5 }, attemptsMade }) as any;
  const transport = { isEnabled: () => true, send: jest.fn(async () => ({ success: false, error: 'Invalid login: 535', transportFault: true })) };

  it('retries on the normal backoff while attempts remain', async () => {
    const o = outbound();
    await expect(deliverOutboundMessage(job(1), 'EMAIL', o as any, transport as any, wording)).rejects.toThrow('535');
    expect(o.release).toHaveBeenCalledWith('m1', 'Invalid login: 535');
    expect(o.markFailed).not.toHaveBeenCalled();
  });

  it('on the last attempt defers the message instead of failing it', async () => {
    const o = outbound();
    await deliverOutboundMessage(job(4), 'EMAIL', o as any, transport as any, wording);
    expect(o.deferForTransport).toHaveBeenCalledWith('m1', 'Invalid login: 535');
    expect(o.markFailed).not.toHaveBeenCalled();
  });

  it('still fails an ordinary transient error on the last attempt', async () => {
    const o = outbound();
    const t = { isEnabled: () => true, send: jest.fn(async () => ({ success: false, error: 'greylisted' })) };
    await deliverOutboundMessage(job(4), 'EMAIL', o as any, t as any, wording);
    expect(o.markFailed).toHaveBeenCalled();
    expect(o.deferForTransport).not.toHaveBeenCalled();
  });
});

describe('channel health', () => {
  it('reads DOWN only for a channel with failures and no sends', async () => {
    const query = jest.fn(async (_sql: string, _params: unknown[]) => [
      { channel: 'EMAIL', sent: '0', failing: '4' },
      { channel: 'SMS', sent: '1', failing: '9' },
    ]);
    const health = await readChannelHealth(query, Date.parse('2026-09-24T10:00:00Z'));
    expect(health).toEqual([
      { channel: 'EMAIL', sent: 0, failing: 4, down: true },
      { channel: 'SMS', sent: 1, failing: 9, down: false },
    ]);
    expect(messagingStatus(health)).toBe('degraded');
    expect(query.mock.calls[0][1]).toEqual([new Date(Date.parse('2026-09-24T09:30:00Z')), NOT_SET_UP_REASONS]);
  });

  it('a quiet channel (no rows) is not down', async () => {
    const health = await readChannelHealth(async () => [], Date.now());
    expect(health.every((h) => !h.down)).toBe(true);
    expect(messagingStatus(health)).toBe('ok');
  });

  it('excludes exactly the ledger wordings of a channel switched off on purpose', () => {
    expect(NOT_SET_UP_REASONS).toEqual([EMAIL_NOT_SET_UP_REASON, SMS_NOT_SET_UP_REASON]);
  });
});
