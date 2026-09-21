import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
// expandAudience: the addressing direction of the role hierarchy — a section aimed at a role
// also reaches every role that implies it (DEVELOPER, for ADMIN and PRODUCT_SUPPORT), same
// rule as notification fan-out (NotificationDispatchService.usersInRoles).
import {
  formatRupees, BUSINESS_TODAY_SQL, BUSINESS_TIME_ZONE, businessTodayDateKey, escapeEmailHtml, expandAudience,
} from '@fapoms/shared';

import { DeskEscalationService } from '../../modules/validation/desk-escalation.service';
import { FeedbackEscalationService } from '../../modules/feedback/feedback-escalation.service';
import { HrWorkforceService } from '../../modules/assayer/hr-workforce.service';
import { FEEDBACK_TEAM_ROLE_NAMES } from '../../modules/feedback/feedback-roles';
import { appPublicUrl } from '../notifications/email-provider';
import { EmailService } from '../../modules/notifications/email.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { UserEntity } from '../../modules/user/user.entity';
import { usersHoldingPermission } from '../../modules/notifications/permission-audience';

/**
 * The morning email: everything that needs a decision, one message per person, only when
 * there is something to say.
 *
 * The event pipeline emails the moments something breaks (SLA breach, incident, billing
 * conflict). What it cannot do is chase the slow rot — the payable approval queue nobody has
 * opened, the expense claims ageing quietly, the feedback past its SLA since Tuesday. Those
 * already had assembly points computing exactly this data for dashboard panels
 * (`DeskEscalationService.attention()`, `FeedbackEscalationService.attention()`, the billing
 * ageing queries); this service is deliberately just a renderer over them, with no aggregation
 * logic of its own to drift out of agreement with the screens.
 *
 * Discipline inherited from the notification catalog's history: over-notification is a
 * measured failure mode here. One email per person per morning, sections merged across their
 * roles, and a person whose sections are all empty gets NOTHING — an inbox line that says
 * "nothing needs you" trains people to delete the one that says something does.
 *
 * It decides who gets what and hands each email to the one email pipeline
 * (`EmailService.queue`, the `morning-digest` template). It does not send, render or retry: the
 * wording is the template's (administrator-editable, with the registry's built-in fallback), and
 * delivery, retries and "did it go" are the mail queue's, recorded in `outbound_emails` under
 * `entityType: 'DIGEST'` and the business date.
 */

interface DigestSection {
  heading: string;
  lines: string[];
  link: string;
}

/**
 * Which roles receive which sections. A user with several roles gets the union, once.
 * Each list is widened through `expandAudience` in `resolveRecipients`, so a role that implies
 * one of these also gets the section — the developer inherits anything aimed at the roles it
 * absorbed, without being named here.
 */
const SECTION_AUDIENCES: Record<string, string[]> = {
  desk: ['DESK', 'DESK_OPERATOR'],
  // Whoever owns the feedback desk — one list, see feedback-roles.ts (the developer, plus the
  // PRODUCT_SUPPORT delegate; administrators lost the desk 2026-09-05).
  feedback: FEEDBACK_TEAM_ROLE_NAMES,
  finance: ['OPERATIONS'],
  hr: ['OPERATIONS'],
};

/**
 * A permission that also earns a section, for a role built in Admin -> Roles that
 * `SECTION_AUDIENCES` has never heard of by name — same mirrored-fallback mechanism as the
 * notification catalog's `fallbackPermissions` (see `usersHoldingPermission` and the comment on
 * `NotificationDispatchService.usersInRoles`, and that field's own comment for the general rule
 * this follows: match whatever permission gates the section's own `link` in
 * `route-permissions.ts`, never invent one).
 *
 * `desk` and `finance` match their section's `link` exactly — `/validation` and `/billing`
 * both declare a single `requiredPermissions` entry in that table, `VALIDATION:VIEW:ORGANIZATION`
 * and `BILLING:VIEW:ORGANIZATION` respectively, so a custom role that can already open the page a
 * section points to now also hears about it in the morning brief. `feedback` is left unset on
 * purpose, not an oversight: `/feedback` itself declares no permission a role could be granted —
 * FEEDBACK_TEAM_ROLE_NAMES is ADMIN-only by the platform owner's explicit decision (see
 * feedback-roles.ts), unrelated to any resource permission, so there is nothing to widen past.
 */
const SECTION_FALLBACK_PERMISSIONS: Record<string, string[]> = {
  desk: ['VALIDATION:VIEW:ORGANIZATION'],
  finance: ['BILLING:VIEW:ORGANIZATION'],
  hr: ['ASSAYER:VIEW:ORGANIZATION'],
};

