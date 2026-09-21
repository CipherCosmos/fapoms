import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, ROLES_KEY, PERMISSIONS_KEY, ROLE_ONLY_KEY, ALLOW_PERMISSION_FALLBACK_KEY } from '../auth/guards';

/**
 * `update()`, `reset()`, `testEmail()` and `runDigest()` must stay reachable by the role each
 * one names ONLY — never by a custom role (a database row built in Admin -> Roles) that merely
 * holds the matching permission. See the class-level comment on `NotificationAdminController`
 * for the full story: the platform owner's own instruction was "visible to the super
 * administrator and nobody else," and every write here pairs `@Roles` with `@RequirePermissions`
 * — the shape that makes a route reachable by ANY role holding that one permission via
 * `RolesGuard`'s custom-role fallback, "nobody else" notwithstanding.
 *
 * Since 2026-09-05 the four writes are two audiences (see the controller's amended class
 * comment): `update`/`reset` are business messaging policy and keep `@Roles(ADMIN)` +
 * `configuration:edit:platform`; `testEmail`/`runDigest` are the developer's transport
 * plumbing — `@Roles(DEVELOPER)` (one-way: an administrator does not pass) +
 * `system:edit:platform`. Both shapes keep `@RoleOnly()`, which is what this suite pins.
 *
 * Confirmed LIVE, 2026-09-04, before this suite existed: a role holding nothing but
 * `configuration:edit:platform` (role QATRACK_L_CONFIG_EDITOR, user qatrack-l-configeditor —
 * the same account that opened the rule-bypass window in the sibling finding, see
 * `../platform/rule-bypass/rule-bypass.controller.spec.ts`) called, and succeeded on:
 *   - PUT /notification-admin/catalog/EXPENSE_CLAIMED  (200 — rewrote a live routing rule)
 *   - DELETE /notification-admin/catalog/EXPENSE_CLAIMED  (200)
 *   - POST /notification-admin/email/test  (201 — sent a real email through the real transport)
 *   - POST /notification-admin/digest/run  (201 — and this one was not a drill: it queued and
 *     ran the real morning digest job, which sent a real, unscheduled, duplicate digest email to
 *     6 real candidate recipients, confirmed in `docker logs fapoms-backend`:
 *     "Morning digest: 6 sent, 0 failed, 6 candidate recipient(s)" immediately after the probe,
 *     on top of the legitimate scheduled run's "5 sent" earlier the same morning)
 * See `RELAY/findings/L.md` for the full repro. `GET /notification-admin/catalog` was and
 * remains correctly refused (403) — it declares no `@RequirePermissions` at all, so it was
 * never reachable by the fallback; this suite pins that it stays that way too.
 *
 * Two layers, both needed — see the sibling rule-bypass suite for why one alone is not enough:
 *  1. Behavioural: `RolesGuard` actually refuses this caller shape once `ROLE_ONLY_KEY` is set,
 *     using the same map-mocked `Reflector` convention as `../auth/custom-role-access.spec.ts`.
 *  2. Source: `@RoleOnly()` genuinely decorates the four real handlers in the real file, so a
 *     future edit that drops the decorator fails this suite, not just a re-derived mock.
 */
