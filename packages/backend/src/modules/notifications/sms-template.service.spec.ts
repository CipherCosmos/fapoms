import { BadRequestException, Logger } from '@nestjs/common';
import { SmsTemplateService } from './sms-template.service';
import { MessageTokensService } from '../../infrastructure/notifications/message-tokens';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { SMS_TEMPLATE_REGISTRY } from '../../infrastructure/notifications/sms-template-registry';
import { smsTemplateTokens, toDltForm } from '@fapoms/shared';

/**
 * SMS wording, with the administrator's overrides layered on.
 *
 * Under DLT the text that leaves must match, word for word, a template registered on the portal, and
 * carry that template's id. So the two ways this can go wrong are both costly and silent: a saved
 * text that lost its `{{code}}` sends a one-time-code message with no code in it, and a text sent
 * without its DLT id is blocked by the operators after the gateway has billed for it. Pinned against
 * the real `PlatformSettingsService` over an in-memory table.
 */
describe('SmsTemplateService', () => {
  let warnSpy: jest.SpyInstance;

  const settingsWith = (templates?: unknown) => {
    const table = new Map<string, any>();
    if (templates !== undefined) table.set('sms.templates', { key: 'sms.templates', value: templates, isSecret: false });
    const repository = {
      find: async () => [...table.values()],
      findOne: async ({ where: { key } }: any) => table.get(key) ?? null,
      save: async (row: any) => { table.set(row.key, row); return row; },
      create: (row: any) => row,
      delete: async ({ key }: any) => { table.delete(key); },
    };
    const cache = { wrap: (_k: string, _t: number, load: () => Promise<unknown>) => load(), del: async () => undefined };
    return { settings: new PlatformSettingsService(repository as never, cache as never), table };
  };

  const serviceWith = (templates?: unknown) => {
    const { settings, table } = settingsWith(templates);
    const service = new SmsTemplateService(settings);
    service.onModuleInit();
    return { service, settings, table };
  };

  const MFA = { code: '482910', validMinutes: '5' };

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  describe('render', () => {
    it('sends the standard wording when nothing is saved, and says what it costs', async () => {
      const { service } = serviceWith();

      await expect(service.render('mfa-code', MFA)).resolves.toEqual({
        text: 'Greetings from Sumeru Global Support Solutions Pvt. Ltd.! Use 482910 to sign in. '
          + 'The code is valid for 5 minutes. Do not share this code with anyone.',
        // No id yet: this wording is still waiting to be registered on DLT.
        dltTemplateId: null,
        label: 'Sign-in verification code',
        segments: 1,
        encoding: 'GSM-7',
      });
    });

    it('sends the saved wording, with its DLT template id attached', async () => {
      const { service } = serviceWith({
        'mfa-code': { text: 'Sumeru code {{code}}, valid {{validMinutes}} min.', dltTemplateId: '1107160000000012345' },
      });

      await expect(service.render('mfa-code', MFA)).resolves.toMatchObject({
        text: 'Sumeru code 482910, valid 5 min.',
        dltTemplateId: '1107160000000012345',
      });
    });

    it('attaches a DLT template id saved on its own to the standard wording', async () => {
      const { service } = serviceWith({ 'registration-otp': { dltTemplateId: '1107160000000099999' } });

      const rendered = await service.render('registration-otp', MFA);

      expect(rendered.text).toContain('Use 482910 to verify your profile');
      // An id recorded by an administrator wins over the one that ships with the wording.
      expect(rendered.dltTemplateId).toBe('1107160000000099999');
    });

    /** A code message with no code in it is worse than the standard wording. */
    it('sends the standard wording when the saved text lost a required value, and logs which — never the text', async () => {
      const saved = 'SECRET-WORDING your code expires in {{validMinutes}} minutes';
      const { service } = serviceWith({ 'mfa-code': { text: saved, dltTemplateId: '1107160000000012345' } });

      const rendered = await service.render('mfa-code', MFA);

      expect(rendered.text).toContain('Use 482910 to sign in');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('{{code}}'));
      expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('SECRET-WORDING');
    });

    it('counts Unicode wording as UCS-2 and its parts at 70/67', async () => {
      const { service } = serviceWith({
        notification: { text: `सूचना: {{title}}. {{message}} ${'अ'.repeat(60)}` },
      });

      const rendered = await service.render('notification', { title: 'T', message: 'M' });

      expect(rendered.encoding).toBe('UCS-2');
      expect(rendered.segments).toBe(2);
    });

    it('still refuses to render without a required value', async () => {
      const { service } = serviceWith();
      await expect(service.render('mfa-code', { code: '1' })).rejects.toThrow(/validMinutes/);
    });

    /** Saved through the generic settings route rather than this service — the change listener is what clears the copy. */
    it('picks up a save at once, instead of sending the cached wording', async () => {
      const { service, settings } = serviceWith();
      await service.render('mfa-code', MFA);

      await settings.set('sms.templates', { 'mfa-code': { text: 'New {{code}} {{validMinutes}}' } }, 'u-1');

      await expect(service.render('mfa-code', MFA)).resolves.toMatchObject({ text: 'New 482910 5' });
    });
  });

  /**
   * A DLT CONTENT TEMPLATE ID IS REGISTERED AGAINST WORDS, NOT AGAINST A FEATURE.
   *
   * The operations team registered the registration code wording on DLT and gave us its id, so that
   * one text can go out of the box. What must never follow from that is an id being attached to
   * wording it was not registered for: the operator matches the text it receives against the
   * registered template, and a mismatch is not a bounced message — it is the kind of thing that
   * gets a sender header suspended for the whole company.
   */
  describe('the DLT id that ships with the standard wording', () => {
    it('is attached when the standard wording is what goes out', async () => {
      const { service } = serviceWith();

      const rendered = await service.render('registration-otp', { code: '849201', validMinutes: '5' });

      expect(rendered.dltTemplateId).toBe(SMS_TEMPLATE_REGISTRY['registration-otp'].defaultDltTemplateId);
      expect(rendered.text).toBe(SMS_TEMPLATE_REGISTRY['registration-otp'].defaultText
        .replace('{{code}}', '849201').replace('{{validMinutes}}', '5'));
    });

    it('is NOT inherited by wording an administrator wrote, which was never registered under it', async () => {
      const { service } = serviceWith({
        'registration-otp': { text: 'Your code is {{code}}, good for {{validMinutes}} minutes.' },
      });

      const rendered = await service.render('registration-otp', { code: '849201', validMinutes: '5' });

      expect(rendered.text).toContain('Your code is 849201');
      // No id at all, so the send is refused here rather than mismatching at the operator.
      expect(rendered.dltTemplateId).toBeNull();
    });

    it('comes back when saved wording is rejected and the standard wording is sent instead', async () => {
      const { service } = serviceWith({ 'registration-otp': { text: 'No code here, {{validMinutes}} minutes.' } });

      const rendered = await service.render('registration-otp', { code: '849201', validMinutes: '5' });

      expect(rendered.text).toBe(SMS_TEMPLATE_REGISTRY['registration-otp'].defaultText
        .replace('{{code}}', '849201').replace('{{validMinutes}}', '5'));
      expect(rendered.dltTemplateId).toBe(SMS_TEMPLATE_REGISTRY['registration-otp'].defaultDltTemplateId);
    });

    /**
     * The words are the registered ones, so a placeholder in the firm's name would break the match:
     * {{companyName}} resolves to whatever Platform Settings holds, which is not the legal name DLT
     * has on file. This is the one template whose wording may not be made more dynamic.
     */
    it('keeps the registered wording literal, with only the code and the validity as variables', () => {
      const def = SMS_TEMPLATE_REGISTRY['registration-otp'];

      expect(smsTemplateTokens(def.defaultText)).toEqual(['code', 'validMinutes']);
      expect(def.defaultText).toContain('Sumeru Global Support Solutions Pvt. Ltd.');
      expect(toDltForm(def.defaultText)).toBe(
        'Greetings from Sumeru Global Support Solutions Pvt. Ltd.! Use {#var#} to verify your profile. '
        + 'OTP is valid for {#var#} minutes. Do not share this OTP with anyone.',
      );
    });
  });

  describe('saveOverride', () => {
    it('refuses wording that lost a required value, and names it', async () => {
      const { service, table } = serviceWith();

      await expect(service.saveOverride('mfa-code', { text: 'Your code expires in {{validMinutes}} minutes' }))
        .rejects.toThrow(/must still contain \{\{code\}\}/);
      expect(table.has('sms.templates')).toBe(false);
    });

    it('refuses a value this text cannot fill in', async () => {
      const { service } = serviceWith();

      await expect(service.saveOverride('mfa-code', { text: '{{code}} {{validMinutes}} {{fullName}}' }))
        .rejects.toThrow(/\{\{fullName\}\} cannot be filled in/);
    });

    it.each(['DLT-123', '1107 1600', 'abc'])('refuses the DLT template id %p — they are digits', async (id) => {
      const { service } = serviceWith();

      await expect(service.saveOverride('mfa-code', { dltTemplateId: id })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an unknown template', async () => {
      const { service } = serviceWith();
      await expect(service.saveOverride('no-such-text', { text: 'x' })).rejects.toThrow(/Unknown SMS template/);
    });

    it('stores wording and id, leaves other templates alone, and a field left out unchanged', async () => {
      const { service, settings } = serviceWith({ notification: { dltTemplateId: '555' } });

      await service.saveOverride('mfa-code', { text: 'Code {{code}} for {{validMinutes}} min', dltTemplateId: '1107160000000012345' });
      const view = await service.saveOverride('mfa-code', { dltTemplateId: '1107160000000054321' });

      expect(await settings.get('sms.templates')).toEqual({
        notification: { dltTemplateId: '555' },
        'mfa-code': { text: 'Code {{code}} for {{validMinutes}} min', dltTemplateId: '1107160000000054321' },
      });
      expect(view).toMatchObject({
        overrideText: 'Code {{code}} for {{validMinutes}} min',
        dltForm: 'Code {#var#} for {#var#} min',
        preview: 'Code 482910 for 5 min',
      });
    });

    it('treats empty wording as "back to the standard wording"', async () => {
      const { service, settings } = serviceWith({ 'mfa-code': { text: 'Code {{code}} {{validMinutes}}' } });

      await service.saveOverride('mfa-code', { text: '', dltTemplateId: null });

      expect(await settings.get('sms.templates')).toBeNull();
    });
  });

  describe('describeAll', () => {
    it('shows every template with its standard wording, DLT form, sample preview and cost', async () => {
      const { service } = serviceWith({ 'mfa-code': { text: 'Lost its code {{validMinutes}}', dltTemplateId: '1' } });

      const views = await service.describeAll();

      expect(views.map((v) => v.key)).toEqual(Object.keys(SMS_TEMPLATE_REGISTRY));
      const mfa = views.find((v) => v.key === 'mfa-code')!;
      expect(mfa).toMatchObject({
        defaultText: SMS_TEMPLATE_REGISTRY['mfa-code'].defaultText,
        overrideText: 'Lost its code {{validMinutes}}',
        overrideRejected: true,
        dltTemplateId: '1',
        dltForm: 'Greetings from Sumeru Global Support Solutions Pvt. Ltd.! Use {#var#} to sign in. '
          + 'The code is valid for {#var#} minutes. Do not share this code with anyone.',
        preview: 'Greetings from Sumeru Global Support Solutions Pvt. Ltd.! Use 482910 to sign in. '
          + 'The code is valid for 5 minutes. Do not share this code with anyone.',
        segments: 1,
        encoding: 'GSM-7',
      });
    });
  });

  /** What a caller needs to send a test of one template: its sample values and its DLT id. */
  /**
   * The preview is also the price tag: the number of parts beside it is what the gateway bills, and
   * a name is 10-15 characters of it. A preview that left the shared placeholders empty would
   * understate the length AND read as a broken placeholder — so wording using {{name}} previews
   * with a sample name in it, and the count goes up accordingly.
   */
  describe('a preview of wording that uses the values every message carries', () => {
    const withTokens = (templates?: unknown) => {
      const { settings } = settingsWith(templates);
      const tokens = new MessageTokensService(settings);
      const service = new SmsTemplateService(settings, tokens);
      service.onModuleInit();
      return service;
    };

    it('fills them with sample values rather than leaving blanks in the preview', async () => {
      const service = withTokens({ 'mfa-code': { text: 'Hi {{name}}, {{code}} expires in {{validMinutes}} min.' } });

      const view = await service.describe('mfa-code');

      expect(view.preview).toBe('Hi Ramesh Kumar, 482910 expires in 5 min.');
      expect(view.preview).not.toContain('{{');
    });

    it('counts the parts with those values in, so the cost shown is the cost billed', async () => {
      // Every required value is present, or the saved wording is rejected and the default counted.
      const filler = 'x'.repeat(145);
      const withoutName = `{{code}} {{validMinutes}} ${filler}`;
      const withName = `${withoutName} {{name}}`;

      const shorter = await withTokens({ 'mfa-code': { text: withoutName } }).describe('mfa-code');
      const longer = await withTokens({ 'mfa-code': { text: withName } }).describe('mfa-code');

      // The same wording plus a name crosses 160 GSM-7 characters — a second part, and a second charge.
      expect(shorter.segments).toBe(1);
      expect(longer.segments).toBe(2);
    });
  });

  describe('describe', () => {
    it('shows one template exactly as the list shows it', async () => {
      const { service } = serviceWith({ 'mfa-code': { text: 'Code {{code}} for {{validMinutes}} min.', dltTemplateId: '1107160000000012345' } });

      const view = await service.describe('mfa-code');

      expect(view).toEqual((await service.describeAll()).find((v) => v.key === 'mfa-code'));
      expect(view).toMatchObject({
        key: 'mfa-code',
        sampleData: SMS_TEMPLATE_REGISTRY['mfa-code'].sampleData,
        dltTemplateId: '1107160000000012345',
        preview: 'Code 482910 for 5 min.',
      });
    });

    /**
     * The key arrives off a URL. Answering `undefined` would put the word "undefined" in a text two
     * calls later, so it is refused here with the key in the sentence.
     */
    it('refuses a key that is not a template, naming it', async () => {
      const { service } = serviceWith();

      await expect(service.describe('made-up')).rejects.toThrow(BadRequestException);
      await expect(service.describe('made-up')).rejects.toThrow(/made-up/);
    });
  });
});
