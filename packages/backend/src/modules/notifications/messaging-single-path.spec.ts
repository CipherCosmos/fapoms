import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import * as ts from 'typescript';
import { backendSrc } from '../../test-support/paths';

/**
 * ONE WAY TO SEND AN EMAIL, AND ONE WAY TO SEND A TEXT.
 *
 * Email had grown seven ways of reaching the mail server and a second queue-and-retry pipeline, and
 * most templated emails had their wording written twice — a hand-built `renderEmailHtml` fallback at
 * the call site beside the template registry's own. `EmailService` (see its class comment) is now
 * the only door: a feature says what to send and how urgently, and the email module does the rest.
 *
 * This keeps it the only door. Outside the email module — `src/infrastructure/notifications/**` and
 * `src/modules/notifications/**` — no production file may:
 *
 *   - inject or import `EmailProvider` (the transport). A `*.module.ts` may still name it for
 *     dependency injection; a module file cannot call it.
 *   - call `.sendMail(` or `emailProvider.send(`
 *   - import `renderEmailHtml` (the layout — give `EmailService` a `{ layout }` instead)
 *   - inject, import or call `EmailTemplateRenderer` (give `EmailService` a `{ template, data }`)
 *   - import `nodemailer`
 *
 * Text messages have the same single door, `SmsService` (`queue` by default, `sendNow` for a code the
 * person is waiting for), on the same outbound ledger. SMS had its own second paths before it had a
 * door at all — MFA and the bulk credential run each called the gateway with hand-written wording,
 * which under DLT is a text the operator refuses. So, outside the same two directories, no
 * production file may:
 *
 *   - inject or import `SmsProvider` (the transport) — not even from a module file: it is no longer
 *     exported, so a module listing it would be building a second transport
 *   - inject or import `SmsTemplateService` (give `SmsService` a `{ template, data }`)
 *   - import anything under `infrastructure/notifications/sms/` (the vendor adapters)
 *   - name an SMS gateway's host in a string (`api.pinnacle.com` and the like) — that is calling the
 *     gateway by hand. A settings label that says "Pinnacle" is not a host and is not caught.
 *
 * There is no allowlist, on purpose. A file that needs an exception has found a second way to send
 * email or a text, which is the thing this exists to stop; give `EmailService` or `SmsService` the
 * missing ability instead.
 *
 * Files are read as syntax trees, not as text: a comment explaining why a file does NOT call the
 * transport, or a log line naming it, is not a use of it — and a regex that tried to strip comments
 * and strings by hand would be fooled by the first regular-expression literal containing a quote.
 */

const SRC = backendSrc();

const MESSAGING_MODULE = [
  join('infrastructure', 'notifications') + sep,
  join('modules', 'notifications') + sep,
];

const OFFENCE = {
  provider: 'injects or imports EmailProvider',
  sendMail: 'calls .sendMail(',
  providerSend: 'calls emailProvider.send(',
  layout: 'imports renderEmailHtml',
  renderer: 'injects or calls EmailTemplateRenderer',
  nodemailer: 'imports nodemailer',
  smsProvider: 'injects or imports SmsProvider',
  smsTemplates: 'injects or imports SmsTemplateService',
  smsAdapter: 'imports from infrastructure/notifications/sms/',
  smsGateway: 'names an SMS gateway host',
} as const;

const isNodemailer = (node: ts.Node | undefined): boolean =>
  !!node && ts.isStringLiteralLike(node) && /^nodemailer(\/|$)/.test(node.text);

/** A module path into the SMS vendor adapters, however it is spelled relative to the importer. */
const isSmsAdapterPath = (node: ts.Node | undefined): boolean =>
  !!node && ts.isStringLiteralLike(node) && /(^|\/)notifications\/sms\//.test(node.text);

/**
 * An SMS gateway's host, as a URL or a bare hostname. Hosts, not names: the settings screen rightly
 * says "Pinnacle" in its labels, and that is not a way to send anything.
 */