describe('NotificationAdminController — mutating routes resist the custom-role permission fallback', () => {
  const ctx = (user: any): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  }) as any;

  const reflectorReturning = (map: Record<string, any>) =>
    ({ getAllAndOverride: (key: string) => map[key] }) as unknown as Reflector;

  /** Shaped exactly like the real QATRACK_L_CONFIG_EDITOR role used in the live repro. */
  const configEditorOnly = {
    id: 'u-config-editor',
    roles: [{
      name: 'QATRACK_L_CONFIG_EDITOR',
      permissions: [{ resource: 'CONFIGURATION', action: 'EDIT', scope: 'PLATFORM' }],
    }],
  };

  const admin = { id: 'u-admin', roles: [{ name: 'ADMIN', permissions: [] }] };
  const developer = { id: 'u-dev', roles: [{ name: 'DEVELOPER', permissions: [] }] };

  /** The metadata the two catalog writes (`update`/`reset`) carry as of this fix. */
  const ROUTE_AS_FIXED = {
    [ROLES_KEY]: ['ADMIN'],
    [PERMISSIONS_KEY]: ['configuration:edit:platform'],
    [ROLE_ONLY_KEY]: true,
  };

  /** The metadata the two transport routes (`testEmail`/`runDigest`) carry since 2026-09-05. */
  const TRANSPORT_ROUTE = {
    [ROLES_KEY]: ['DEVELOPER'],
    [PERMISSIONS_KEY]: ['system:edit:platform'],
    [ROLE_ONLY_KEY]: true,
  };

  it('refuses a custom role holding only configuration:edit:platform', () => {
    const guard = new RolesGuard(reflectorReturning(ROUTE_AS_FIXED));
    expect(() => guard.canActivate(ctx(configEditorOnly))).toThrow(ForbiddenException);
  });

  it('still admits ADMIN by name, unaffected by the fix', () => {
    const guard = new RolesGuard(reflectorReturning(ROUTE_AS_FIXED));
    expect(guard.canActivate(ctx(admin))).toBe(true);
  });

  it(
    'sanity check: the exact same custom role WOULD have gotten in if fallback were enabled — proving ' +
      'the two tests above exercise the decorator, not an unrelated reason',
    () => {
      const routeWithExplicitFallback = {
        [ROLES_KEY]: ['ADMIN'],
        [PERMISSIONS_KEY]: ['configuration:edit:platform'],
        [ALLOW_PERMISSION_FALLBACK_KEY]: true,
      };
      const guard = new RolesGuard(reflectorReturning(routeWithExplicitFallback));
      expect(guard.canActivate(ctx(configEditorOnly))).toBe(true);

      const routeWithoutFallback = {
        [ROLES_KEY]: ['ADMIN'],
        [PERMISSIONS_KEY]: ['configuration:edit:platform'],
      };
      const guardStrict = new RolesGuard(reflectorReturning(routeWithoutFallback));
      expect(() => guardStrict.canActivate(ctx(configEditorOnly))).toThrow(ForbiddenException);
    },
  );

  describe('the transport routes (email/test, digest/run) since the 2026-09-05 developer split', () => {
    it('admits DEVELOPER by name', () => {
      const guard = new RolesGuard(reflectorReturning(TRANSPORT_ROUTE));
      expect(guard.canActivate(ctx(developer))).toBe(true);
    });

    it('refuses ADMIN — implication is one-way, and @RoleOnly() closes the permission door', () => {
      // An administrator holding even the exact matching grant does not pass: DEVELOPER is not
      // implied by ADMIN, and the fallback that would have judged the grant is disabled.
      const adminWithGrant = {
        id: 'u-admin-2',
        roles: [{ name: 'ADMIN', permissions: [{ resource: 'SYSTEM', action: 'EDIT', scope: 'PLATFORM' }] }],
      };
      const guard = new RolesGuard(reflectorReturning(TRANSPORT_ROUTE));
      expect(() => guard.canActivate(ctx(adminWithGrant))).toThrow(ForbiddenException);
    });

    it('refuses a custom role holding only system:edit:platform, same as the catalog writes', () => {
      const systemEditorOnly = {
        id: 'u-system-editor',
        roles: [{ name: 'QATRACK_SYSTEM_EDITOR', permissions: [{ resource: 'SYSTEM', action: 'EDIT', scope: 'PLATFORM' }] }],
      };
      const guard = new RolesGuard(reflectorReturning(TRANSPORT_ROUTE));
      expect(() => guard.canActivate(ctx(systemEditorOnly))).toThrow(ForbiddenException);
    });
  });

  describe('the real controller file', () => {
    const source = readFileSync(join(__dirname, 'notification-admin.controller.ts'), 'utf8');

    /**
     * The decorator block immediately above a given handler's `async name(` line — line-based,
     * walking backward to the nearest two-space-indented lone `}` (the end of the previous
     * method). Same technique as the sibling rule-bypass suite and
     * `../auth/route-permission-parity.spec.ts`, for the same reason: a raw
     * `lastIndexOf('}', ...)` is fooled by a nested object literal in a prior method's own body.
     */
    const decoratorsAbove = (handlerName: string): string => {
      const lines = source.split('\n');
      const target = lines.findIndex((l) => l.includes(`async ${handlerName}(`));
      expect(target).toBeGreaterThan(-1); // the handler must exist at all

      let start = 0;
      for (let i = target - 1; i >= 0; i--) {
        if (/^ {2}\}\s*$/.test(lines[i]) || /^export class /.test(lines[i])) {
          start = i + 1;
          break;
        }
      }
      return lines.slice(start, target).join('\n');
    };

    it.each(['update', 'reset', 'testEmail', 'runDigest'])('%s() is decorated with @RoleOnly()', (handler) => {
      expect(decoratorsAbove(handler)).toMatch(/@RoleOnly\(\)/);
    });

    it.each(['update', 'reset'])(
      '%s() still declares ADMIN and @RequirePermissions(\'configuration:edit:platform\') — business messaging policy, unchanged',
      (handler) => {
        const block = decoratorsAbove(handler);
        expect(block).toMatch(/@Roles\(\.\.\.NOTIFICATION_ADMIN_ROLES\)/);
        expect(block).toMatch(/@RequirePermissions\('configuration:edit:platform'\)/);
      },
    );

    it.each(['testEmail', 'runDigest'])(
      '%s() declares DEVELOPER and @RequirePermissions(\'system:edit:platform\') — transport plumbing since 2026-09-05',
      (handler) => {
        const block = decoratorsAbove(handler);
        expect(block).toMatch(/@Roles\(SystemRole\.DEVELOPER\)/);
        expect(block).toMatch(/@RequirePermissions\('system:edit:platform'\)/);
        expect(block).not.toMatch(/configuration:edit:platform/);
      },
    );

    it('catalog(), emailStatus() and preview() need no @RoleOnly() — they declare no @RequirePermissions at all', () => {
      // These three inherit only the class-level @Roles(ADMIN) and name no permission, so
      // RolesGuard's fail-closed rule already refuses any role it does not name by name — the
      // fallback branch never activates for lack of anything to check. Confirmed live: GET
      // /notification-admin/catalog 403'd for the config-editor-only role throughout this
      // investigation, before and after the fix below.
      for (const handler of ['catalog', 'emailStatus', 'preview']) {
        const block = decoratorsAbove(handler);
        expect(block).not.toMatch(/@RequirePermissions\(/);
        expect(block).not.toMatch(/@RoleOnly\(\)/);
      }
    });
  });
});

