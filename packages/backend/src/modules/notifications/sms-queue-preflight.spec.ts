import { SmsService } from './sms.service';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';

/**
 * A text that can never be delivered is refused when it is queued, not after.
 *
 * Found in the live outbox on 2026-09-23: every app-access credential text since approval started
 * issuing them was FAILED by the gateway — "This text has no DLT template id" — while `queue` had
 * answered QUEUED. Callers read QUEUED as "on its way", so the approval recorded the credential as
 * texted and HR was never told it had not gone. The reason was knowable before the message was
 * ever written: DLT on, no template id.
 */
describe('SmsProvider.preflight', () => {
  const provider = (settings: { dltEntityId?: string | null } | null) => {
    const p = new SmsProvider(undefined as never);
    (p as any).transport = settings ? { name: 'TEST', send: jest.fn() } : null;
    (p as any).sendSettings = settings ? { senderId: 'SUMERU', dltEntityId: settings.dltEntityId ?? null } : null;
    return p;
  };

  it('refuses a text with no template id when the account sends under DLT', () => {
    expect(provider({ dltEntityId: '1101' }).preflight({ to: '9822014455', dltTemplateId: null }))
      .toMatch(/no DLT template id/);
  });

  it('passes the same text once it carries its registered template id', () => {
    expect(provider({ dltEntityId: '1101' }).preflight({ to: '9822014455', dltTemplateId: '1777' })).toBeNull();
  });

  it('does not ask for a template id from an account that is not on DLT', () => {
    expect(provider({ dltEntityId: null }).preflight({ to: '9822014455', dltTemplateId: null })).toBeNull();
  });

  it('refuses a number that is not a mobile, and a gateway that is not set up', () => {
    expect(provider({ dltEntityId: null }).preflight({ to: '020 2612 3456', dltTemplateId: null })).toMatch(/not an Indian mobile/);
    expect(provider(null).preflight({ to: '9822014455', dltTemplateId: '1777' })).toMatch(/not configured/);
  });

  /** One check for both: `send` must refuse exactly what `preflight` names, without a network call. */
  it('makes send refuse the same thing, permanently, without calling the gateway', async () => {
    const p = provider({ dltEntityId: '1101' });
    const result = await p.send({ to: '9822014455', text: 'x', dltTemplateId: null });
    expect(result).toEqual({ success: false, error: expect.stringMatching(/no DLT template id/), permanent: true });
    expect((p as any).transport.send).not.toHaveBeenCalled();
  });
});

describe('SmsService.queue', () => {
  const harness = (refusal: string | null) => {
    const transport = { preflight: jest.fn(() => refusal), isEnabled: jest.fn(() => true) };
    const templates = { render: jest.fn(async () => ({ text: 'Hello', label: 'Reference notice', dltTemplateId: null })) };
    const outbound = {
      enqueue: jest.fn(async () => ({ id: 'q-1', channel: 'SMS', status: 'QUEUED', to: '9822014455' })),
      recordImmediate: jest.fn(async (input: any) => ({
        id: 'f-1', channel: 'SMS', status: input.sent ? 'SENT' : 'FAILED', to: input.to, error: input.error,
      })),
    };
    const tokens = { common: jest.fn(async () => ({})) };
    const service = new SmsService(transport as never, templates as never, outbound as never, tokens as never);
    return { service, outbound };
  };

  const request = {
    kind: 'REFERENCE_NOTICE', to: '9822014455',
    content: { template: 'reference-notice', data: {} },
    entityType: 'ASSAYER_REFERENCE', entityId: 'ref-1', requestedBy: 'hr-1',
  } as never;

  it('records the refusal as FAILED with its reason, and never queues it', async () => {
    const { service, outbound } = harness('This text has no DLT template id; add it under SMS templates in Platform Settings.');

    const receipt = await service.queue(request);

    expect(receipt.status).toBe('FAILED');
    expect(receipt.error).toMatch(/no DLT template id/);
    expect(outbound.enqueue).not.toHaveBeenCalled();
    expect(outbound.recordImmediate).toHaveBeenCalledWith(expect.objectContaining({ sent: false, entityId: 'ref-1' }));
  });

  it('queues a text that can go', async () => {
    const { service, outbound } = harness(null);

    const receipt = await service.queue(request);

    expect(receipt.status).toBe('QUEUED');
    expect(outbound.recordImmediate).not.toHaveBeenCalled();
  });
});
