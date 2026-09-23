import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DLT_SENDER_ID_PATTERN, toE164IndianMobile } from '@fapoms/shared';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import type { SmsMessage, SmsSendResult, SmsSendSettings, SmsTransport } from './sms/sms-transport';
import { PinnacleTransport } from './sms/pinnacle.transport';

export { SMS_SEND_TIMEOUT_MS } from './sms/sms-transport';

/**
 * Outbound SMS: whichever gateway is configured, held ready — the SMS twin of `EmailProvider`.
 *
 * The vendor is not chosen yet, so the vendor is an adapter (`sms/sms-transport.ts`) and this is only
 * the holder: it resolves the configuration, builds the adapter it names, and applies the rules every
 * vendor shares. Configuration resolves the way everything else does — **saved settings first,
 * environment second**:
 *
 *   Administration → Platform Settings → SMS delivery   the primary place; takes effect immediately
 *                                       via `reconfigure()`, the key stored encrypted.
 *   SMS_PROVIDER_API_KEY + SMS_SENDER_ID (+ SMS_ROUTE, SMS_DLT_ENTITY_ID)
 *                                       the fallback a deployment configured before the screen
 *                                       existed keeps working on.
 *
 * DLT (India's TRAI regime) is part of the rules, not a vendor extra: once a Principal Entity id is
 * configured, a text without its content template id is refused here — the operators would block it
 * anyway, after the gateway had billed for trying.
 *
 * Unconfigured follows the house degradation pattern: say so once per (re)configuration, stay
 * disabled, and answer every send with a failure result instead of throwing. SMS being unconfigured
 * must never break the action that wanted to send one.
 */

export type SmsProviderName = 'NONE' | 'PINNACLE';

/** What the settings screen shows about SMS — never the key. */
export interface SmsProviderState {
  enabled: boolean;
  /** The gateway chosen (even if something it needs is missing), or null when none is. */
  provider: Exclude<SmsProviderName, 'NONE'> | null;
  senderId: string | null;
  dltEntityIdSet: boolean;
  /** Why it is not sending, in words an administrator can act on; null when it is. */
  problem: string | null;
}

export const SMS_SETTINGS_PLACE = 'Administration → Platform Settings → SMS delivery';

@Injectable()
export class SmsProvider implements OnModuleInit {
  private readonly logger = new Logger(SmsProvider.name);
  private transport: SmsTransport | null = null;
  private sendSettings: SmsSendSettings | null = null;
  private state: SmsProviderState = {
    enabled: false, provider: null, senderId: null, dltEntityIdSet: false,
    problem: `SMS is not set up. Set it up under ${SMS_SETTINGS_PLACE}.`,
  };

  constructor(
    /** Optional, as in `EmailProvider`: without the settings module it reads the environment alone. */
    @Optional() private readonly settings?: PlatformSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reconfigure();
    // A settings screen that accepts a new key and keeps sending with the old one until a restart
    // is a settings screen that lies.
    this.settings?.onChange('sms.', () => this.reconfigure());
  }

  /** (Re)build the gateway from whatever configuration is in force right now. */
  async reconfigure(): Promise<void> {
    const cfg = await this.resolveConfig();
    const senderId = cfg.senderId?.trim() || null;
    const dltEntityId = cfg.dltEntityId?.trim() || null;
    const base = { senderId, dltEntityIdSet: !!dltEntityId };

    this.transport = null;
    this.sendSettings = null;

    if (cfg.provider === 'NONE') {
      const problem = cfg.explicitlyOff
        ? `SMS is switched off in ${SMS_SETTINGS_PLACE}.`
        : `SMS is not set up. Set it up under ${SMS_SETTINGS_PLACE}.`;
      this.state = { ...base, enabled: false, provider: null, problem };
      // One line per configuration, never one per send: a credential run can touch hundreds of people.
      if (cfg.explicitlyOff) this.logger.log('SMS is switched off in platform settings — no text will be sent.');
      else this.logger.warn('SMS is not configured — SMS delivery is disabled. One-time codes and credentials go by email only until it is.');
      return;
    }

    const key = cfg.pinnacleApiKey;
    const problem = !key
      ? 'Pinnacle is chosen but its API key is missing.'
      : !senderId
        ? 'The sender header is missing — enter the 6-letter header approved on your DLT portal.'
        : !DLT_SENDER_ID_PATTERN.test(senderId)
          ? `The sender header "${senderId}" is not 6 letters — enter it exactly as approved on your DLT portal.`
          : null;
    if (problem) {
      this.state = { ...base, enabled: false, provider: 'PINNACLE', problem };
      this.logger.warn(`SMS is disabled: ${problem}`);
      return;
    }

    this.transport = new PinnacleTransport({ apiKey: key as string });
    this.sendSettings = { senderId: (senderId as string).toUpperCase(), dltEntityId };
    this.state = { ...base, senderId: this.sendSettings.senderId, enabled: true, provider: 'PINNACLE', problem: null };
    this.logger.log(`SMS enabled via ${this.transport.name} as ${this.sendSettings.senderId}${dltEntityId ? ' under DLT' : ''}.`);
  }