const SMS_GATEWAY_HOST = /(^|[^\w-])([\w-]+\.)*(pinnacle|textlocal|fast2sms|twilio|gupshup|kaleyra|exotel|2factor)\.(com|in|net|io)\b/i;

/** The name a call's receiver ends in: `this.emailProvider` → `emailProvider`. */
const receiverName = (expr: ts.Expression): string | null => {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
};

function offencesIn(relativePath: string, source: string): string[] {
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const isModuleFile = relativePath.endsWith('.module.ts');
  const found = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (node.text === 'EmailProvider' && !isModuleFile) found.add(OFFENCE.provider);
      if (node.text === 'renderEmailHtml') found.add(OFFENCE.layout);
      if (node.text === 'EmailTemplateRenderer') found.add(OFFENCE.renderer);
      if (node.text === 'SmsProvider') found.add(OFFENCE.smsProvider);
      if (node.text === 'SmsTemplateService') found.add(OFFENCE.smsTemplates);
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (SMS_GATEWAY_HOST.test(node.text)) found.add(OFFENCE.smsGateway);
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && isSmsAdapterPath(node.moduleSpecifier)) {
      found.add(OFFENCE.smsAdapter);
    }
    if (ts.isImportDeclaration(node) && isNodemailer(node.moduleSpecifier)) found.add(OFFENCE.nodemailer);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (isNodemailer(node.moduleReference.expression)) found.add(OFFENCE.nodemailer);
      if (isSmsAdapterPath(node.moduleReference.expression)) found.add(OFFENCE.smsAdapter);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads = node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(callee) && callee.text === 'require');
      if (loads && isNodemailer(node.arguments[0])) found.add(OFFENCE.nodemailer);
      if (loads && isSmsAdapterPath(node.arguments[0])) found.add(OFFENCE.smsAdapter);
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const receiver = receiverName(callee.expression) ?? '';
        if (method === 'sendMail') found.add(OFFENCE.sendMail);
        if (method === 'send' && /^emailProvider$/i.test(receiver)) found.add(OFFENCE.providerSend);
        if (method === 'render' && /templateRenderer$/i.test(receiver)) found.add(OFFENCE.renderer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return Object.values(OFFENCE).filter((offence) => found.has(offence));
}

function productionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') files.push(...productionFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('email and SMS each have one implementation', () => {
  it('nothing outside the messaging module reaches a transport, the layout, a template renderer, nodemailer or an SMS gateway', () => {
    const offenders: string[] = [];
    for (const file of productionFiles(SRC)) {
      const rel = relative(SRC, file);
      if (MESSAGING_MODULE.some((prefix) => rel.startsWith(prefix))) continue;
      for (const offence of offencesIn(rel, readFileSync(file, 'utf8'))) {
        offenders.push(`src/${rel.split(sep).join('/')}: ${offence}`);
      }
    }

    if (offenders.length) {
      throw new Error(
        'Email must go through EmailService (src/modules/notifications/email.service.ts) and texts through '
        + 'SmsService (src/modules/notifications/sms.service.ts): '
        + '`queue` by default, `sendNow` only when the caller needs the answer.\n'
        + offenders.map((o) => `  - ${o}`).join('\n'),
      );
    }
  });

  /**
   * A scanner that finds nothing because it is broken passes exactly like a codebase that is clean.
   * These prove it still sees each kind of offence, on the shapes this codebase actually has.
   */
  describe('the scanner itself', () => {
    it.each([
      [`import { EmailProvider } from '../notifications/email-provider';`, OFFENCE.provider],
      [`class A { constructor(private readonly mail: EmailProvider) {} }`, OFFENCE.provider],
      [`const p = this.moduleRef.get(EmailProvider, { strict: false });`, OFFENCE.provider],
      [`async function f(t: any) { await t.transporter.sendMail({ to: 'x' }); }`, OFFENCE.sendMail],
      [`async function f(this: any) { await this.emailProvider.send({ to: 'x' }); }`, OFFENCE.providerSend],
      [`import { appPublicUrl, renderEmailHtml } from '../n/email-provider';`, OFFENCE.layout],
      [`class A { constructor(@Optional() private readonly t?: EmailTemplateRenderer) {} }`, OFFENCE.renderer],
      [`async function f(this: any) { return this.templateRenderer.render('morning-digest', {}); }`, OFFENCE.renderer],
      [`import * as nodemailer from 'nodemailer';`, OFFENCE.nodemailer],
      [`import type { Transporter } from 'nodemailer/lib/mailer';`, OFFENCE.nodemailer],
      [`const nm = require('nodemailer');`, OFFENCE.nodemailer],
      [`import { SmsProvider } from '../../infrastructure/notifications/sms-provider';`, OFFENCE.smsProvider],
      [`class A { constructor(private readonly sms: SmsProvider) {} }`, OFFENCE.smsProvider],
      [`const p = this.moduleRef.get(SmsProvider, { strict: false });`, OFFENCE.smsProvider],
      [`class A { constructor(@Optional() private readonly t?: SmsTemplateService) {} }`, OFFENCE.smsTemplates],
      [`import { Msg91Transport } from '../../infrastructure/notifications/sms/pinnacle.transport';`, OFFENCE.smsAdapter],
      [`import type { SmsMessage } from '../notifications/sms/sms-transport';`, OFFENCE.smsAdapter],
      [`export { Pinnacle_SEND_URL } from '../../infrastructure/notifications/sms/pinnacle.transport';`, OFFENCE.smsAdapter],
      [`const t = require('../../infrastructure/notifications/sms/pinnacle.transport');`, OFFENCE.smsAdapter],
      [`async function f() { await fetch('https://api.pinnacle.com/api/v2/sendsms', { method: 'POST' }); }`, OFFENCE.smsGateway],
      ['async function f(k: string) { await fetch(`https://control.pinnacle.com/api/v5/flow?authkey=${k}`); }', OFFENCE.smsGateway],
      [`const host = 'api.twilio.com';`, OFFENCE.smsGateway],
    ])('sees %s', (source, offence) => {
      expect(offencesIn('a/x.service.ts', source)).toEqual([offence]);
    });

    it('reads a many-imports-on-one-line file like any other', () => {
      const oneLine = `import { A } from './a'; import { EmailProvider, appPublicUrl } from '../../infrastructure/notifications/email-provider'; import { B } from './b';`;
      expect(offencesIn('m/x.service.ts', oneLine)).toEqual([OFFENCE.provider]);
    });

    it('ignores comments, strings and regular expressions that merely mention them', () => {
      const harmless = [
        '// NotificationsModule exports `EmailProvider`, which used to be called directly.',
        '/* renderEmailHtml was the old layout; this.templateRenderer.render the old renderer */',
        "const log = 'EmailProvider.send is not called from here; nodemailer neither';",
        "const quote = /'/g; const url = 'https://example.com//not-a-comment'; const svc = EmailService;",
        'const t = `sendMail(${quote.source})`;',
        'async function f(this: any) { await this.email.queue({}); await this.sms.send("x"); }',
        '// SmsProvider used to be injected here; SmsTemplateService too. See infrastructure/notifications/sms/.',
        "const label = 'Pinnacle Auth Key'; const note = 'Choose Pinnacle once you have an account there.';",
        "import { SmsService } from '../notifications/sms.service'; const d = { value: 'Pinnacle', label: 'Pinnacle' };",
        "async function g(this: any) { await this.smsService.queue({ template: 'app-credentials' }); }",
      ].join('\n');
      expect(offencesIn('a/x.service.ts', harmless)).toEqual([]);
    });

    it('lets a module file list the email transport for DI, and nothing else', () => {
      expect(offencesIn('a/a.module.ts', `const providers = [EmailProvider];`)).toEqual([]);
      expect(offencesIn('a/a.module.ts', `import { renderEmailHtml } from './x';`)).toEqual([OFFENCE.layout]);
    });

    /**
     * Not even for DI. `NotificationsModule` no longer exports `SmsProvider`, so a feature module
     * listing it would be constructing a second SMS transport of its own — a second door.
     */
    it('does not let a module file outside the messaging module list the SMS transport', () => {
      expect(offencesIn('a/a.module.ts', `const providers = [SmsProvider];`)).toEqual([OFFENCE.smsProvider]);
    });

    it('reads the real tree — the messaging module\'s own use of each transport is found', () => {
      const own = readFileSync(join(__dirname, 'email.service.ts'), 'utf8');
      expect(offencesIn('modules/notifications/email.service.ts', own)).toEqual(
        expect.arrayContaining([OFFENCE.provider, OFFENCE.layout, OFFENCE.renderer]),
      );
      const texts = readFileSync(join(__dirname, 'sms.service.ts'), 'utf8');
      expect(offencesIn('modules/notifications/sms.service.ts', texts)).toEqual(
        expect.arrayContaining([OFFENCE.smsProvider, OFFENCE.smsTemplates]),
      );
      const adapter = readFileSync(join(SRC, 'infrastructure', 'notifications', 'sms', 'pinnacle.transport.ts'), 'utf8');
      expect(offencesIn('infrastructure/notifications/sms/pinnacle.transport.ts', adapter)).toContain(OFFENCE.smsGateway);
      const files = productionFiles(SRC).map((f) => relative(SRC, f));
      expect(files.length).toBeGreaterThan(300);
      expect(files).toContain(join('modules', 'notifications', 'email.service.ts'));
      expect(files.some((f) => f.endsWith('.spec.ts'))).toBe(false);
    });
  });
});

