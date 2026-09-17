/**
 * FAPOMS — Email Template Renderer
 *
 * Performs safe, high-integrity token interpolation (escaped {{token}} vs raw {{{token}}}),
 * renders plain-text alternatives and subjects, enforces runtime token completeness,
 * logs non-sensitive telemetry, and cascades to deterministic fallback renderers on any error.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  EMAIL_TEMPLATE_REGISTRY,
  EmailTemplateDefinition,
  EmailTemplateKey,
} from './email-template-registry';
import { EmailTemplateLoader, LoadedTemplate } from './email-template-loader';
import { plainTextFor } from './html-to-text';

export interface RenderedEmailOutput {
  html: string;
  text: string;
  subject: string;
  metadata: {
    templateKey: EmailTemplateKey;
    source: string;
    version: number;
    checksum: string;
    isFallback: boolean;
  };
}

export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

@Injectable()
export class EmailTemplateRenderer {
  private readonly logger = new Logger(EmailTemplateRenderer.name);

  constructor(private readonly loader: EmailTemplateLoader) {}

  /**
   * Safe token interpolation with explicit separation between escaped and raw HTML tokens.
   */
  interpolate(
    templateStr: string,
    payload: Record<string, any>,
    definition: EmailTemplateDefinition,
  ): string {
    if (!templateStr) return '';

    // Verify all required tokens exist in the payload
    for (const reqToken of definition.requiredTokens) {
      const val = payload[reqToken];
      if (val === undefined || val === null || val === '') {
        throw new Error(
          `Payload missing required value for token "{{${reqToken}}}" in template "${definition.key}".`,
        );
      }
    }

    // 1. Replace raw tokens {{{token}}} — strictly limited to declared rawTokens
    let result = templateStr.replace(/\{\{\{\s*([a-zA-Z0-9_]+)\s*\}\}\}/g, (_match, tokenName) => {
      if (!definition.allowRawHtmlTokens || !definition.rawTokens?.includes(tokenName)) {
        throw new Error(
          `Security violation: Token "${tokenName}" is not permitted as a raw HTML token in "${definition.key}".`,
        );
      }
      const val = payload[tokenName];
      return val !== undefined && val !== null ? String(val) : '';
    });

    // 2. Replace standard tokens {{token}} — strictly HTML escaped
    result = result.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, tokenName) => {
      const val = payload[tokenName];
      if (val === undefined || val === null) {
        return '';
      }
      return escapeHtml(String(val));
    });

    return result;
  }

  /**
   * Renders an email template with the given payload, guaranteed to return valid HTML, text, and subject.
   */
  async render(key: EmailTemplateKey, payload: Record<string, any>): Promise<RenderedEmailOutput> {
    const definition = EMAIL_TEMPLATE_REGISTRY[key];
    if (!definition) {
      throw new Error(`Unknown email template key: "${key}"`);
    }

    let loaded: LoadedTemplate;
    try {
      loaded = await this.loader.loadActiveTemplate(key);
    } catch (e) {
      this.logger.error(`Failed loading active template for "${key}": ${(e as Error).message}. Using fallback.`);
      const fb = definition.fallbackRenderer(payload);
      return {
        ...fb,
        metadata: {
          templateKey: key,
          source: 'fallback',
          version: 0,
          checksum: 'builtin',
          isFallback: true,
        },
      };
    }

    // If template has HTML (from platform override or filesystem)
    if (loaded.html) {
      try {
        const renderedHtml = this.interpolate(loaded.html, payload, definition);
        const renderedSubject = this.interpolate(loaded.subjectTemplate, payload, definition);

        /*
          The text half is derived from the HTML that is actually going out, not regenerated from
          the built-in design. It used to be the latter unconditionally, so an administrator could
          rewrite an email, publish it, and every recipient reading in plain text still got the old
          wording — two different emails under one subject line, with no screen showing the second.
          `plainTextFor` keeps the hand-written sentence when nothing has been customised, and when
          a conversion comes back implausibly short.
        */
        const fallback = definition.fallbackRenderer(payload);
        const renderedText = plainTextFor(renderedHtml, fallback.text);

        this.logger.log(
          `[EmailTemplateRenderer] Rendered "${key}" ` +
          `(source: ${loaded.source}, v${loaded.version}, checksum: ${loaded.checksum})`,
        );

        return {
          html: renderedHtml,
          text: renderedText,
          subject: renderedSubject || fallback.subject,
          metadata: {
            templateKey: key,
            source: loaded.source,
            version: loaded.version,
            checksum: loaded.checksum,
            isFallback: loaded.isFallback,
          },
        };
      } catch (err) {
        this.logger.error(
          `[EmailTemplateRenderer] Rendering error on "${key}" (${loaded.source} v${loaded.version}): ` +
          `${(err as Error).message}. Cascading to built-in fallback renderer.`,
        );
      }
    }

    // Built-in Programmatic Fallback
    const fallback = definition.fallbackRenderer(payload);
    return {
      ...fallback,
      metadata: {
        templateKey: key,
        source: 'fallback',
        version: 0,
        checksum: 'builtin',
        isFallback: true,
      },
    };
  }
}