@Injectable()
export class EmailDigestService {
  private readonly logger = new Logger(EmailDigestService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly deskEscalation: DeskEscalationService,
    private readonly feedbackEscalation: FeedbackEscalationService,
    private readonly hrWorkforce: HrWorkforceService,
    private readonly email: EmailService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /**
   * Assembles today's brief and queues one email per recipient.
   *
   * The job runs with `attempts: 1` (scheduled and "run it now" alike), and that is still right
   * now that it only queues: a retry re-runs the whole brief, and every person the first run had
   * already queued would get a second copy. Queueing does not throw — a recipient whose email
   * could not be queued is counted and logged, and the rest still go.
   */
  async run(): Promise<{ queued: number; notQueued: number }> {
    const enabled = await this.settings.get<boolean>('digest.enabled').catch(() => true);
    if (enabled === false) {
      this.logger.log('Morning digest is switched off in platform settings.');
      return { queued: 0, notQueued: 0 };
    }
    // Checked here as well as by the mail queue: with no transport, assembling the brief and
    // recording one failed email per recipient every morning would be work for nothing.
    if (!this.email.isEnabled()) {
      this.logger.log('Email is not configured; morning digest skipped.');
      return { queued: 0, notQueued: 0 };
    }

    const sections = await this.assembleSections();
    const populated = Object.entries(sections).filter(([, s]) => s !== null) as [string, DigestSection][];
    if (populated.length === 0) {
      this.logger.log('Morning digest: nothing needs attention today — no emails sent.');
      return { queued: 0, notQueued: 0 };
    }

    const recipients = await this.resolveRecipients(populated.map(([key]) => key));
    const businessDate = businessTodayDateKey();
    const briefDate = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: BUSINESS_TIME_ZONE,
    });

