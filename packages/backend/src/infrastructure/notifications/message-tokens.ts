import { Injectable, Optional } from '@nestjs/common';
import { BUSINESS_TIME_ZONE, COMMON_MESSAGE_TOKENS, type CommonMessageToken } from '@fapoms/shared';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { appPublicUrl } from './email-provider';

/**
 * FAPOMS — the values every message may use, under the same names everywhere.
 *
 * Each template used to name its own values, so the person's name was `fullName` in one email,
 * `candidateName` in the next and `displayName` in a third, and a text had no way to say "the number
 * this is going to" at all. An administrator editing wording had to learn a different vocabulary per
 * message, and the wording they registered on DLT could not be reused.
 *
 * These are filled for EVERY email and text, so any of them can be used in any wording:
 *
 *   {{name}}         who the message is for, when the sender knows it
 *   {{phone}}        the mobile number it is going to (texts; blank on an email)
 *   {{email}}        the address it is going to (emails; blank on a text)
 *   {{companyName}}  the firm's name, from Platform Settings → Company
 *   {{portalUrl}}    where to open FAPOMS
 *   {{time}}         the time it was sent, e.g. 6:42 pm
 *   {{date}}         the date it was sent, e.g. 19 Sep 2026
 *
 * A value the caller passes always wins, so a template that has its own `name` (a candidate's, not
 * the recipient's) keeps it. Anything specific to one message — a code, a temporary password, a
 * notification's title — stays with that template.
 */

export { COMMON_MESSAGE_TOKENS };
export type { CommonMessageToken };

/** What the sender knows about this one message; everything else is the same for all of them. */
export interface MessageRecipientContext {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

/** The firm's name when Platform Settings has none saved. */
export const DEFAULT_COMPANY_NAME = 'Sumeru Global';

/**
 * Who a PREVIEW is addressed to.
 *
 * A preview that left {{name}} blank would read as a broken placeholder, and an administrator would
 * take it out of the wording — so the screens show these obviously-sample values instead, the same
 * way the rest of a preview uses a template's sample data.
 */
export const SAMPLE_RECIPIENT: MessageRecipientContext = {
  name: 'Ramesh Kumar',
  phone: '+91 98765 43210',
  email: 'ramesh.kumar@example.com',
};

@Injectable()
export class MessageTokensService {
  constructor(
    /** Optional, like every other consumer: without it the defaults below still fill every token. */
    @Optional() private readonly settings?: PlatformSettingsService,
  ) {}

  async common(recipient: MessageRecipientContext = {}, now: Date = new Date()): Promise<Record<CommonMessageToken, string>> {
    const companyName = await this.companyName();
    return {
      name: (recipient.name ?? '').trim(),
      phone: (recipient.phone ?? '').trim(),
      email: (recipient.email ?? '').trim(),
      companyName,
      portalUrl: appPublicUrl(),
      time: formatBusinessTime(now),
      date: formatBusinessDate(now),
    };
  }

  private async companyName(): Promise<string> {
    const saved = await this.settings?.get<string>('company.legalName').catch(() => null);
    const name = typeof saved === 'string' ? saved.trim() : '';
    return name || DEFAULT_COMPANY_NAME;
  }
}

/** 6:42 pm, in the business time zone — the one people in the office read off a clock. */
export function formatBusinessTime(now: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone,
  }).format(now).toLowerCase();
}

/** 19 Sep 2026, in the business time zone. */
export function formatBusinessDate(now: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone,
  }).format(now);
}
