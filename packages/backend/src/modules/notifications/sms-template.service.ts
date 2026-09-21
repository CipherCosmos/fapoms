import { BadRequestException, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import {
  DLT_ID_PATTERN, countSmsSegments, fillSmsTemplate, smsTemplateTokens, smsWordingProblems, toDltForm, type SmsEncoding,
} from '@fapoms/shared';
import { SMS_TEMPLATE_REGISTRY, SmsTemplateDefinition, SmsTemplateKey } from '../../infrastructure/notifications/sms-template-registry';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { MessageTokensService, SAMPLE_RECIPIENT } from '../../infrastructure/notifications/message-tokens';

export interface RenderedSms {
  text: string;
  /** The DLT content template id recorded for this template, if any. */
  dltTemplateId: string | null;
  /** What the ledger shows in place of a subject: the template's name. */
  label: string;
  /** How many SMS parts the text goes out as — what the gateway bills. */
  segments: number;
  encoding: SmsEncoding;
}

/** One template's saved override, as stored under `sms.templates`. */
export interface SmsTemplateOverride {
  text?: string;
  dltTemplateId?: string;
}

export type SmsTemplateOverrides = Partial<Record<SmsTemplateKey, SmsTemplateOverride>>;

/** One template as the settings screen shows it. */
export interface SmsTemplateView {
  key: SmsTemplateKey;
  name: string;
  description: string;
  defaultText: string;
  /** The DLT form of the text in force — what to register on the portal. */
  dltForm: string;
  requiredTokens: readonly string[];
  sampleData: Record<string, string>;
  /** The saved wording, or null when the default is in force by choice. */
  overrideText: string | null;
  /** The id in force — an administrator's, or the one that ships with the standard wording. */
  dltTemplateId: string | null;
  /**
   * Only the id an administrator recorded here. The editing screen must offer THIS and not the one
   * above: a built-in id belongs to the built-in words, and filling it into the box beside somebody's
   * own wording is how that wording gets saved under an id it was never registered for.
   */
  savedDltTemplateId: string | null;
  /** True when the id in force came with the platform rather than being typed on this screen. */
  dltTemplateIdIsBuiltIn: boolean;
  /** True when saved wording exists but is not being sent, because it lost a required value. */
  overrideRejected: boolean;
  /** The text in force, filled with the sample data. */
  preview: string;
  segments: number;
  encoding: SmsEncoding;
}

/** Long enough for any real template; a DLT portal refuses far shorter ones than this cap. */
export const SMS_TEMPLATE_MAX_LENGTH = 1000;
/**
 * How long a replica trusts its copy of the overrides. A save on THIS replica clears it at once
 * (`onChange`); a save on another replica reaches this one within this window rather than never.
 */
const OVERRIDES_TTL_MS = 30_000;
const SETTING_KEY = 'sms.templates';

/**
 * Turns an SMS template key and its data into the exact text that is sent.
 *
 * The one place SMS wording is resolved. Administrator overrides (edited text, DLT template id) are
 * layered on here — never at a call site — and saved here, so the rule that decides whether saved
 * wording may be sent is the same rule that decided whether it could be saved.
 */
@Injectable()
export class SmsTemplateService implements OnModuleInit {
  private readonly logger = new Logger(SmsTemplateService.name);
  private cached: { at: number; overrides: SmsTemplateOverrides } | null = null;

  constructor(
    @Optional() private readonly settings?: PlatformSettingsService,
    /** For the preview only: the values every message carries, so a preview is what is really sent. */
    @Optional() private readonly tokens?: MessageTokensService,
  ) {}

  onModuleInit(): void {
    this.settings?.onChange(SETTING_KEY, () => {
      this.cached = null;
    });
  }

  async render(key: SmsTemplateKey, data: Record<string, unknown>): Promise<RenderedSms> {
    const def = SMS_TEMPLATE_REGISTRY[key];
    if (!def) throw new Error(`Unknown SMS template "${key}".`);
    for (const token of def.requiredTokens) {
      const value = data[token];
      if (value === undefined || value === null || String(value) === '') {
        throw new Error(`The "${def.name}" text needs a value for {{${token}}}.`);
      }
    }
    const override = (await this.overrides())[key];
    const resolved = this.resolve(def, override);
    const text = fillSmsTemplate(resolved.template, data);
    const count = countSmsSegments(text);
    return { text, dltTemplateId: resolved.dltTemplateId, label: def.name, segments: count.segments, encoding: count.encoding };
  }

  /** Every template, with its default, its override and a sample, for the settings screen. */
  async describeAll(): Promise<SmsTemplateView[]> {
    const overrides = await this.overrides(true);
    return Promise.all((Object.keys(SMS_TEMPLATE_REGISTRY) as SmsTemplateKey[]).map((key) => this.view(key, overrides[key])));
  }

  /**
   * One template, the same way `describeAll` shows it — what a caller needs to send a test of it.
   *
   * The key comes off a URL, so an unknown one is a bad request with the key in it, not a crash or
   * an `undefined` that turns into a text with the word "undefined" in it two calls later.
   */
  async describe(key: string): Promise<SmsTemplateView> {
    const def = SMS_TEMPLATE_REGISTRY[key as SmsTemplateKey];
    if (!def) throw new BadRequestException(`Unknown SMS template "${key}".`);
    const overrides = await this.overrides(true);
    return this.view(def.key, overrides[def.key]);
  }

  /**
   * Saves one template's wording and DLT template id, after the checks that make it sendable.
   *
   * A field left out is left as it is; an empty text means "use the standard wording" and an empty
   * id clears it. Refused with a sentence the administrator can act on — never stored and then
   * silently ignored at send time.
   */
  async saveOverride(key: string, input: { text?: string | null; dltTemplateId?: string | null }, userId?: string): Promise<SmsTemplateView> {
    const def = SMS_TEMPLATE_REGISTRY[key as SmsTemplateKey];
    if (!def) throw new BadRequestException(`Unknown SMS template "${key}".`);
    if (!this.settings) throw new BadRequestException('Text message wording cannot be saved: platform settings are unavailable.');

    const problems = validateSmsTemplateInput(def, input);
    if (problems.length) throw new BadRequestException(problems.join(' '));

    // Read fresh, not from the send-path cache: this write replaces the whole map.
    const current = normaliseOverrides(await this.settings.get(SETTING_KEY));
    const existing = current[def.key] ?? {};
    const text = input.text === undefined ? (existing.text ?? '') : (input.text?.trim() ?? '');
    const dltTemplateId = input.dltTemplateId === undefined ? (existing.dltTemplateId ?? '') : (input.dltTemplateId?.trim() ?? '');
    const next: SmsTemplateOverride = {};
    // Wording identical to the default is stored as "no override", so a later improvement to the
    // default reaches this template instead of being pinned by a copy of the old one.
    if (text && text !== def.defaultText) next.text = text;
    if (dltTemplateId) next.dltTemplateId = dltTemplateId;

    const all: SmsTemplateOverrides = { ...current };
    if (next.text || next.dltTemplateId) all[def.key] = next;
    else delete all[def.key];

    await this.settings.set(SETTING_KEY, Object.keys(all).length ? all : null, userId);
    this.cached = null;
    return this.view(def.key, all[def.key]);
  }

  private async view(key: SmsTemplateKey, override: SmsTemplateOverride | undefined): Promise<SmsTemplateView> {
    const def = SMS_TEMPLATE_REGISTRY[key];
    const resolved = this.resolve(def, override, false);
    /*
      The preview fills the values every message carries as well as this template's own sample data.
      Two reasons, and the second is the one that costs money: a {{name}} left blank reads as a
      broken placeholder and gets taken back out of the wording, and the length shown beside it —
      which is how many SMS parts this text is billed as — would be short by the length of a name.
    */
    const common = (await this.tokens?.common(SAMPLE_RECIPIENT)) ?? {};
    const preview = fillSmsTemplate(resolved.template, { ...common, ...def.sampleData });
    const count = countSmsSegments(preview);
    return {
      key,
      name: def.name,
      description: def.description,
      defaultText: def.defaultText,
      dltForm: toDltForm(resolved.template),
      requiredTokens: def.requiredTokens,
      sampleData: def.sampleData,
      overrideText: override?.text ?? null,
      dltTemplateId: resolved.dltTemplateId,
      savedDltTemplateId: override?.dltTemplateId?.trim() || null,
      dltTemplateIdIsBuiltIn: !!resolved.dltTemplateId && !override?.dltTemplateId?.trim(),
      overrideRejected: resolved.rejected,
      preview,
      segments: count.segments,
      encoding: count.encoding,
    };
  }

  /**
   * The wording in force: the override's text only while it still carries every required value.
   *
   * A saved text can lose that property without anyone editing it — a code change that makes a new
   * value required — and sending it would deliver a code message with no code in it. The default is
   * sent instead, and said so in the log (by template name; the text itself is never logged).
   */
  private resolve(def: SmsTemplateDefinition, override: SmsTemplateOverride | undefined, log = true) {
    const saved = override?.dltTemplateId?.trim() || null;
    /*
      A built-in id belongs to the built-in WORDING, not to the template key.

      `defaultDltTemplateId` is the id the operations team registered against the exact words in the
      registry. The moment an administrator writes their own wording, those words are not what is
      registered under that id, and sending them under it is how an operator comes to block a
      header. So edited wording inherits nothing: it carries the id its author recorded beside it,
      or none at all — and a text with no id is refused here rather than at the gateway.
    */
    const idFor = (template: string) => saved ?? (template === def.defaultText ? (def.defaultDltTemplateId ?? null) : null);

    const text = override?.text?.trim();
    if (!text) return { template: def.defaultText, dltTemplateId: idFor(def.defaultText), rejected: false };
    const missing = missingTokens(def, text);
    if (missing.length === 0) return { template: text, dltTemplateId: idFor(text), rejected: false };
    if (log) {
      this.logger.warn(
        `The saved "${def.name}" SMS wording is missing ${missing.map((t) => `{{${t}}}`).join(', ')}; the standard wording is being sent instead.`,
      );
    }
    // Rejected: the DEFAULT wording is what goes out, so the default's own id is the right one.
    return { template: def.defaultText, dltTemplateId: idFor(def.defaultText), rejected: true };
  }

  private async overrides(fresh = false): Promise<SmsTemplateOverrides> {
    if (!this.settings) return {};
    if (!fresh && this.cached && Date.now() - this.cached.at < OVERRIDES_TTL_MS) return this.cached.overrides;
    try {
      const overrides = normaliseOverrides(await this.settings.get(SETTING_KEY));
      this.cached = { at: Date.now(), overrides };
      return overrides;
    } catch (err: any) {
      // A settings store that cannot answer must not stop a one-time code: the defaults still send.
      this.logger.warn(`Could not read SMS template overrides, using the standard wording: ${err?.message ?? err}`);
      return this.cached?.overrides ?? {};
    }
  }
}

function missingTokens(def: SmsTemplateDefinition, text: string): string[] {
  const present = new Set(smsTemplateTokens(text));
  return def.requiredTokens.filter((t) => !present.has(t));
}

/**
 * The checks a template edit must pass before it is saved, as sentences. Empty when it may be saved.
 * The wording rule is `smsWordingProblems` in `@fapoms/shared`, the one the settings screen shows live.
 */
export function validateSmsTemplateInput(
  def: SmsTemplateDefinition,
  input: { text?: string | null; dltTemplateId?: string | null },
): string[] {
  const problems: string[] = [];
  const text = input.text?.trim() ?? '';
  if (text) {
    if (text.length > SMS_TEMPLATE_MAX_LENGTH) {
      problems.push(`The wording is ${text.length} characters; keep it under ${SMS_TEMPLATE_MAX_LENGTH}.`);
    }
    problems.push(...smsWordingProblems(text, def.requiredTokens));
  }
  const dltTemplateId = input.dltTemplateId?.trim() ?? '';
  if (dltTemplateId && !DLT_ID_PATTERN.test(dltTemplateId)) {
    problems.push('A DLT Template ID is digits only — copy it exactly from your DLT portal.');
  }
  return problems;
}

/** Whatever is stored, reduced to the shape this service writes — a hand-edited row cannot crash a send. */
function normaliseOverrides(raw: unknown): SmsTemplateOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: SmsTemplateOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(key in SMS_TEMPLATE_REGISTRY) || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const entry: SmsTemplateOverride = {};
    if (typeof v.text === 'string' && v.text.trim()) entry.text = v.text;
    if (typeof v.dltTemplateId === 'string' && v.dltTemplateId.trim()) entry.dltTemplateId = v.dltTemplateId.trim();
    if (entry.text || entry.dltTemplateId) out[key as SmsTemplateKey] = entry;
  }
  return out;
}
