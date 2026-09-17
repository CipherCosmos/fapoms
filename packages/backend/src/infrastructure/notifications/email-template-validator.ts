/**
 * FAPOMS — Email Template Validator & Security Scanner
 *
 * Enforces typed token contracts, prevents missing required variables, rejects unauthorized
 * tokens, and scans HTML for dangerous script injection, event handlers, and unsafe URI schemes.
 */

import { EmailTemplateDefinition } from './email-template-registry';

export interface ExtractedTokens {
  standard: string[];
  raw: string[];
  all: string[];
}

export interface TemplateValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  tokens: ExtractedTokens;
}

/**
 * Extracts all `{{token}}` (escaped) and `{{{token}}}` (raw HTML) placeholders.
 */
export function extractTokens(content: string): ExtractedTokens {
  if (!content) {
    return { standard: [], raw: [], all: [] };
  }

  const rawSet = new Set<string>();
  const standardSet = new Set<string>();

  // Extract triple-brace raw tokens: {{{tokenName}}}
  const rawRegex = /\{\{\{\s*([a-zA-Z0-9_]+)\s*\}\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = rawRegex.exec(content)) !== null) {
    rawSet.add(match[1]);
  }

  // Remove triple-brace tokens temporarily so double-brace matcher doesn't overlap
  const withoutRaw = content.replace(rawRegex, '');

  // Extract double-brace standard tokens: {{tokenName}}
  const standardRegex = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  while ((match = standardRegex.exec(withoutRaw)) !== null) {
    standardSet.add(match[1]);
  }

  const raw = Array.from(rawSet).sort();
  const standard = Array.from(standardSet).sort();
  const all = Array.from(new Set([...standard, ...raw])).sort();

  return { standard, raw, all };
}

/**
 * Scans HTML for cross-site scripting vulnerabilities, forbidden tags, and suspicious protocols.
 */
export function validateHtmlSecurity(html: string): string[] {
  const errors: string[] = [];
  if (!html) return errors;

  // 1. Prohibited structural tags that can execute code or steal user input
  const forbiddenTags = [
    'script',
    'iframe',
    'object',
    'embed',
    'applet',
    'form',
    'input',
    'select',
    'textarea',
    'button',
  ];

  for (const tag of forbiddenTags) {
    const regex = new RegExp(`<\\s*${tag}\\b`, 'i');
    if (regex.test(html)) {
      errors.push(`Prohibited HTML tag detected: <${tag}>. Email templates must not contain interactive or executable tags.`);
    }
  }

  // 2. Dangerous meta refresh or imports
  if (/<meta[^>]+http-equiv\s*=\s*['"]?refresh['"]?/i.test(html)) {
    errors.push('Prohibited HTML: <meta http-equiv="refresh"> is not allowed in email templates.');
  }

  // 3. Prohibited event handlers: on* (e.g. onclick, onerror, onload)
  const eventHandlerRegex = /\b(on[a-z]{3,20})\s*=/i;
  const eventMatch = eventHandlerRegex.exec(html);
  if (eventMatch) {
    errors.push(`Prohibited inline event handler detected: "${eventMatch[1]}". JavaScript event handlers are not allowed.`);
  }

  // 4. Dangerous URI schemes (javascript:, vbscript:, data:text/html)
  const dangerousUriRegex = /\b(href|src|action|background)\s*=\s*['"]?\s*(javascript:|vbscript:|data:\s*text\/html)/i;
  const uriMatch = dangerousUriRegex.exec(html);
  if (uriMatch) {
    errors.push(`Prohibited URI scheme detected in ${uriMatch[1]}: "${uriMatch[2]}". Only safe http:, https:, mailto:, and tel: protocols are permitted.`);
  }

  return errors;
}

/**
 * Validates a template against its strongly-typed definition in the registry.
 */
export function validateTemplateContract(
  definition: EmailTemplateDefinition,
  html: string,
  subjectTemplate?: string,
): TemplateValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Security scan on HTML
  const securityErrors = validateHtmlSecurity(html);
  errors.push(...securityErrors);

  // Extract tokens from both HTML and subject
  const combinedContent = `${html || ''}\n${subjectTemplate || ''}`;
  const tokens = extractTokens(combinedContent);

  // 1. Required Tokens Verification
  for (const reqToken of definition.requiredTokens) {
    if (!tokens.all.includes(reqToken)) {
      errors.push(
        `Template "${definition.key}" is missing required token: "{{${reqToken}}}". This token must be present in the HTML or subject.`,
      );
    }
  }

  // 2. Allowed Tokens Verification (no unknown arbitrary tokens)
  const allowedSet = new Set<string>([
    ...definition.requiredTokens,
    ...(definition.optionalTokens || []),
    ...(definition.rawTokens || []),
  ]);

  for (const token of tokens.all) {
    if (!allowedSet.has(token)) {
      errors.push(
        `Unknown token "{{${token}}}" in template "${definition.key}". Allowed tokens are: ${Array.from(allowedSet).join(', ')}.`,
      );
    }
  }

  // 3. Raw Tokens Security Verification
  for (const rawToken of tokens.raw) {
    if (!definition.allowRawHtmlTokens) {
      errors.push(
        `Template "${definition.key}" prohibits raw HTML tokens, but found "{{{${rawToken}}}}". Use standard escaped "{{${rawToken}}}" instead.`,
      );
    } else if (!definition.rawTokens?.includes(rawToken)) {
      errors.push(
        `Token "${rawToken}" is not declared as an authorized raw HTML token for "${definition.key}". Authorized raw tokens: ${definition.rawTokens?.join(', ') || 'none'}.`,
      );
    }
  }

  // 4. Basic sanity checks on structure
  if (!html || html.trim().length < 50) {
    errors.push('HTML content is too short or empty.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    tokens,
  };
}
