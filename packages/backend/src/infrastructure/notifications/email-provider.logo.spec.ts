const sendMailMock = jest.fn();
const createTransportMock = jest.fn();
jest.mock('nodemailer', () => ({ createTransport: createTransportMock }), { virtual: false });

import { EmailProvider } from './email-provider';
import { SUMERU_LOGO_CID, getSumeruLogoBuffer } from './sumeru-logo.asset';

describe('EmailProvider — Company Logo CID Attachments', () => {
  let provider: EmailProvider;

  beforeEach(async () => {
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ messageId: 'test-msg-123' });
    createTransportMock.mockReset();
    createTransportMock.mockReturnValue({
      sendMail: sendMailMock,
      close: jest.fn(),
    });

    process.env.GMAIL_USER = 'notifications@sumeruglobal.com';
    process.env.GMAIL_APP_PASSWORD = 'app-password-123';

    provider = new EmailProvider();
    await provider.reconfigure();
  });

  afterEach(() => {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
  });

  it('normalizes external sumeru-logo URLs to cid:sumeru-logo and attaches inline PNG', async () => {
    const htmlWithRemoteLogo = '<html><body><img src="https://fapoms.sumeruglobal.com/sumeru-logo@2x.png" alt="Sumeru" /></body></html>';

    const result = await provider.send({
      to: 'candidate@example.com',
      subject: 'Welcome',
      text: 'Welcome',
      html: htmlWithRemoteLogo,
    });

    expect(result.success).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const callArgs = sendMailMock.mock.calls[0][0];
    expect(callArgs.html).toContain('src="cid:sumeru-logo"');
    expect(callArgs.html).not.toContain('https://fapoms.sumeruglobal.com/sumeru-logo@2x.png');

    expect(callArgs.attachments).toBeDefined();
    const logoAttachment = callArgs.attachments.find((a: any) => a.cid === SUMERU_LOGO_CID);
    expect(logoAttachment).toBeDefined();
    expect(logoAttachment.filename).toBe('sumeru-logo.png');
    expect(logoAttachment.contentType).toBe('image/png');
    expect(logoAttachment.contentDisposition).toBe('inline');
    expect(Buffer.isBuffer(logoAttachment.content)).toBe(true);
    // Check PNG header (0x89 'P' 'N' 'G')
    expect(logoAttachment.content.slice(1, 4).toString()).toBe('PNG');
  });

  it('normalizes {{logoUrl}} template token to cid:sumeru-logo and attaches inline PNG', async () => {
    const htmlWithToken = '<html><body><img src="{{logoUrl}}" alt="Sumeru Global" /></body></html>';

    const result = await provider.send({
      to: 'candidate@example.com',
      subject: 'Verification Code',
      text: 'Your code is 123456',
      html: htmlWithToken,
    });

    expect(result.success).toBe(true);
    const callArgs = sendMailMock.mock.calls[0][0];
    expect(callArgs.html).toContain('src="cid:sumeru-logo"');
    expect(callArgs.html).not.toContain('{{logoUrl}}');

    const logoAttachment = callArgs.attachments.find((a: any) => a.cid === SUMERU_LOGO_CID);
    expect(logoAttachment).toBeDefined();
    expect(logoAttachment.contentDisposition).toBe('inline');
  });

  it('attaches inline PNG when cid:sumeru-logo is already in the HTML', async () => {
    const htmlWithCid = '<html><body><img src="cid:sumeru-logo" alt="Sumeru Global" /></body></html>';

    const result = await provider.send({
      to: 'candidate@example.com',
      subject: 'Notice',
      text: 'Notice text',
      html: htmlWithCid,
    });

    expect(result.success).toBe(true);
    const callArgs = sendMailMock.mock.calls[0][0];
    expect(callArgs.html).toContain('src="cid:sumeru-logo"');

    const logoAttachment = callArgs.attachments.find((a: any) => a.cid === SUMERU_LOGO_CID);
    expect(logoAttachment).toBeDefined();
  });

  it('preserves existing attachments while adding the logo attachment', async () => {
    const pdfBuffer = Buffer.from('%PDF-1.4 test');
    const html = '<html><body><img src="{{logoUrl}}" /></body></html>';

    await provider.send({
      to: 'candidate@example.com',
      subject: 'Paperwork',
      text: 'See attached',
      html,
      attachments: [
        {
          filename: 'report.pdf',
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    const callArgs = sendMailMock.mock.calls[0][0];
    expect(callArgs.attachments).toHaveLength(2);
    expect(callArgs.attachments[0]).toEqual({
      filename: 'report.pdf',
      content: pdfBuffer,
      contentType: 'application/pdf',
      cid: undefined,
      contentDisposition: 'attachment',
    });
    expect(callArgs.attachments[1].cid).toBe(SUMERU_LOGO_CID);
  });

  it('does not add logo attachment for plain text emails without logo references', async () => {
    await provider.send({
      to: 'candidate@example.com',
      subject: 'Plain text',
      text: 'Hello world',
    });

    const callArgs = sendMailMock.mock.calls[0][0];
    expect(callArgs.attachments).toEqual([]);
  });

  it('getSumeruLogoBuffer returns a valid PNG buffer', () => {
    const buf = getSumeruLogoBuffer();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(1, 4).toString()).toBe('PNG');
  });
});
