import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { formatRupees } from '@fapoms/shared';

import { DeskEscalationService } from '../../modules/validation/desk-escalation.service';
import { FeedbackEscalationService } from '../../modules/feedback/feedback-escalation.service';
import { HrWorkforceService } from '../../modules/assayer/hr-workforce.service';
import { FEEDBACK_TEAM_ROLE_NAMES } from '../../modules/feedback/feedback-roles';
import { EmailProvider, appPublicUrl, renderEmailHtml } from '../notifications/email-provider';
import { PlatformSettingsService } from '../settings/platform-settings.service';

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
 */

interface DigestSection {
  heading: string;
  lines: string[];
  link: string;
}

/** Which roles receive which sections. A user with several roles gets the union, once. */
const SECTION_AUDIENCES: Record<string, string[]> = {
  desk: ['DATA_ENTRY_HEAD', 'VALIDATION_MANAGER'],
  // Whoever owns the feedback desk — one list, see feedback-roles.ts (super administrators only).
  feedback: FEEDBACK_TEAM_ROLE_NAMES,
  finance: ['FINANCE_MANAGER'],
  hr: ['HR_MANAGER'],
};

@Injectable()
export class EmailDigestService {
  private readonly logger = new Logger(EmailDigestService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly deskEscalation: DeskEscalationService,
    private readonly feedbackEscalation: FeedbackEscalationService,
    private readonly hrWorkforce: HrWorkforceService,
    private readonly email: EmailProvider,
    private readonly settings: PlatformSettingsService,
  ) {}

  async run(): Promise<{ sent: number; skipped: number }> {
    const enabled = await this.settings.get<boolean>('digest.enabled').catch(() => true);
    if (enabled === false) {
      this.logger.log('Morning digest is switched off in platform settings.');
      return { sent: 0, skipped: 0 };
    }
    if (!this.email.isEnabled()) {
      this.logger.log('Email is not configured; morning digest skipped.');
      return { sent: 0, skipped: 0 };
    }

    const sections = await this.assembleSections();
    const populated = Object.entries(sections).filter(([, s]) => s !== null) as [string, DigestSection][];
    if (populated.length === 0) {
      this.logger.log('Morning digest: nothing needs attention today — no emails sent.');
      return { sent: 0, skipped: 0 };
    }

    const recipients = await this.resolveRecipients(populated.map(([key]) => key));

    let sent = 0;
    let skipped = 0;
    for (const r of recipients) {
      const theirSections = populated.filter(([key]) => r.sectionKeys.has(key)).map(([, s]) => s);
      if (!theirSections.length) continue;

      const subjectCounts = theirSections.map((s) => s.heading).join(' · ');
      const text = theirSections
        .map((s) => `${s.heading}\n${s.lines.map((l) => `  • ${l}`).join('\n')}\n  ${appPublicUrl()}${s.link}`)
        .join('\n\n');

      const result = await this.email.send({
        to: r.email,
        subject: `FAPOMS morning brief — ${subjectCounts}`,
        text,
        html: renderEmailHtml({
          title: 'Needs your attention this morning',
          bodyLines: theirSections.flatMap((s) => [`▸ ${s.heading}`, ...s.lines.map((l) => `   • ${l}`)]),
          linkUrl: `${appPublicUrl()}${theirSections[0].link}`,
          linkLabel: 'Open FAPOMS',
        }),
      });

      if (result.success) sent++;
      else {
        skipped++;
        this.logger.warn(`Digest to ${r.email} failed: ${result.error}`);
      }
    }

    this.logger.log(`Morning digest: ${sent} sent, ${skipped} failed, ${recipients.length} candidate recipient(s).`);
    return { sent, skipped };
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
    const a = await this.deskEscalation.attention();
    const buckets: Array<[string, number]> = [
      ['unassigned past SLA', a.unassignedOverdue.length],
      ['entry overdue', a.entryOverdue.length],
      ['rework stale', a.reworkStale.length],
      ['review overdue', a.reviewOverdue.length],
      ['submission to client overdue', a.submitOverdue.length],
      ['OCR stuck', a.ocrStuck.length],
      ['clarifications overdue', a.clarificationsOverdue.length],
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
      heading: `Feedback: ${first + resolution} past SLA`,
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
           FROM assayer_payables WHERE status = 'PENDING' AND is_active = true`, 'pending payables'),
      q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS total
           FROM assignment_expenses WHERE status = 'PENDING' AND is_active = true`, 'pending expense claims'),
      q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(outstanding_amount),0)::numeric AS total
           FROM billing_invoices
          WHERE due_date < CURRENT_DATE AND COALESCE(outstanding_amount, 0) > 0 AND is_active = true`, 'overdue invoices'),
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
        `${expiring.length} assayer document(s) fall due this month`,
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
      for (const role of SECTION_AUDIENCES[key] ?? []) {
        roleToSections.set(role, [...(roleToSections.get(role) ?? []), key]);
      }
    }
    const roles = [...roleToSections.keys()];
    if (!roles.length) return [];

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

    const byUser = new Map<string, { email: string; sectionKeys: Set<string> }>();
    for (const row of rows) {
      const entry = byUser.get(row.id) ?? { email: row.email, sectionKeys: new Set<string>() };
      for (const key of roleToSections.get(row.role_name) ?? []) entry.sectionKeys.add(key);
      byUser.set(row.id, entry);
    }
    return [...byUser.values()];
  }
}