/**
 * PUBLISHING AN EMAIL NOBODY HAS EVER RECEIVED.
 *
 * The gate on publishing was a checkbox in the browser: the administrator ticked "I have inspected
 * the preview" and the server published whatever arrived. A preview is a browser drawing HTML; an
 * inbox is a different engine, on a different screen, usually with images switched off — and the
 * recipients of these seven templates are candidates being asked for their Aadhaar number and their
 * bank details, who do not write in to say an email looked broken.
 *
 * So the browser's promise was replaced by a fact the server checks: the checksum of the HTML that
 * was actually delivered, against the draft about to go live. These pin the refusal itself — the
 * loader's memory of it is pinned separately in `email-template-publish-gate.spec.ts`.
 */
describe('publishing requires a test that was actually delivered', () => {
  const KEY = 'otp-verification';
  const DRAFT = '<html><body><p>Your code is {{otpCode}}, valid {{validMinutes}} minutes. '
    + '<img src="{{logoUrl}}" alt="logo"> <a href="mailto:{{supportEmail}}">Help</a></p></body></html>';

  const controllerWith = (over: {
    emailEnabled?: boolean;
    tested?: boolean;
    storedDraftHtml?: string | null;
  } = {}) => {
    const publishDraft = jest.fn().mockResolvedValue({ version: 3, checksum: 'abc' });
    const loader = {
      saveDraft: jest.fn().mockResolvedValue(undefined),
      publishDraft,
      hasTestedDraft: jest.fn().mockResolvedValue(over.tested ?? false),
      getStoredSettings: jest.fn().mockResolvedValue({
        versions: [],
        draft: over.storedDraftHtml === null ? null : { html: over.storedDraftHtml ?? DRAFT },
        lastTestSend: over.tested ? { checksum: 'x', to: 'priya@example.com', at: '2026-09-16T00:00:00Z' } : null,
      }),
    };
    const { NotificationAdminController } = require('./notification-admin.controller');
    const controller = new NotificationAdminController(
      {} as never,
      { isEnabled: () => over.emailEnabled ?? true } as never,
      {} as never,
      { recordEventSafe: jest.fn().mockResolvedValue(undefined), record: jest.fn(), log: jest.fn() } as never,
      {} as never,
      loader as never,
      {} as never,
    );
    return { controller, loader, publishDraft };
  };

  const req = { user: { id: 'u-1', displayName: 'Priya' } };

  it('refuses a draft nobody has received, and says what to do about it', async () => {
    const { controller, publishDraft } = controllerWith({ tested: false });

    await expect(controller.publishEmailTemplate(KEY, { html: DRAFT }, req))
      .rejects.toThrow(/Send yourself a test of this exact version first/i);
    expect(publishDraft).not.toHaveBeenCalled();
  });

  /** The specific trap: tested once, edited again, published. */
  it('names the case where the test was of an earlier version', async () => {
    const { controller } = controllerWith({ tested: false, storedDraftHtml: DRAFT });
    // `lastTestSend` exists but does not match — the message has to distinguish the two.
    await expect(controller.publishEmailTemplate(KEY, { html: DRAFT }, req))
      .rejects.toThrow(/No test of this email has been sent yet|earlier version/i);
  });

  it('publishes once the delivered version is the one on screen', async () => {
    const { controller, publishDraft } = controllerWith({ tested: true });

    await expect(controller.publishEmailTemplate(KEY, { html: DRAFT }, req))
      .resolves.toEqual({ version: { version: 3, checksum: 'abc' } });
    expect(publishDraft).toHaveBeenCalled();
  });

  /**
   * With no transport configured a test cannot be sent at all, and refusing to publish would leave
   * the feature unusable rather than safe — the guard exists to stop a broken email reaching
   * people, not to stop the product working before email is switched on.
   */
  it('does not demand the impossible when email delivery is not configured', async () => {
    const { controller, publishDraft } = controllerWith({ emailEnabled: false, tested: false });

    await expect(controller.publishEmailTemplate(KEY, { html: DRAFT }, req)).resolves.toBeTruthy();
    expect(publishDraft).toHaveBeenCalled();
  });
});

