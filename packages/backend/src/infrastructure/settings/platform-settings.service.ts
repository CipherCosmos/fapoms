import { Injectable, Logger, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PlatformSettingEntity } from './platform-setting.entity';
import { SETTINGS_REGISTRY, SETTING_BY_KEY, SettingDef } from './settings.registry';
import { CacheService } from '../cache/cache.service';
import { encryptField, decryptField } from '../security/field-encryption';

/**
 * Resolves platform configuration, and lets an operator change it without a deploy.
 *
 * Resolution is always **saved value → environment variable → shipped default**, which is what
 * makes this safe to add to a running system: every deployment keeps behaving exactly as it
 * does today until somebody deliberately saves something. The screen shows which of the three
 * is in force for each key, so "why is it doing that" never requires reading code.
 *
 * Values are cached as one map, and the cache lives in Redis — so a change made on one replica
 * is seen by the others rather than lingering until each happens to expire. Every read failure
 * degrades to environment-and-defaults: a settings lookup that cannot answer must never stop
 * the platform pricing an audit or sending an escalation.
 */

const CACHE_KEY = 'ref:platform:settings';
const CACHE_TTL_SECONDS = 60;
/** Returned in place of a stored secret. Never a real value, and never accepted as one. */
export const SECRET_MASK = '••••••••';

export interface ResolvedSetting {
  key: string;
  label: string;
  description: string;
  group: string;
  type: string;
  /** Never the stored ciphertext, and for a secret never the plaintext either. */
  value: any;
  /** Where the value in force came from, so the screen can say so. */
  source: 'saved' | 'environment' | 'default';
  /** True when a secret has been stored — the UI shows "set" without ever showing what. */
  isSet?: boolean;
  envVar?: string;
  secret?: boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  unit?: string;
  applies: string;
  default: any;
}

type ChangeListener = (key: string, value: any) => void | Promise<void>;

@Injectable()
export class PlatformSettingsService implements OnModuleInit {
  private readonly logger = new Logger(PlatformSettingsService.name);

  /**
   * Modules that must *do* something when a value changes — rebuild a mail transport,
   * re-register a cron — register here rather than polling. Keyed by setting key prefix so a
   * listener can watch a whole group ('email.') without naming every field.
   */
  private readonly listeners: Array<{ prefix: string; fn: ChangeListener }> = [];

  constructor(
    @InjectRepository(PlatformSettingEntity)
    private readonly repository: Repository<PlatformSettingEntity>,
    private readonly cache: CacheService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Warm the map so the first request does not pay for it, and so a broken settings table is
    // discovered at boot with a log line rather than mid-request.
    await this.load().catch(() => undefined);
  }

  onChange(prefix: string, fn: ChangeListener): void {
    this.listeners.push({ prefix, fn });
  }

  // ---------------------------------------------------------------- reads

  /** The value in force for one key, already typed. */
  async get<T = any>(key: string): Promise<T> {
    const def = SETTING_BY_KEY[key];
    if (!def) throw new BadRequestException(`Unknown setting "${key}"`);
    const saved = await this.savedValues();
    return this.resolve(def, saved[key]).value as T;
  }

  /**
   * The value AND where it came from.
   *
   * Needed wherever "the operator explicitly chose this" differs from "nobody has said" — the
   * email transport being the case in point: saved `NONE` must switch sending off, while an
   * untouched `NONE` should still honour credentials an older deployment set in the
   * environment.
   */
  async getWithSource<T = any>(key: string): Promise<{ value: T; source: 'saved' | 'environment' | 'default' }> {
    const def = SETTING_BY_KEY[key];
    if (!def) throw new BadRequestException(`Unknown setting "${key}"`);
    const saved = await this.savedValues();
    return this.resolve(def, saved[key]) as { value: T; source: 'saved' | 'environment' | 'default' };
  }

  /** Several at once, for callers that need a whole group without N round trips. */
  async getMany(keys: string[]): Promise<Record<string, any>> {
    const saved = await this.savedValues();
    const out: Record<string, any> = {};
    for (const key of keys) {
      const def = SETTING_BY_KEY[key];
      if (def) out[key] = this.resolve(def, saved[key]).value;
    }
    return out;
  }

  /**
   * A number, guaranteed.
   *
   * Callers are pricing money with these; a saved value that somehow is not numeric must fall
   * back to the shipped default rather than turn a fee into NaN.
   */
  async getNumber(key: string, fallback?: number): Promise<number> {
    const raw = await this.get(key).catch(() => undefined);
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    const def = SETTING_BY_KEY[key];
    return fallback ?? (Number(def?.default) || 0);
  }

  /** Everything, for the settings screen. Secrets are reported as set-or-not, never returned. */
  async describeAll(): Promise<ResolvedSetting[]> {
    const saved = await this.savedValues();
    return SETTINGS_REGISTRY.map((def) => {
      const resolved = this.resolve(def, saved[def.key]);
      const base: ResolvedSetting = {
        key: def.key,
        label: def.label,
        description: def.description,
        group: def.group,
        type: def.type,
        value: resolved.value,
        source: resolved.source,
        envVar: def.envVar,
        secret: def.secret,
        options: def.options,
        min: def.min,
        max: def.max,
        unit: def.unit,
        applies: def.applies,
        default: def.default,
      };
      if (!def.secret) return base;
      // A stored credential is never sent to a browser, not even to the administrator who
      // typed it. The screen needs only to know whether one exists.
      return { ...base, value: resolved.value ? SECRET_MASK : null, isSet: !!resolved.value };
    });
  }

  // ---------------------------------------------------------------- writes