    let queued = 0;
    let notQueued = 0;
    for (const r of recipients) {
      const theirSections = populated.filter(([key]) => r.sectionKeys.has(key)).map(([, s]) => s);
      if (!theirSections.length) continue;

      const receipt = await this.email.queue({
        kind: 'MORNING_DIGEST',
        to: r.email,
        entityType: 'DIGEST',
        entityId: businessDate,
        requestedBy: null,
        content: {
          template: 'morning-digest',
          data: {
            subjectCounts: theirSections.map((s) => s.heading).join(' · '),
            briefDate,
            digestSectionsHtml: EmailDigestService.sectionsHtml(theirSections),
            digestSectionsText: EmailDigestService.sectionsText(theirSections),
            portalUrl: `${appPublicUrl()}${theirSections[0].link}`,
            logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png`,
            companyName: 'Sumeru Global',
          },
        },
      });

      if (receipt.status === 'NOT_QUEUED') {
        notQueued++;
        this.logger.warn(`Digest to ${r.email} could not be queued: ${receipt.error ?? 'no reason given'}`);
      } else {
        queued++;
      }
    }

    this.logger.log(`Morning digest: ${queued} queued, ${notQueued} not queued, ${recipients.length} candidate recipient(s).`);
    return { queued, notQueued };
  }

  /** The same sections as plain lines, for the template's built-in fallback and the text part. */
  private static sectionsText(sections: DigestSection[]): string {
    return sections
      .map((s) => [s.heading, ...s.lines.map((l) => `• ${l}`), `${appPublicUrl()}${s.link}`].join('\n'))
      .join('\n');
  }

  /**
   * The sections, as the template's one raw-HTML token. Everything inside is escaped here: a line
   * can carry text people typed (a feedback title), and a raw token is inserted as-is.
   */
  private static sectionsHtml(sections: DigestSection[]): string {
    return sections
      .map((s) => `
          <div style="background:#ffffff; border:1px solid #E4E7EB; border-left:4px solid #ED6714; border-radius:6px; padding:16px 20px; margin-bottom:16px;">
            <div style="font-size:15px; font-weight:700; color:#1E293B; margin-bottom:10px;">${escapeEmailHtml(s.heading)}</div>
            <ul style="margin:0 0 14px 0; padding-left:20px; font-size:14px; color:#4B5563; line-height:1.6;">
              ${s.lines.map((l) => `<li>${escapeEmailHtml(l)}</li>`).join('')}
            </ul>
            <a href="${escapeEmailHtml(`${appPublicUrl()}${s.link}`)}" style="display:inline-block; font-size:13px; font-weight:600; color:#ED6714; text-decoration:none;">View in FAPOMS &rarr;</a>
          </div>
        `)
      .join('');
  }

  // ---------------------------------------------------------------- sections

  private async assembleSections(): Promise<Record<string, DigestSection | null>> {
    const [desk, feedback, finance, hr] = await Promise.all([
      this.deskSection().catch((e) => this.sectionFailed('desk', e)),
      this.feedbackSection().catch((e) => this.sectionFailed('feedback', e)),
      this.financeSection().catch((e) => this.sectionFailed('finance', e)),
      this.hrSection().catch((e) => this.sectionFailed('hr', e)),
    ]);
    return { desk, feedback, finance, hr };
  }

  /** A broken section must cost its own content, never the whole digest. */
  private sectionFailed(name: string, err: any): null {
    this.logger.warn(`Digest section "${name}" failed to assemble: ${err?.message ?? err}`);
    return null;
  }

  private async deskSection(): Promise<DigestSection | null> {
    // Counts, not row counts. These are the true breach totals — the digest used to report the
    // screen's fifty-row cap, so a morning brief could say "50 unassigned" on a desk with 400.
    const a = await this.deskEscalation.attention();
    const buckets: Array<[string, number]> = [
      ['unassigned past SLA', a.unassignedOverdue.total],
      ['entry overdue', a.entryOverdue.total],
      ['rework stale', a.reworkStale.total],
      ['review overdue', a.reviewOverdue.total],
      ['submission to client overdue', a.submitOverdue.total],
      ['OCR stuck', a.ocrStuck.total],
      ['clarifications overdue', a.clarificationsOverdue.total],
    ];
    const nonEmpty = buckets.filter(([, n]) => n > 0);
    if (!nonEmpty.length) return null;
    return {
      heading: `Data desk: ${nonEmpty.reduce((s, [, n]) => s + n, 0)} stalled item(s)`,
      lines: nonEmpty.map(([label, n]) => `${n} ${label}`),
      link: '/validation',
    };
  }

  private async feedbackSection(): Promise<DigestSection | null> {
    const a = await this.feedbackEscalation.attention();
    const first = a.firstResponseOverdue.length;
    const resolution = a.resolutionOverdue.length;
    if (first + resolution === 0) return null;
    const oldest = [...a.firstResponseOverdue, ...a.resolutionOverdue]
      .sort((x, y) => y.ageHours - x.ageHours)[0];
    return {
      heading: `Support: ${first + resolution} past SLA`,
      lines: [
        ...(first ? [`${first} awaiting a first response`] : []),
        ...(resolution ? [`${resolution} past the resolution target`] : []),
        ...(oldest ? [`Oldest: "${oldest.title}" (${Math.round(oldest.ageHours)}h)`] : []),
      ],
      link: '/feedback',
    };
  }

  private async financeSection(): Promise<DigestSection | null> {
    // Named in the log like every other section, rather than silently becoming an empty
    // result: a finance brief that is quietly missing its overdue invoices reads exactly like
    // a morning with none.
    const q = (sql: string, label: string) =>
      this.dataSource.query(sql).catch((err: any) => {
        this.logger.warn(`Digest finance query "${label}" failed: ${err?.message ?? err}`);
        return [] as any[];
      });
    const [payables, expenses, invoices] = await Promise.all([
      q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount),0)::numeric AS total,
                EXTRACT(DAY FROM NOW() - MIN(created_at))::int AS oldest_days
           FROM assayer_payables WHERE status = 'PENDING' AND on_hold = false AND is_active = true`, 'pending payables'),
      q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS total
           FROM assignment_expenses WHERE status = 'PENDING' AND is_active = true`, 'pending expense claims'),
      q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(outstanding_amount),0)::numeric AS total
           FROM billing_invoices
          WHERE due_date < ${BUSINESS_TODAY_SQL} AND COALESCE(outstanding_amount, 0) > 0 AND is_active = true`, 'overdue invoices'),
    ]);

    const p = payables?.[0] ?? {};
    const e = expenses?.[0] ?? {};
    const i = invoices?.[0] ?? {};
    const lines: string[] = [];
    if (Number(p.n) > 0) lines.push(`${p.n} payable(s) awaiting approval — ${formatRupees(Number(p.total))}, oldest ${p.oldest_days} day(s)`);
    if (Number(e.n) > 0) lines.push(`${e.n} expense claim(s) pending review — ${formatRupees(Number(e.total))}`);
    if (Number(i.n) > 0) lines.push(`${i.n} invoice(s) overdue — ${formatRupees(Number(i.total))} outstanding`);
    if (!lines.length) return null;
    return { heading: 'Finance: money waiting on a decision', lines, link: '/billing' };
  }