/**
 * THE TWO ADMINISTRATOR TEST SENDS GO THROUGH THE ONE EMAIL PATH.
 *
 * Both used to call the transport directly, so the emails an administrator sent to check the mail
 * setup were the only ones the system did not record. They wait for the answer (`sendNow` — the
 * answer IS whether it went) and land in `outbound_emails` like every other email. The template
 * test still composes its own draft — interpolating an unpublished draft is authoring, not sending
 * — and hands the result over already rendered.
 */
describe('administrator test sends', () => {
  const KEY = 'otp-verification';
  const DRAFT = '<html><body><p>Your code is {{otpCode}}, valid {{validMinutes}} minutes. '
    + '<img src="{{logoUrl}}" alt="logo"> <a href="mailto:{{supportEmail}}">Help</a></p></body></html>';
  const req = { user: { id: '9d1c1b7e-5d7a-4a57-9a0e-0c1b2d3e4f50', displayName: 'Priya' } };
  const receipt = { id: 'e-1', status: 'SENT', to: 'priya@example.com' };

  const controllerWith = (sendNow: jest.Mock, enabled = true) => {
    const email = { isEnabled: jest.fn(() => enabled), sendNow, queue: jest.fn() };
    const loader = { recordTestSend: jest.fn().mockResolvedValue(undefined) };
    const audit = { recordEventSafe: jest.fn().mockResolvedValue(undefined) };
    const renderer = {
      interpolate: jest.fn((tpl: string, payload: any) => tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => String(payload[k] ?? ''))),
      render: jest.fn(),
    };
    const { NotificationAdminController } = require('./notification-admin.controller');
    const controller = new NotificationAdminController(
      {} as never, email as never, {} as never, audit as never, {} as never, loader as never, renderer as never,
    );
    return { controller, email, loader, audit, renderer };
  };

  it('the transport test sends now, as a TRANSPORT_TEST, and answers in the fields the settings screen reads', async () => {
    const sendNow = jest.fn().mockResolvedValue({ sent: true, receipt });
    const { controller } = controllerWith(sendNow);

    const result = await controller.testEmail({ to: 'priya@example.com' }, req);

    expect(sendNow).toHaveBeenCalledTimes(1);
    const [request] = sendNow.mock.calls[0];
    expect(request).toEqual(expect.objectContaining({ kind: 'TRANSPORT_TEST', to: 'priya@example.com', requestedBy: req.user.id }));
    expect(request.content.subject).toBe('FAPOMS test email');
    expect(request.content.layout.title).toBe('Email Delivery Test');
    expect(result).toEqual({ success: true, data: expect.objectContaining({ success: true, receipt }) });
  });

  it('the transport test passes the mail server\'s own refusal back, rather than a generic failure', async () => {
    const sendNow = jest.fn().mockResolvedValue({ sent: false, error: '535 Username and Password not accepted', permanent: true, receipt });
    const { controller } = controllerWith(sendNow);

    const result = await controller.testEmail({ to: 'priya@example.com' }, req);

    expect(result.success).toBe(false);
    expect(result.data.error).toBe('535 Username and Password not accepted');
  });

  it('the template test sends the interpolated DRAFT now, as a TEMPLATE_TEST, and remembers what was delivered', async () => {
    const sendNow = jest.fn().mockResolvedValue({ sent: true, receipt });
    const { controller, loader, audit, renderer } = controllerWith(sendNow);

    await controller.sendTestEmail(KEY, { to: 'priya@example.com', html: DRAFT }, req);

    expect(renderer.render).not.toHaveBeenCalled();
    const [request] = sendNow.mock.calls[0];
    expect(request).toEqual(expect.objectContaining({
      kind: 'TEMPLATE_TEST', to: 'priya@example.com', entityType: 'EMAIL_TEMPLATE', entityId: KEY,
    }));
    expect(Object.keys(request.content)).toEqual(['rendered']);
    expect(request.content.rendered.subject).toMatch(/^\[TEST\] /);
    expect(request.content.rendered.html).toContain('Your code is 849201');
    expect(request.content.rendered.text).toContain('849201');
    expect(loader.recordTestSend).toHaveBeenCalledWith(KEY, DRAFT, 'priya@example.com', 'Priya');
    expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'EMAIL_TEMPLATE_TEST_SENT' }));
  });

  it('a template test that did not go is refused, and is not remembered as a delivered test', async () => {
    const sendNow = jest.fn().mockResolvedValue({ sent: false, error: '550 mailbox unavailable', receipt });
    const { controller, loader } = controllerWith(sendNow);

    await expect(controller.sendTestEmail(KEY, { to: 'priya@example.com', html: DRAFT }, req))
      .rejects.toThrow(/550 mailbox unavailable/);
    expect(loader.recordTestSend).not.toHaveBeenCalled();
  });

  it('neither test tries to send when email is not set up', async () => {
    const sendNow = jest.fn();
    const { controller } = controllerWith(sendNow, false);

    await expect(controller.testEmail({ to: 'priya@example.com' }, req)).rejects.toThrow(/not configured/);
    await expect(controller.sendTestEmail(KEY, { to: 'priya@example.com', html: DRAFT }, req)).rejects.toThrow(/not configured/);
    expect(sendNow).not.toHaveBeenCalled();
  });
});