  async set(key: string, rawValue: any, userId?: string): Promise<void> {
    const def = SETTING_BY_KEY[key];
    if (!def) throw new BadRequestException(`Unknown setting "${key}"`);

    // Sending the mask back unchanged is what a form does when the user did not retype a
    // password. It means "leave it alone", never "set the value to dots".
    if (def.secret && rawValue === SECRET_MASK) return;

    const value = this.coerce(def, rawValue);

    if (def.secret && value != null) {
      /**
       * Refuse rather than store a credential in the clear.
       *
       * `encryptField` passes plaintext through when `PII_ENCRYPTION_KEY` is unset — the right
       * behaviour for the PII columns it was built for, where losing the data would be worse.
       * A mail password is the opposite case: storing it readable in a database that gets
       * backed up and copied is worse than not storing it at all, and the operator can still
       * use the environment variable meanwhile.
       */
      if (!process.env.PII_ENCRYPTION_KEY) {
        throw new BadRequestException(
          'Set PII_ENCRYPTION_KEY on the server before saving a password here — without it the credential would be stored unencrypted. Until then, configure this through the environment variable instead.',
        );
      }
    }

    const stored = def.secret && value != null ? encryptField(String(value)) : value;

    const existing = await this.repository.findOne({ where: { key } });
    if (existing) {
      existing.value = stored;
      existing.isSecret = !!def.secret;
      existing.updatedBy = userId as any;
      await this.repository.save(existing);
    } else {
      await this.repository.save(
        this.repository.create({
          key,
          value: stored,
          isSecret: !!def.secret,
          createdBy: userId as any,
          updatedBy: userId as any,
        }),
      );
    }

    await this.invalidate();
    await this.notify(key, value);
  }

  /** Removes the saved value so the key falls back to the environment or the default. */
  async reset(key: string, userId?: string): Promise<void> {
    const def = SETTING_BY_KEY[key];
    if (!def) throw new BadRequestException(`Unknown setting "${key}"`);
    await this.repository.delete({ key });
    await this.invalidate();
    await this.notify(key, await this.get(key).catch(() => null));
  }

  // ---------------------------------------------------------------- internals

  private async notify(key: string, value: any): Promise<void> {
    for (const l of this.listeners) {
      if (!key.startsWith(l.prefix)) continue;
      try {
        await l.fn(key, value);
      } catch (err: any) {
        // A listener that throws must not fail the save — the value IS stored, and a mail
        // transport that could not be rebuilt is a smaller problem than a settings screen
        // that reports failure for a change it actually made.
        this.logger.warn(`Settings listener for "${key}" failed: ${err?.message ?? err}`);
      }
    }
  }

  private async invalidate(): Promise<void> {
    await this.cache.del(CACHE_KEY).catch(() => undefined);
  }

  /** Saved values by key, decrypted, cached. */
  private async savedValues(): Promise<Record<string, any>> {
    return this.load();
  }

  private async load(): Promise<Record<string, any>> {
    const rows = await this.cache
      .wrap(CACHE_KEY, CACHE_TTL_SECONDS, async () => this.repository.find())
      .catch((err: any) => {
        this.logger.warn(`Could not read platform settings, using environment and defaults: ${err?.message}`);
        return [] as PlatformSettingEntity[];
      });

    const out: Record<string, any> = {};
    for (const row of rows) {
      if (row.value == null) continue;
      if (row.isSecret) {
        try {
          out[row.key] = decryptField(String(row.value));
        } catch (err: any) {
          // A key rotation that left old ciphertext behind. Treat it as unset — falling back
          // to the environment beats handing a mail server a string of gibberish.
          this.logger.warn(`Could not decrypt setting "${row.key}"; treating it as unset.`);
        }
      } else {
        out[row.key] = row.value;
      }
    }
    return out;
  }

  private resolve(def: SettingDef, savedValue: any): { value: any; source: ResolvedSetting['source'] } {
    if (savedValue !== undefined && savedValue !== null && savedValue !== '') {
      return { value: savedValue, source: 'saved' };
    }
    if (def.envVar) {
      const env = process.env[def.envVar];
      if (env !== undefined && env !== '') {
        return { value: this.coerce(def, env), source: 'environment' };
      }
    }
    return { value: def.default, source: 'default' };
  }

  /** Turns whatever arrived — a form string, an env string, JSON — into the declared type. */
  private coerce(def: SettingDef, raw: any): any {
    if (raw === null || raw === undefined || raw === '') return null;

    switch (def.type) {
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new BadRequestException(`${def.label} must be a number.`);
        if (def.min !== undefined && n < def.min) {
          throw new BadRequestException(`${def.label} cannot be below ${def.min}${def.unit ? ' ' + def.unit : ''}.`);
        }
        if (def.max !== undefined && n > def.max) {
          throw new BadRequestException(`${def.label} cannot be above ${def.max}${def.unit ? ' ' + def.unit : ''}.`);
        }
        return n;
      }
      case 'boolean':
        return raw === true || raw === 'true' || raw === 1 || raw === '1';
      case 'select': {
        const allowed = (def.options ?? []).map((o) => o.value);
        if (!allowed.includes(String(raw))) {
          throw new BadRequestException(`${def.label} must be one of: ${allowed.join(', ')}.`);
        }
        return String(raw);
      }
      case 'cron': {
        const parts = String(raw).trim().split(/\s+/);
        if (parts.length !== 5) {
          throw new BadRequestException(
            `${def.label} must be five cron fields — minute, hour, day of month, month, day of week. "30 8 * * 1-6" means 08:30, Monday to Saturday.`,
          );
        }
        return String(raw).trim();
      }
      default:
        return String(raw);
    }
  }
}