  private async hrSection(): Promise<DigestSection | null> {
    const expiring = await this.hrWorkforce.credentialsExpiringWithin(30);
    if (!expiring.length) return null;
    const soonest = [...expiring].sort((a: any, b: any) =>
      String(a.expiryDate).localeCompare(String(b.expiryDate)))[0] as any;
    return {
      heading: `Workforce: ${expiring.length} credential(s) expiring within 30 days`,
      lines: [
        // "credential(s)", not "document(s)": this list now covers professional certifications
        // as well as identity documents (see credentialsExpiringWithin). Calling a certification
        // a document would send HR looking in the wrong place on the compliance page.
        `${expiring.length} assayer credential(s) fall due this month`,
        ...(soonest ? [`Soonest: ${soonest.documentName} of ${soonest.assayerName} on ${soonest.expiryDate}`] : []),
      ],
      link: '/hr',
    };
  }

  // ---------------------------------------------------------------- audience

  /**
   * Every active internal user holding a role any populated section addresses, with the
   * sections their roles entitle them to. The same active-account discipline as notification
   * fan-out (is_active AND status ACTIVE), plus the email preference: a SYSTEM-category row
   * with email=false is this digest's off switch — absence of a row means opted in, the
   * convention every other channel follows.
   */
  private async resolveRecipients(
    populatedKeys: string[],
  ): Promise<Array<{ email: string; sectionKeys: Set<string> }>> {
    const roleToSections = new Map<string, string[]>();
    for (const key of populatedKeys) {
      // Audience expansion (see the import note): the map gains a row per implying role too, so
      // both the SQL below and the per-row section lookup see the widened audience.
      for (const role of expandAudience(SECTION_AUDIENCES[key] ?? [])) {
        roleToSections.set(role, [...(roleToSections.get(role) ?? []), key]);
      }
    }
    const roles = [...roleToSections.keys()];

    const byUser = new Map<string, { email: string; sectionKeys: Set<string> }>();

    if (roles.length) {
      const rows: Array<{ id: string; email: string; role_name: string }> = await this.dataSource.query(
        `SELECT u.id, u.email, r.name AS role_name
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
          WHERE r.name = ANY($1)
            AND u.is_active = true
            AND u.status = 'ACTIVE'
            AND u.email IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM notification_preferences np
               WHERE np.user_id = u.id AND np.category = 'SYSTEM' AND np.email = false
            )`,
        [roles],
      ).catch((err) => {
        this.logger.warn(`Digest audience query failed: ${err?.message}`);
        return [];
      });

      for (const row of rows) {
        const entry = byUser.get(row.id) ?? { email: row.email, sectionKeys: new Set<string>() };
        for (const key of roleToSections.get(row.role_name) ?? []) entry.sectionKeys.add(key);
        byUser.set(row.id, entry);
      }
    }

    /**
     * A role built in Admin -> Roles, for each section `SECTION_FALLBACK_PERMISSIONS` names —
     * see the constant's own comment. One query per populated section carrying a fallback
     * (at most a handful), each honouring the same active-account and email-opt-out rules as
     * the role-based query above.
     */
    const fallbackSections = populatedKeys.filter((key) => SECTION_FALLBACK_PERMISSIONS[key]?.length);
    if (fallbackSections.length) {
      const optedOut = new Set<string>(
        (await this.dataSource
          .query(`SELECT user_id FROM notification_preferences WHERE category = 'SYSTEM' AND email = false`)
          .catch((err: any) => {
            this.logger.warn(`Digest opt-out lookup failed: ${err?.message}`);
            return [];
          }))
          .map((r: any) => r.user_id),
      );
      const userRepository = this.dataSource.getRepository(UserEntity);
      for (const key of fallbackSections) {
        const holders = await usersHoldingPermission(userRepository, SECTION_FALLBACK_PERMISSIONS[key]).catch((err) => {
          this.logger.warn(`Digest permission-fallback for "${key}" failed: ${err?.message}`);
          return [] as UserEntity[];
        });
        for (const u of holders) {
          if (!u.email || optedOut.has(u.id)) continue;
          const entry = byUser.get(u.id) ?? { email: u.email, sectionKeys: new Set<string>() };
          entry.sectionKeys.add(key);
          byUser.set(u.id, entry);
        }
      }
    }

    return [...byUser.values()];
  }
}
