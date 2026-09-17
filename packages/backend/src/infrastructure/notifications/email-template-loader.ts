/**
 * FAPOMS — Email Template Loader & Version Manager
 *
 * Resolves active templates across precedence tiers:
 *   1. Active Platform Override (PlatformSettings)
 *   2. Last-Known-Good Platform Version (if active version is broken)
 *   3. Filesystem Disk Template (packages/backend/templates/emails/*.html)
 *   4. Built-in Fallback Renderer
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import {
  EMAIL_TEMPLATE_REGISTRY,
  EmailTemplateDefinition,
  EmailTemplateKey,
} from './email-template-registry';
import { validateTemplateContract } from './email-template-validator';

export type TemplateSource = 'platform' | 'filesystem' | 'fallback';

export interface EmailTemplateVersion {
  version: number;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  subjectTemplate: string;
  html: string;
  checksum: string;
  createdBy?: string;
  createdAt: string;
  publishedAt?: string;
}

export interface StoredTemplateSettings {
  sourcePreference?: TemplateSource;
  activeVersion?: number;
  lastKnownGoodVersion?: number;
  draft?: {
    subjectTemplate: string;
    html: string;
    updatedAt: string;
    updatedBy?: string;
  } | null;
  versions: EmailTemplateVersion[];
  /**
   * The last test email sent for this template, and — crucially — the checksum of the HTML that
   * was sent. Publishing compares it against the draft, so "I have seen this arrive" is a fact the
   * system can check rather than a box somebody ticked.
   */
  lastTestSend?: {
    checksum: string;
    to: string;
    at: string;
    by?: string;
  } | null;
}

export interface LoadedTemplate {
  key: EmailTemplateKey;
  definition: EmailTemplateDefinition;
  source: TemplateSource;
  version: number;
  subjectTemplate: string;
  html: string | null;
  checksum: string;
  isFallback: boolean;
}

@Injectable()
export class EmailTemplateLoader {
  private readonly logger = new Logger(EmailTemplateLoader.name);
  private diskCache = new Map<string, { html: string; checksum: string; mtime: number }>();

  constructor(
    @Optional() private readonly platformSettings?: PlatformSettingsService,
  ) {}

  /**
   * Resolves the primary directory containing .html template files on disk.
   */
  getTemplatesDir(): string {
    const candidates = [
      path.resolve(process.cwd(), 'templates/emails'),
      path.resolve(process.cwd(), 'packages/backend/templates/emails'),
      path.resolve(__dirname, '../../../templates/emails'),
      path.resolve(__dirname, '../../../../templates/emails'),
    ];

    for (const dir of candidates) {
      if (fs.existsSync(dir)) {
        return dir;
      }
    }
    return candidates[0];
  }

  /**
   * Generates a deterministic SHA-256 checksum for template content.
   */
  checksum(content: string): string {
    return crypto.createHash('sha256').update(content || '').digest('hex').slice(0, 16);
  }

