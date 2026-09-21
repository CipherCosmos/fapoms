import { EmailService } from './email.service';

/**
 * THE ONE WAY THE APPLICATION SENDS EMAIL.
 *
 * Email had seven direct paths to the mail server, two queue-and-retry pipelines, and templated
 * emails whose wording existed twice (a call-site fallback and the registry's). These pin the
 * facade's promises: a template goes through the renderer (so an administrator's edit is what is
 * sent), `queue` records instead of sending and never throws, and `sendNow` sends while the caller
 * waits, never stores the body, and still leaves a record of whether it went.
 */
describe('EmailService', () => {
  const setup = (opts: { enabled?: boolean; send?: any; renderThrows?: boolean } = {}) => {
    const transport = {
      isEnabled: jest.fn(() => opts.enabled ?? true),
      send: jest.fn(async () => opts.send ?? { success: true, messageId: 'm1' }),
    };
    const templates = {
      render: jest.fn(async (key: string, data: any, _recipient?: any) => {
        if (opts.renderThrows) throw new Error('template exploded');
        return { subject: `S:${key}`, text: `T:${data.name}`, html: `<p>${data.name}</p>`, metadata: {} };
      }),
    };
    const outbound = {
      enqueue: jest.fn(async (req: any) => ({ id: 'q1', status: 'QUEUED', to: req.to })),
      recordImmediate: jest.fn(async (req: any) => ({
        id: 'r1', status: req.sent ? 'SENT' : 'FAILED', to: req.to, error: req.sent ? null : req.error,
      })),
    };
    const service = new EmailService(transport as any, templates as any, outbound as any);
    return { service, transport, templates, outbound };
  };

  describe('compose', () => {
    it('renders a template through the renderer, so an administrator\'s published edit is what goes out', async () => {
      const { service, templates } = setup();
      await expect(service.compose({ template: 'registration-invite', data: { name: 'Ramesh' } }))
        .resolves.toEqual({ subject: 'S:registration-invite', text: 'T:Ramesh', html: '<p>Ramesh</p>' });
      // The third argument is who it is going to; `compose` was called without one here.
      expect(templates.render).toHaveBeenCalledWith('registration-invite', { name: 'Ramesh' }, {});
    });

    /**
     * Who the email is going to is known here and nowhere else, so this is where it is handed to the
     * renderer — otherwise every caller would have to remember to put the address and the person's
     * name into its own template data, which is exactly the per-message vocabulary this replaced.
     */
    it('tells the renderer who it is going to, so {{name}} and {{email}} can be used in any wording', async () => {
      const { service, templates } = setup();

      await service.queue({
        kind: 'REGISTRATION_INVITE', to: 'ramesh@example.com', recipientName: 'Ramesh Kumar',
        content: { template: 'registration-invite', data: { name: 'Ramesh' } },
      });
      await service.sendNow({
        kind: 'REGISTRATION_INVITE', to: '  ramesh@example.com  ', recipientName: 'Ramesh Kumar',
        content: { template: 'registration-invite', data: { name: 'Ramesh' } },
      });

      for (const call of templates.render.mock.calls) {
        expect(call[2]).toEqual({ name: 'Ramesh Kumar', email: 'ramesh@example.com' });
      }
      expect(templates.render).toHaveBeenCalledTimes(2);
    });

    it('lays out a system message and derives its plain-text half from the HTML', async () => {
      const { service } = setup();
      const composed = await service.compose({
        layout: { title: 'Heads up', bodyLines: ['The desk closes early today.'] },
        subject: 'Heads up',
      });
      expect(composed.subject).toBe('Heads up');
      expect(composed.html).toContain('The desk closes early today.');
      expect(composed.text).toContain('The desk closes early today.');
    });

    it('passes an already-rendered message through untouched', async () => {
      const { service } = setup();
      const rendered = { subject: 's', text: 't', html: '<b>h</b>' };
      await expect(service.compose({ rendered })).resolves.toEqual(rendered);
    });
  });

  describe('queue', () => {
    it('records the composed message for the worker instead of sending it', async () => {
      const { service, transport, outbound } = setup();
      const receipt = await service.queue({
        kind: 'REGISTRATION_INVITE', to: 'c@example.com', requestedBy: 'desk-1',
        entityType: 'ASSAYER_APPLICATION', entityId: 'app-1',
        content: { template: 'registration-invite', data: { name: 'Ramesh' } },
      });
      expect(receipt).toEqual({ id: 'q1', status: 'QUEUED', to: 'c@example.com' });
      expect(transport.send).not.toHaveBeenCalled();
      expect(outbound.enqueue).toHaveBeenCalledWith({
        channel: 'EMAIL', kind: 'REGISTRATION_INVITE', to: 'c@example.com', subject: 'S:registration-invite', text: 'T:Ramesh',
        html: '<p>Ramesh</p>', entityType: 'ASSAYER_APPLICATION', entityId: 'app-1', requestedBy: 'desk-1',
      });
    });

    it('answers NOT_QUEUED rather than throwing when the message cannot be prepared', async () => {
      const { service, outbound } = setup({ renderThrows: true });
      const receipt = await service.queue({ kind: 'ROSTER_MESSAGE', to: 'x@example.com', content: { template: 'registration-invite', data: {} } });
      expect(receipt.status).toBe('NOT_QUEUED');
      expect(receipt.error).toBeTruthy();
      expect(outbound.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('sendNow', () => {
    it('sends while the caller waits, carrying attachments, and records that it went without the body', async () => {
      const { service, transport, outbound } = setup();
      const attachments = [{ filename: 'packet.pdf', content: Buffer.from('%PDF') }];
      const result = await service.sendNow({
        kind: 'BRANCH_AUDIT_PACKET', to: 'branch@bank.example', attachments,
        content: { rendered: { subject: 'Packet', text: 'Attached.' } },
      });
      expect(result).toMatchObject({ sent: true, receipt: { id: 'r1', status: 'SENT' } });
      expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'branch@bank.example', attachments }));
      const record = outbound.recordImmediate.mock.calls[0][0];
      expect(record).toMatchObject({ kind: 'BRANCH_AUDIT_PACKET', subject: 'Packet', sent: true });
      expect(JSON.stringify(record)).not.toContain('Attached.');
      expect(outbound.enqueue).not.toHaveBeenCalled();
    });

    it('reports a refusal with the server\'s reason and whether retrying could help', async () => {
      const { service } = setup({ send: { success: false, error: '550 no such user', permanent: true } });
      const result = await service.sendNow({ kind: 'REGISTRATION_OTP', to: 'x@example.com', content: { rendered: { subject: 's', text: 'code 123456' } } });
      expect(result).toMatchObject({ sent: false, error: '550 no such user', permanent: true, receipt: { status: 'FAILED' } });
    });

    it('says plainly when email is not set up', async () => {
      const { service } = setup({ enabled: false, send: { success: false, error: 'Email is not configured.', permanent: true } });
      const result = await service.sendNow({ kind: 'MFA_CODE', to: 'x@example.com', content: { rendered: { subject: 's', text: 't' } } });
      expect(result.error).toBe('Email is not set up on this system, so it was not sent.');
    });

    it('never reaches the mail server with a message it could not prepare', async () => {
      const { service, transport } = setup({ renderThrows: true });
      const result = await service.sendNow({ kind: 'TEMPLATE_TEST', to: 'x@example.com', content: { template: 'registration-invite', data: {} } });
      expect(result.sent).toBe(false);
      expect(transport.send).not.toHaveBeenCalled();
    });
  });
});