  isEnabled(): boolean {
    return this.transport !== null;
  }

  /** The configuration in force, as the settings screen needs it. */
  describe(): SmsProviderState {
    return { ...this.state };
  }

  /**
   * One send through the configured gateway. Never throws.
   *
   * Refusals that no retry can fix — no gateway, not a mobile, no DLT template id under DLT — come
   * back `permanent`, so the worker settles them instead of spending its attempts on them.
   */
  /**
   * Why this text cannot be delivered, when that is knowable WITHOUT sending it — or null.
   *
   * No gateway, not a mobile, and a DLT entity with no template id are all facts about the message
   * and the configuration, not about the network. They were checked only here in `send`, which the
   * worker calls after the message was queued — so `SmsService.queue` answered QUEUED for a text
   * that could never go, and every caller counted it as a channel delivered. Approving an appraiser
   * reported their credential as texted while the gateway refused every one for want of a DLT id.
   * One check, used by both, so the queue and the send cannot disagree about what is hopeless.
   */
  preflight(message: Pick<SmsMessage, 'to' | 'dltTemplateId'>): string | null {
    if (!this.transport || !this.sendSettings) return 'SMS is not configured.';
    if (!toE164IndianMobile(message.to)) return 'That is not an Indian mobile number a text can be sent to.';
    if (this.sendSettings.dltEntityId && !message.dltTemplateId?.trim()) {
      return 'This text has no DLT template id; add it under SMS templates in Platform Settings.';
    }
    return null;
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const refused = this.preflight(message);
    if (refused) return { success: false, error: refused, permanent: true };
    const transport = this.transport!;
    const settings = this.sendSettings!;
    const to = toE164IndianMobile(message.to)!;

    try {
      return await transport.send({ ...message, to, dltTemplateId: message.dltTemplateId?.trim() || null }, settings);
    } catch (err: any) {
      // An adapter is written not to throw; this is the belt to that promise, and it names no text.
      this.logger.warn(`${transport.name} SMS send failed unexpectedly: ${err?.message ?? 'unknown error'}.`);
      return { success: false, error: 'The SMS gateway could not be reached.' };
    }
  }

  /** Saved settings first, environment second; the environment alone without the settings module. */
  private async resolveConfig(): Promise<{
    provider: SmsProviderName;
    explicitlyOff: boolean;
    pinnacleApiKey?: string | null;
    senderId?: string | null;
    dltEntityId?: string | null;
  }> {
    if (!this.settings) {
      const pinnacleKey = process.env.SMS_PINNACLE_API_KEY?.trim() || null;
      return {
        provider: (process.env.SMS_PROVIDER?.trim().toUpperCase() as SmsProviderName | undefined)
          ?? (pinnacleKey ? 'PINNACLE' : 'NONE'),
        explicitlyOff: false,
        pinnacleApiKey: pinnacleKey,
        senderId: process.env.SMS_SENDER_ID ?? null,
        dltEntityId: process.env.SMS_DLT_ENTITY_ID ?? null,
      };
    }

    const v = await this.settings
      .getMany(['sms.provider', 'sms.pinnacle.apiKey', 'sms.senderId', 'sms.dltEntityId'])
      .catch(() => ({} as Record<string, any>));
    const chosen = await this.settings.getWithSource<string>('sms.provider').catch(() => null);

    /**
     * "Off" means off — but only when somebody chose it. The same provenance rule as
     * `EmailProvider`: an untouched default defers to a key a pre-settings deployment left in the
     * environment, while an administrator's saved "Off" is never overruled by it.
     */
    // Case-folded: the value can arrive from a hand-edited environment file as well as the screen.
    const named = String(v['sms.provider'] ?? '').trim().toUpperCase();
    let provider: SmsProviderName = named === 'PINNACLE' ? 'PINNACLE' : 'NONE';
    const explicitlyOff = provider === 'NONE' && chosen?.source === 'saved';
    // A deployment that names only its key in the environment still switches SMS on.
    if (provider === 'NONE' && !explicitlyOff && v['sms.pinnacle.apiKey']) provider = 'PINNACLE';

    return {
      provider,
      explicitlyOff,
      pinnacleApiKey: v['sms.pinnacle.apiKey'] ? String(v['sms.pinnacle.apiKey']) : null,
      senderId: v['sms.senderId'] != null ? String(v['sms.senderId']) : null,
      dltEntityId: v['sms.dltEntityId'] != null ? String(v['sms.dltEntityId']) : null,
    };
  }
}