  /**
   * Reads raw filesystem template for a given key, stripping the top manifest comment.
   */
  readFilesystemTemplate(key: EmailTemplateKey): { html: string; checksum: string } | null {
    const dir = this.getTemplatesDir();
    const filePath = path.join(dir, `${key}.html`);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const stats = fs.statSync(filePath);
      const cached = this.diskCache.get(key);
      if (cached && cached.mtime === stats.mtimeMs) {
        return { html: cached.html, checksum: cached.checksum };
      }

      let rawContent = fs.readFileSync(filePath, 'utf8');
      // Strip leading manifest comment <!-- EMAIL_TEMPLATE: ... --> if present
      const manifestEnd = rawContent.indexOf('-->');
      if (rawContent.trim().startsWith('<!--') && manifestEnd !== -1) {
        rawContent = rawContent.slice(manifestEnd + 3).trim();
      }

      const cs = this.checksum(rawContent);
      this.diskCache.set(key, { html: rawContent, checksum: cs, mtime: stats.mtimeMs });
      return { html: rawContent, checksum: cs };
    } catch (e) {
      this.logger.warn(`Failed reading filesystem template for ${key} at ${filePath}: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Loads the active template for a key according to the precedence rules.
   */
  async loadActiveTemplate(key: EmailTemplateKey): Promise<LoadedTemplate> {
    const definition = EMAIL_TEMPLATE_REGISTRY[key];
    if (!definition) {
      throw new Error(`Unknown email template key: "${key}"`);
    }

    const settings = await this.getStoredSettings(key);
    const sourcePreference = settings?.sourcePreference || 'platform';
    let platformOverrideFailed = false;

    // 1. Check Platform Override tier (if preferred and not forced to filesystem/fallback)
    if (sourcePreference === 'platform' && settings?.activeVersion && settings.versions.length > 0) {
      const activeVer = settings.versions.find(
        (v) => v.version === settings.activeVersion && v.status === 'ACTIVE',
      );

      if (activeVer) {
        // Validate active platform version
        const validation = validateTemplateContract(definition, activeVer.html, activeVer.subjectTemplate);
        if (validation.valid) {
          return {
            key,
            definition,
            source: 'platform',
            version: activeVer.version,
            subjectTemplate: activeVer.subjectTemplate || definition.defaultSubjectTemplate,
            html: activeVer.html,
            checksum: activeVer.checksum,
            isFallback: false,
          };
        }

        platformOverrideFailed = true;
        this.logger.error(
          `Active platform override for template "${key}" (v${activeVer.version}) failed validation: ` +
          `${validation.errors.join('; ')}. Initiating fallback cascade.`,
        );

        // Try Last-Known-Good version if different
        if (settings.lastKnownGoodVersion && settings.lastKnownGoodVersion !== activeVer.version) {
          const lkg = settings.versions.find((v) => v.version === settings.lastKnownGoodVersion);
          if (lkg) {
            const lkgVal = validateTemplateContract(definition, lkg.html, lkg.subjectTemplate);
            if (lkgVal.valid) {
              this.logger.warn(`Recovered using last-known-good platform version v${lkg.version} for "${key}".`);
              return {
                key,
                definition,
                source: 'platform',
                version: lkg.version,
                subjectTemplate: lkg.subjectTemplate || definition.defaultSubjectTemplate,
                html: lkg.html,
                checksum: lkg.checksum,
                isFallback: true,
              };
            }
          }
        }
      }
    }

    // 2. Check Filesystem Template tier
    if (sourcePreference !== 'fallback') {
      const fsTemplate = this.readFilesystemTemplate(key);
      if (fsTemplate) {
        const val = validateTemplateContract(definition, fsTemplate.html, definition.defaultSubjectTemplate);
        if (val.valid) {
          return {
            key,
            definition,
            source: 'filesystem',
            version: 1,
            subjectTemplate: definition.defaultSubjectTemplate,
            html: fsTemplate.html,
            checksum: fsTemplate.checksum,
            isFallback: platformOverrideFailed,
          };
        } else {
          this.logger.warn(
            `Filesystem template for "${key}" failed contract validation: ${val.errors.join('; ')}. Falling back to builtin.`,
          );
        }
      }
    }

    // 3. Built-in Programmatic Fallback tier
    return {
      key,
      definition,
      source: 'fallback',
      version: 0,
      subjectTemplate: definition.defaultSubjectTemplate,
      html: null,
      checksum: 'builtin',
      isFallback: true,
    };
  }

  // ---------------------------------------------------------------- Settings Storage

  async getStoredSettings(key: EmailTemplateKey): Promise<StoredTemplateSettings | null> {
    if (!this.platformSettings) return null;
    try {
      let val: any = await this.platformSettings.get<any>(`email.template.${key}`);
      if (typeof val === 'string') {
        try {
          val = JSON.parse(val);
        } catch {
          val = null;
        }
      }
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        if (!Array.isArray(val.versions)) {
          val.versions = [];
        }
        return val as StoredTemplateSettings;
      }
      return null;
    } catch {
      return null;
    }
  }

  async saveStoredSettings(key: EmailTemplateKey, settings: StoredTemplateSettings): Promise<void> {
    if (!this.platformSettings) return;
    await this.platformSettings.set(`email.template.${key}`, settings);
  }

  async setSourcePreference(key: EmailTemplateKey, source: TemplateSource): Promise<void> {
    const s = (await this.getStoredSettings(key)) || { versions: [] };
    s.sourcePreference = source;
    await this.saveStoredSettings(key, s);
    this.logger.log(`Template "${key}" source preference set to "${source}".`);
  }

  async saveDraft(
    key: EmailTemplateKey,
    draft: { html: string; subjectTemplate?: string },
    author?: string,
  ): Promise<void> {
    const definition = EMAIL_TEMPLATE_REGISTRY[key];
    if (!definition) throw new Error(`Unknown template: ${key}`);

    const s = (await this.getStoredSettings(key)) || { versions: [] };
    s.draft = {
      html: draft.html,
      subjectTemplate: draft.subjectTemplate || definition.defaultSubjectTemplate,
      updatedAt: new Date().toISOString(),
      updatedBy: author || 'system',
    };
    await this.saveStoredSettings(key, s);
  }

  /**
   * Remember that this exact draft was sent to a real inbox.
   *
   * The checksum is of the HTML that went out, which is what makes the record worth keeping: a
   * test of a previous draft says nothing about the one about to be published.
   */
  async recordTestSend(
    key: EmailTemplateKey, html: string, to: string, author?: string,
  ): Promise<void> {
    const s = (await this.getStoredSettings(key)) || { versions: [] };
    s.lastTestSend = {
      checksum: this.checksum(html),
      to,
      at: new Date().toISOString(),
      by: author,
    };
    await this.saveStoredSettings(key, s);
  }

  /**
   * Whether a test of exactly this HTML has been received, for the publish gate.
   *
   * A draft nobody has sent to themselves is the commonest way a broken email reaches people: the
   * preview renders in a browser, and a real inbox is a different rendering engine on a different
   * screen with images off.
   */
  async hasTestedDraft(key: EmailTemplateKey, html: string): Promise<boolean> {
    const s = await this.getStoredSettings(key);
    return !!s?.lastTestSend && s.lastTestSend.checksum === this.checksum(html);
  }

  async publishDraft(key: EmailTemplateKey, author?: string): Promise<EmailTemplateVersion> {
    const definition = EMAIL_TEMPLATE_REGISTRY[key];
    if (!definition) throw new Error(`Unknown template: ${key}`);

    const s = (await this.getStoredSettings(key)) || { versions: [] };
    if (!s.draft?.html) {
      throw new Error(`Cannot publish: No draft found for template "${key}".`);
    }

    const validation = validateTemplateContract(definition, s.draft.html, s.draft.subjectTemplate);
    if (!validation.valid) {
      throw new Error(`Cannot publish invalid template: ${validation.errors.join('; ')}`);
    }

    const newVersionNum = s.versions.length > 0 ? Math.max(...s.versions.map((v) => v.version)) + 1 : 1;
    const checksum = this.checksum(s.draft.html);

    // Archive current active
    for (const v of s.versions) {
      if (v.status === 'ACTIVE') {
        v.status = 'ARCHIVED';
      }
    }

    const newVersion: EmailTemplateVersion = {
      version: newVersionNum,
      status: 'ACTIVE',
      subjectTemplate: s.draft.subjectTemplate,
      html: s.draft.html,
      checksum,
      createdBy: author || s.draft.updatedBy || 'admin',
      createdAt: s.draft.updatedAt || new Date().toISOString(),
      publishedAt: new Date().toISOString(),
    };

    // Update last-known-good
    s.lastKnownGoodVersion = newVersionNum;
    s.activeVersion = newVersionNum;
    s.sourcePreference = 'platform';
    s.versions.unshift(newVersion);
    // Keep at most 15 versions
    if (s.versions.length > 15) {
      s.versions = s.versions.slice(0, 15);
    }
    s.draft = null;

    await this.saveStoredSettings(key, s);
    this.logger.log(`Published new active version v${newVersionNum} for email template "${key}".`);
    return newVersion;
  }

  async rollbackVersion(key: EmailTemplateKey, targetVersion: number, author?: string): Promise<EmailTemplateVersion> {
    const s = await this.getStoredSettings(key);
    if (!s || !s.versions.length) {
      throw new Error(`No versions found for template "${key}".`);
    }

    const target = s.versions.find((v) => v.version === targetVersion);
    if (!target) {
      throw new Error(`Version v${targetVersion} does not exist for template "${key}".`);
    }

    const definition = EMAIL_TEMPLATE_REGISTRY[key];
    const validation = validateTemplateContract(definition, target.html, target.subjectTemplate);
    if (!validation.valid) {
      throw new Error(`Cannot rollback to v${targetVersion}: validation failed (${validation.errors.join('; ')})`);
    }

    for (const v of s.versions) {
      if (v.version === targetVersion) {
        v.status = 'ACTIVE';
        v.publishedAt = new Date().toISOString();
      } else if (v.status === 'ACTIVE') {
        v.status = 'ARCHIVED';
      }
    }

    s.activeVersion = targetVersion;
    s.lastKnownGoodVersion = targetVersion;
    s.sourcePreference = 'platform';
    await this.saveStoredSettings(key, s);
    this.logger.log(`Rolled back email template "${key}" to version v${targetVersion} by ${author || 'admin'}.`);
    return target;
  }
}