/**
 * THE SMS ROUTES, SHAPED LIKE THE EMAIL ONES.
 *
 * The owner asked for SMS to be built exactly like email and switched on later. So the fences are
 * the email routes' fences — the transport test is the developer's (it spends money sending to a
 * real phone), the wording is the administrator's (like the email templates) — and the answers are
 * the email routes' answers, so the settings screen reads both the same way. The status never carries
 * the gateway key; the template write is audited without the wording.
 */
describe('the SMS routes', () => {
  const source = readFileSync(join(__dirname, 'notification-admin.controller.ts'), 'utf8');
  const decoratorsAbove = (handlerName: string): string => {
    const lines = source.split('\n');
    const target = lines.findIndex((l) => l.includes(`async ${handlerName}(`));
    expect(target).toBeGreaterThan(-1);
    let start = 0;
    for (let i = target - 1; i >= 0; i--) {
      if (/^ {2}\}\s*$/.test(lines[i]) || /^export class /.test(lines[i])) { start = i + 1; break; }
    }
    return lines.slice(start, target).join('\n');
  };

  const req = { user: { id: '9d1c1b7e-5d7a-4a57-9a0e-0c1b2d3e4f50', displayName: 'Priya Raghavendran of Operations Support' } };
  const receipt = { id: 's-1', channel: 'SMS', status: 'SENT', to: '9876543210' };

  const controllerWith = (over: { enabled?: boolean; sendNow?: jest.Mock; state?: any; templates?: any } = {}) => {
    const sms = { isEnabled: jest.fn(() => over.enabled ?? true), sendNow: over.sendNow ?? jest.fn() };
    const provider = {
      describe: jest.fn(() => over.state ?? { enabled: true, provider: 'PINNACLE', senderId: 'SUMERU', dltEntityIdSet: true, problem: null }),
    };
    const templates = over.templates ?? { describeAll: jest.fn(), saveOverride: jest.fn(), describe: jest.fn() };
    const audit = { recordEventSafe: jest.fn().mockResolvedValue(undefined) };
    const { NotificationAdminController } = require('./notification-admin.controller');
    const controller = new NotificationAdminController(
      {} as never, {} as never, {} as never, audit as never, {} as never, {} as never, {} as never,
      sms as never, provider as never, templates as never,
    );
    return { controller, sms, provider, templates, audit };
  };

  describe('guards', () => {
    it('sms/test is the developer\'s, by name only, like email/test', () => {
      const block = decoratorsAbove('testSms');
      expect(block).toMatch(/@Roles\(SystemRole\.DEVELOPER\)/);
      expect(block).toMatch(/@RequirePermissions\('system:edit:platform'\)/);
      expect(block).toMatch(/@RoleOnly\(\)/);
      expect(block).toMatch(/@Post\('sms\/test'\)/);
    });

    /** It sends a real text to a real phone, so it is fenced like the transport test, not the save. */
    it('testing one SMS template is the developer\'s too, exactly like sms/test', () => {
      const block = decoratorsAbove('testSmsTemplate');
      expect(block).toMatch(/@Roles\(SystemRole\.DEVELOPER\)/);
      expect(block).toMatch(/@RequirePermissions\('system:edit:platform'\)/);
      expect(block).toMatch(/@RoleOnly\(\)/);
      expect(block).toMatch(/@Post\('sms-templates\/:key\/test'\)/);
    });

    it('saving an SMS template takes what publishing an email template takes', () => {
      const block = decoratorsAbove('saveSmsTemplate');
      expect(block).toMatch(/@Put\('sms-templates\/:key'\)/);
      expect(block).toMatch(/@Roles\(\.\.\.NOTIFICATION_ADMIN_ROLES\)/);
      expect(block).toMatch(/@RequirePermissions\('configuration:edit:platform'\)/);
      expect(block).toMatch(/@RoleOnly\(\)/);
    });

    it('the two reads name no permission, so the permission fallback never opens them', () => {
      for (const handler of ['smsStatus', 'listSmsTemplates']) {
        const block = decoratorsAbove(handler);
        expect(block).not.toMatch(/@RequirePermissions\(/);
        expect(block).not.toMatch(/@Roles\(/);
      }
    });
  });

  describe('sms/status', () => {
    it('answers enabled, provider, sender, whether DLT is set — and nothing like a key', async () => {
      const { controller } = controllerWith();

      const status = await controller.smsStatus();

      expect(status).toEqual({ enabled: true, provider: 'PINNACLE', senderId: 'SUMERU', dltEntityIdSet: true, hint: null });
    });

    it('passes on why it is not sending, in the provider\'s words', async () => {
      const { controller } = controllerWith({
        state: { enabled: false, provider: 'PINNACLE', senderId: 'SUMER', dltEntityIdSet: false, problem: 'The sender header "SUMER" is not 6 letters.' },
      });

      await expect(controller.smsStatus()).resolves.toMatchObject({ enabled: false, hint: 'The sender header "SUMER" is not 6 letters.' });
    });

    it('warns when it is sending without a DLT Principal Entity ID', async () => {
      const { controller } = controllerWith({
        state: { enabled: true, provider: 'PINNACLE', senderId: 'SUMERU', dltEntityIdSet: false, problem: null },
      });

      expect((await controller.smsStatus()).hint).toMatch(/DLT Principal Entity ID/);
    });
  });

  describe('sms/test', () => {
    it('sends the registered transport-test text now, as a TRANSPORT_TEST, and answers like email/test', async () => {
      const sendNow = jest.fn().mockResolvedValue({ sent: true, receipt });
      const { controller } = controllerWith({ sendNow });

      const result = await controller.testSms({ to: '98765 43210' }, req);

      expect(sendNow).toHaveBeenCalledWith({
        kind: 'TRANSPORT_TEST',
        to: '98765 43210',
        requestedBy: req.user.id,
        /*
          Nothing to fill in. The test wording carries no variables — the simplest thing a DLT
          reviewer can approve — so who pressed the button travels in the ledger and the audit row,
          not in the message. A value here would be a value the registered template has no room for.
        */
        content: { template: 'transport-test', data: {} },
      });
      expect(result).toEqual({ success: true, data: { success: true, error: undefined, permanent: undefined, receipt } });
    });

    it('passes the gateway\'s own refusal back', async () => {
      const sendNow = jest.fn().mockResolvedValue({ sent: false, error: 'Pinnacle refused it: Invalid DLT template id', permanent: true, receipt });
      const { controller } = controllerWith({ sendNow });

      const result = await controller.testSms({ to: '9876543210' }, req);

      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: 'Pinnacle refused it: Invalid DLT template id', permanent: true });
    });

    it('does not try when SMS is not set up, or the number is not an Indian mobile', async () => {
      const off = controllerWith({ enabled: false });
      await expect(off.controller.testSms({ to: '9876543210' }, req)).rejects.toThrow(/not configured/);
      expect(off.sms.sendNow).not.toHaveBeenCalled();

      const on = controllerWith();
      await expect(on.controller.testSms({ to: '0712345678' }, req)).rejects.toThrow(/Indian mobile/);
      expect(on.sms.sendNow).not.toHaveBeenCalled();
    });
  });

  describe('sms-templates', () => {
    it('lists what the template service describes', async () => {
      const views = [{ key: 'mfa-code', name: 'Sign-in verification code' }];
      const { controller } = controllerWith({ templates: { describeAll: jest.fn().mockResolvedValue(views), saveOverride: jest.fn() } });

      await expect(controller.listSmsTemplates()).resolves.toBe(views);
    });

    it('saves through the template service and audits which fields changed, not the wording', async () => {
      const view = { key: 'mfa-code', dltTemplateId: '1107160000000012345' };
      const saveOverride = jest.fn().mockResolvedValue(view);
      const { controller, audit } = controllerWith({ templates: { describeAll: jest.fn(), saveOverride } });

      const result = await controller.saveSmsTemplate('mfa-code', { text: 'Code {{code}} {{validMinutes}}', dltTemplateId: '1107160000000012345' }, req);

      expect(result).toBe(view);
      expect(saveOverride).toHaveBeenCalledWith('mfa-code', { text: 'Code {{code}} {{validMinutes}}', dltTemplateId: '1107160000000012345' }, req.user.id);
      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'SMS_TEMPLATE_SAVED',
        userId: req.user.id,
        metadata: expect.objectContaining({ notificationType: 'mfa-code', textChanged: true, dltTemplateIdSet: true }),
      }));
      expect(JSON.stringify(audit.recordEventSafe.mock.calls)).not.toContain('Code {{code}}');
    });

    it('does not audit a save the template service refused', async () => {
      const saveOverride = jest.fn().mockRejectedValue(new Error('The wording must still contain {{code}}'));
      const { controller, audit } = controllerWith({ templates: { describeAll: jest.fn(), saveOverride } });

      await expect(controller.saveSmsTemplate('mfa-code', { text: 'no code' }, req)).rejects.toThrow(/\{\{code\}\}/);
      expect(audit.recordEventSafe).not.toHaveBeenCalled();
    });
  });

  /**
   * SENDING A TEST OF ONE TEMPLATE, the twin of `email-templates/:key/test`.
   *
   * `sms/test` answers "does the gateway work"; this answers "does THIS text work", which is the
   * question that actually fails — a template whose DLT Template ID is missing or registered for
   * older wording is dropped by every operator while everything else looks healthy.
   */
  describe('sms-templates/:key/test', () => {
    const VIEW = {
      key: 'app-credentials',
      name: 'App access credentials',
      sampleData: { username: 'AS0323', temporaryPassword: 'tiger-mango-9', validDays: '7' },
      dltTemplateId: '1107160000000099999',
    };
    const withTemplate = (over: { sendNow?: jest.Mock; enabled?: boolean; view?: any } = {}) => controllerWith({
      enabled: over.enabled,
      sendNow: over.sendNow,
      templates: {
        describeAll: jest.fn(),
        saveOverride: jest.fn(),
        describe: jest.fn().mockResolvedValue(over.view ?? VIEW),
      },
    });

    it('sends that template, with its own example values, as a TRANSPORT_TEST', async () => {
      const sendNow = jest.fn().mockResolvedValue({ sent: true, receipt });
      const { controller, templates } = withTemplate({ sendNow });

      const result = await controller.testSmsTemplate('app-credentials', { to: '98765 43210' }, req);

      expect(templates.describe).toHaveBeenCalledWith('app-credentials');
      expect(sendNow).toHaveBeenCalledWith({
        // Not a new kind: the ledger's list of SMS kinds is a decision somebody makes on purpose.
        kind: 'TRANSPORT_TEST',
        to: '98765 43210',
        requestedBy: req.user.id,
        content: { template: 'app-credentials', data: VIEW.sampleData },
      });
      expect(result).toEqual({ success: true, data: { success: true, error: undefined, permanent: undefined, receipt } });
    });

    /** A half-written value would be refused by the renderer, not delivered — so the sample fills in. */
    it('puts what the administrator typed over the example values, and ignores the blanks', async () => {
      const sendNow = jest.fn().mockResolvedValue({ sent: true, receipt });
      const { controller } = withTemplate({ sendNow });

      await controller.testSmsTemplate(
        'app-credentials',
        { to: '9876543210', data: { username: 'AS0999', temporaryPassword: '   ', validDays: '' } },
        req,
      );

      expect(sendNow).toHaveBeenCalledWith(expect.objectContaining({
        content: { template: 'app-credentials', data: { username: 'AS0999', temporaryPassword: 'tiger-mango-9', validDays: '7' } },
      }));
    });

    it('records where the test went and whether it arrived, never the wording', async () => {
      const sendNow = jest.fn().mockResolvedValue({ sent: true, receipt });
      const { controller, audit } = withTemplate({ sendNow });

      await controller.testSmsTemplate('app-credentials', { to: '9876543210' }, req);

      expect(audit.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'SMS_TEMPLATE_TEST_SENT',
        userId: req.user.id,
        metadata: expect.objectContaining({ notificationType: 'app-credentials', to: '9876543210', sent: true }),
      }));
      expect(JSON.stringify(audit.recordEventSafe.mock.calls)).not.toContain('tiger-mango-9');
    });

    /** Like `sms/test`: the request worked, the gateway said no, and its reason is what to read. */
    it('passes the gateway\'s own refusal back rather than claiming it went', async () => {
      const sendNow = jest.fn().mockResolvedValue({
        sent: false, error: 'This text has no DLT template id; add it under SMS templates in Platform Settings.', permanent: true, receipt,
      });
      const { controller } = withTemplate({ sendNow });

      const result = await controller.testSmsTemplate('app-credentials', { to: '9876543210' }, req);

      expect(result.success).toBe(false);
      expect(result.data.permanent).toBe(true);
      expect(result.data.error).toMatch(/DLT template id/);
    });

    it('does not try when SMS is not set up, or the number is not an Indian mobile', async () => {
      const off = withTemplate({ enabled: false });
      await expect(off.controller.testSmsTemplate('app-credentials', { to: '9876543210' }, req)).rejects.toThrow(/not configured/);
      expect(off.sms.sendNow).not.toHaveBeenCalled();

      const on = withTemplate();
      await expect(on.controller.testSmsTemplate('app-credentials', { to: '0712345678' }, req)).rejects.toThrow(/Indian mobile/);
      expect(on.sms.sendNow).not.toHaveBeenCalled();
    });

    /** The key comes off a URL, so it is checked before anything is sent or written down. */
    it('refuses a key that is not a template, without sending or auditing', async () => {
      const { controller, sms, audit } = controllerWith({
        templates: {
          describeAll: jest.fn(),
          saveOverride: jest.fn(),
          describe: jest.fn().mockRejectedValue(new BadRequestException('Unknown SMS template "made-up".')),
        },
      });

      await expect(controller.testSmsTemplate('made-up', { to: '9876543210' }, req)).rejects.toThrow(/Unknown SMS template/);
      expect(sms.sendNow).not.toHaveBeenCalled();
      expect(audit.recordEventSafe).not.toHaveBeenCalled();
    });
  });
});