/**
 * TEXTS ARE FOR THE FEW THINGS A PERSON IS WAITING ON — NOT FOR EVERYTHING EMAIL CARRIES.
 *
 * Email is free and an inbox is patient; a text costs money per message, arrives on a lock screen,
 * and under DLT every wording needs its own registered template. So SMS is deliberately a short list:
 * the codes somebody is standing there waiting for, the sign-in details a field assayer cannot read
 * an inbox for, an administrator's delivery test, and notification events an administrator has
 * explicitly ticked (off for every event by default — see the catalog spec).
 *
 * This fails when a new kind of text appears, so adding one is a decision somebody makes on purpose
 * rather than a line that slipped in beside an email.
 */
describe('what may go out as a text at all', () => {
  const ALLOWED_SMS_KINDS = [
    // A one-time code the person is waiting for; email is the fallback when SMS is off.
    'MFA_CODE',
    'REGISTRATION_OTP',
    // The field app's sign-in details: a vault floor has no inbox.
    'APP_ACCESS_CREDENTIALS',
    // Only events an administrator has ticked for SMS; every event ships with SMS off.
    'NOTIFICATION',
    // The administrator's own "does SMS work" button.
    'TRANSPORT_TEST',
  ].sort();

  it('sends texts for these kinds and no others', () => {
    const kinds = new Set<string>();
    for (const file of productionFiles(SRC)) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      // Every SMS send goes through SmsService.queue / .sendNow — the guard above keeps it that way.
      // Wide enough for the longest call in the tree (bulk app access, ~500 characters).
      for (const m of code.matchAll(/\.(?:queue|sendNow)\(\{([\s\S]{0,1200}?)\}\)/g)) {
        const block = m[1];
        if (!/template:\s*'(?:mfa-code|registration-otp|app-credentials|notification|transport-test)'/.test(block)) continue;
        const kind = /kind:\s*'([A-Z_]+)'/.exec(block)?.[1];
        if (kind) kinds.add(kind);
      }
    }
    expect([...kinds].sort()).toEqual(ALLOWED_SMS_KINDS);
  });
});