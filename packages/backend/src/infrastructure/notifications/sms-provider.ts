import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Outbound SMS, delivered alongside email when HR issues app access in bulk.
 *
 * Email alone was not enough for this rollout: 540 of 548 active assayers never had a password
 * set, and a field auditor standing inside a bank vault has no reliable way to check an inbox
 * mid-shift. A phone number is the contact detail this workforce actually has on them, so the
 * temporary password goes out by SMS too.
 *
 * Unlike `EmailProvider`, this is not a Platform Settings screen — there is exactly one vendor
 * wired up (MSG91, India-first transactional SMS; every phone number on this platform is
 * Indian), so there is no transport for an operator to choose between. Configuration is three
 * plain environment variables, read once at boot.
 *
 * Degradation follows the same house rule as `EmailProvider` when SMTP is unset: warn once,
 * stay disabled, and answer every send with `false` instead of throwing. SMS being unconfigured
 * must never break the action that wanted to send one — bulk app-access issuance still delivers
 * by email when this returns false.
 */
@Injectable()
export class SmsProvider implements OnModuleInit {
  private readonly logger = new Logger(SmsProvider.name);
  private apiKey: string | undefined;
  private senderId: string | undefined;
  private route = '4';

  onModuleInit(): void {
    this.apiKey = process.env.SMS_PROVIDER_API_KEY?.trim() || undefined;
    this.senderId = process.env.SMS_SENDER_ID?.trim() || undefined;
    // MSG91's own default route for a transactional (as opposed to promotional) message.
    this.route = process.env.SMS_ROUTE?.trim() || '4';

    if (!this.isConfigured()) {
      // One line at boot, not one per send: a credential-issuance run can touch hundreds of
      // people in a batch, and repeating this warning for each of them would drown the log
      // without telling an operator anything the first line didn't already say.
      this.logger.warn(
        'SMS is not configured (need SMS_PROVIDER_API_KEY and SMS_SENDER_ID) — SMS delivery is ' +
          'disabled. Credentials issued to assayers will go out by email only until MSG91 is set up.',
      );
    }
  }

  isEnabled(): boolean {
    return this.isConfigured();
  }

  private isConfigured(): boolean {
    return !!this.apiKey && !!this.senderId;
  }

  /**
   * Best-effort send: never throws.
   *
   * A rejected number, a network blip, a non-2xx from MSG91 — all of it is caught here and
   * turned into `false`, the same way `EmailProvider.send` turns a bounced SMTP call into a
   * result rather than an exception. The caller (bulk app-access issuance) treats a failed SMS
   * exactly like a failed email: one channel among possibly two, not a reason to abort the rest
   * of the batch.
   */
  async send(toPhoneE164OrIndian: string, message: string): Promise<boolean> {
    if (!this.isConfigured()) return false;

    const to = this.normalizePhone(toPhoneE164OrIndian);
    if (!to) return false;

    try {
      const res = await fetch('https://api.msg91.com/api/v2/sendsms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // MSG91 authenticates the whole request off this header, never a query parameter —
          // keeping the key out of anything that ends up in an access log.
          authkey: this.apiKey as string,
        },
        body: JSON.stringify({
          sender: this.senderId,
          route: this.route,
          country: '91',
          sms: [{ message, to: [to] }],
        }),
      });

      if (!res.ok) {
        this.logger.warn(`MSG91 SMS send failed with HTTP ${res.status}.`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.warn(`MSG91 SMS send failed: ${err?.message ?? 'network error'}.`);
      return false;
    }
  }

  /**
   * The roster holds Indian numbers in several shapes (bare 10-digit, a leading 0, a leading
   * 91, occasionally a `+`); MSG91's API wants bare digits with the country code and nothing
   * else.
   */
  private normalizePhone(raw: string): string | null {
    const digits = (raw ?? '').replace(/\D/g, '');
    if (!digits) return null;
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    if (digits.length === 12 && digits.startsWith('91')) return digits;
    return digits;
  }
}