/**
 * WHAT A PREVIEW SHOWS HAS TO BE WHAT A RECIPIENT GETS.
 *
 * The values every message carries — {{name}}, {{companyName}}, {{time}} — are filled by the
 * platform at send time, not by the caller's data. A preview that filled only the caller's data
 * would show those as blanks, and an administrator seeing a blank where a name should be takes the
 * placeholder back out of the wording. So the preview fills them too, addressed to an obviously
 * sample recipient.
 */
describe('previewing an email template', () => {
  const { EMAIL_TEMPLATE_REGISTRY } = require('../../infrastructure/notifications/email-template-registry');

  const renderer = () => ({
    interpolate: jest.fn((tpl: string, payload: any) =>
      tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => String(payload[k] ?? ''))),
    render: jest.fn(async (key: string, payload: any, recipient: any) => ({ key, payload, recipient })),
  });

  const controllerWith = (rendered: ReturnType<typeof renderer>) => {
    const tokens = { common: jest.fn(async (recipient: any) => ({ ...recipient, companyName: 'Sumeru Global', time: '6:42 pm' })) };
    const { NotificationAdminController } = require('./notification-admin.controller');
    return new NotificationAdminController(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      rendered as never, {} as never, {} as never, {} as never, tokens as never,
    );
  };

  it('fills the values every message carries into a draft, so they do not preview as blanks', async () => {
    const rendered = renderer();
    const controller = controllerWith(rendered);

    const result = await controller.previewEmailTemplate(
      'app-credentials',
      { html: '<p>Hi {{name}} of {{companyName}} at {{time}} — {{username}}</p>' },
      null,
    );

    expect(result.html).toContain('Hi Ramesh Kumar of Sumeru Global at 6:42 pm');
    // And the template's own sample data still fills its own placeholders.
    expect(result.html).toContain(EMAIL_TEMPLATE_REGISTRY['app-credentials'].sampleData.username);
  });

  it('tells the renderer who the sample preview is for when there is no draft to interpolate', async () => {
    const rendered = renderer();
    const controller = controllerWith(rendered);

    await controller.previewEmailTemplate('app-credentials', {}, null);

    expect(rendered.render).toHaveBeenCalledTimes(1);
    expect(rendered.render.mock.calls[0][2]).toEqual(expect.objectContaining({ name: 'Ramesh Kumar' }));
  });
});
