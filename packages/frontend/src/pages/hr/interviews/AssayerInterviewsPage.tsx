import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InterviewOutcome } from '@fapoms/shared';

import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { queryKeys } from '../../../hooks/queryKeys';
import { loadFailed } from '../../../queryClient';
import { LoadFailure } from '../../../components/LoadFailure';
import { AlertBanner, DataTable, StatusBadge, EmptyState } from '../../../components/ui';
import type { Column } from '../../../components/ui';
import { getSemanticTokens } from '../../../config/status-registry';
import { Section, Field, fieldInput, fmtWhen, InviteLinkBox } from '../hr-ui';
import { Page } from '../../../components/ui/Page';

/**
 * The Appraiser Recruitment spec's Module 1 — HR's own gate before a candidate can self-register.
 *
 * `POST /assayer-interviews` does the rest on a PASS (spawns the application, emails the invite
 * link) — nothing else is needed from this screen once the form is submitted. See
 * `assayer-interview.controller.ts` / `assayer-interview.service.ts` on the backend.
 */
export interface AssayerInterviewRow {
  id: string;
  candidateName: string;
  mobile: string;
  email: string | null;
  notes: string | null;
  outcome: InterviewOutcome;
  interviewedByName: string | null;
  interviewedAt: string;
  spawnedApplicationId: string | null;
  /**
   * Only on the response to recording an interview, and only meaningful on a PASS: whether the
   * invite email actually went out. Absent when the log is listed back, which is why the banner
   * below is the only thing that reads it.
   */
  inviteEmailed?: boolean;
  /**
   * Also only on the response to recording a PASS: the candidate's registration link, handed back
   * so the desk can deliver it itself. Never present when the log is listed back — the token is
   * stored only as a hash, and this is the one moment it exists in the clear.
   */
  inviteLink?: string;
}

interface InterviewFormState {
  candidateName: string;
  mobile: string;
  email: string;
  notes: string;
  outcome: InterviewOutcome | '';
}

const EMPTY_FORM: InterviewFormState = { candidateName: '', mobile: '', email: '', notes: '', outcome: '' };

export const AssayerInterviewsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<InterviewFormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  /** Cleared with the notice: both describe the same submission. */
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const interviewsQuery = useQuery({
    queryKey: queryKeys.hr.interviews,
    queryFn: () => api.request<AssayerInterviewRow[]>('/assayer-interviews'),
  });
  const interviews = interviewsQuery.data ?? [];

  const passTokens = getSemanticTokens('positive');
  const failTokens = getSemanticTokens('danger');

  const canSubmit = form.candidateName.trim().length > 0 && form.mobile.trim().length > 0 && !!form.outcome;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const interview = await api.request<AssayerInterviewRow>('/assayer-interviews', {
        method: 'POST',
        body: JSON.stringify({
          candidateName: form.candidateName.trim(),
          mobile: form.mobile.trim(),
          email: form.email.trim() || undefined,
          notes: form.notes.trim() || undefined,
          outcome: form.outcome,
        }),
      });
      /**
       * `inviteEmailed` comes from the send itself, not from an address being present. A
       * deployment with email switched off used to produce the cheerful "has been emailed to …"
       * line below while nothing left the building, and the candidate then never appeared.
       */
      const passedAndEmailed = interview.outcome === InterviewOutcome.PASS && interview.inviteEmailed;
      setInviteLink(interview.outcome === InterviewOutcome.PASS ? interview.inviteLink ?? null : null);
      setNotice({
        // An undelivered invite is a stall, not a success — it needs somebody to act, so it reads
        // as an error rather than a cheerful confirmation nobody looks twice at.
        tone: interview.outcome === InterviewOutcome.PASS && !interview.inviteEmailed ? 'err' : 'ok',
        text: interview.outcome === InterviewOutcome.PASS
          ? (passedAndEmailed
            ? `${interview.candidateName} passed — a self-registration invite has been emailed to ${interview.email}.`
            : interview.email
              ? `${interview.candidateName} passed and an application was created, but the invite email to ${interview.email} did not go out. Send them the link below, and check email delivery in Platform Settings.`
              : `${interview.candidateName} passed and an application was created. There is no email on file, so send them the link below.`)
          : `${interview.candidateName}'s interview was recorded as a fail. No invite was sent.`,
      });
      setForm(EMPTY_FORM);
      void queryClient.invalidateQueries({ queryKey: queryKeys.hr.interviews });
    } catch (err) {
      setNotice({ tone: 'err', text: userMessage(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const columns: Column<AssayerInterviewRow>[] = [
    {
      key: 'candidate',
      header: 'Candidate',
      render: (r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.candidateName}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {r.mobile}{r.email ? ` · ${r.email}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'outcome',
      header: 'Outcome',
      render: (r) => <StatusBadge domain="interviewOutcome" status={r.outcome} />,
    },
    {
      key: 'notes',
      header: 'Notes',
      wrap: true,
      render: (r) => (
        <span style={{ color: r.notes ? 'var(--text-primary)' : 'var(--text-muted)' }}>
          {r.notes || '—'}
        </span>
      ),
    },
    {
      key: 'invite',
      header: 'Application',
      render: (r) => (
        r.spawnedApplicationId
          ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--status-active-fg, var(--success))' }}>Invite sent</span>
          : <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>—</span>
      ),
    },
    {
      key: 'when',
      header: 'Interviewed',
      render: (r) => (
        <div>
          <div>{fmtWhen(r.interviewedAt)}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{r.interviewedByName || '—'}</div>
        </div>
      ),
    },
  ];

  return (
    /* A tab inside the Workforce section, under that section's header — see the Applications page
       for the same note. The subtitle now lives on the tab's hover hint. */
    <Page>

      {notice && (
        <AlertBanner type={notice.tone === 'ok' ? 'success' : 'error'} onClose={() => { setNotice(null); setInviteLink(null); }}>
          {notice.text}
          {inviteLink && <InviteLinkBox link={inviteLink} />}
        </AlertBanner>
      )}

      <Section title="Record an interview">
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
            <Field title="Candidate name">
              <input
                style={fieldInput}
                value={form.candidateName}
                onChange={(e) => setForm((f) => ({ ...f, candidateName: e.target.value }))}
                placeholder="Full name"
                required
              />
            </Field>
            <Field title="Mobile">
              <input
                style={fieldInput}
                value={form.mobile}
                onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))}
                placeholder="10-digit mobile number"
                required
              />
            </Field>
            <Field title="Email" hint="Needed to deliver the invite link on a pass.">
              <input
                type="email"
                style={fieldInput}
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="candidate@example.com"
              />
            </Field>
            <Field title="Outcome">
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, outcome: InterviewOutcome.PASS }))}
                  aria-pressed={form.outcome === InterviewOutcome.PASS}
                  style={{
                    flex: 1,
                    padding: '7px 14px',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 600,
                    borderRadius: '7px',
                    cursor: 'pointer',
                    border: `1px solid ${form.outcome === InterviewOutcome.PASS ? passTokens.fgToken : 'var(--border-color)'}`,
                    background: form.outcome === InterviewOutcome.PASS ? passTokens.bgToken : 'var(--bg-surface)',
                    color: form.outcome === InterviewOutcome.PASS ? passTokens.fgToken : 'var(--text-secondary)',
                  }}
                >
                  Pass
                </button>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, outcome: InterviewOutcome.FAIL }))}
                  aria-pressed={form.outcome === InterviewOutcome.FAIL}
                  style={{
                    flex: 1,
                    padding: '7px 14px',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 600,
                    borderRadius: '7px',
                    cursor: 'pointer',
                    border: `1px solid ${form.outcome === InterviewOutcome.FAIL ? failTokens.fgToken : 'var(--border-color)'}`,
                    background: form.outcome === InterviewOutcome.FAIL ? failTokens.bgToken : 'var(--bg-surface)',
                    color: form.outcome === InterviewOutcome.FAIL ? failTokens.fgToken : 'var(--text-secondary)',
                  }}
                >
                  Fail
                </button>
              </div>
            </Field>
          </div>
          <Field title="Notes" wide>
            <textarea
              style={{ ...fieldInput, resize: 'vertical' }}
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="What came up in the interview, for the record."
            />
          </Field>
          <div>
            <button type="submit" className="btn btn-primary" disabled={!canSubmit || submitting} style={{ fontSize: 'var(--text-sm)', padding: '9px 18px' }}>
              {submitting ? 'Recording…' : 'Record interview'}
            </button>
          </div>
        </form>
      </Section>

      <Section title="Interview log" count={interviews.length}>
        {loadFailed(interviewsQuery) ? (
          <LoadFailure loads={[{ label: 'the interview log', query: interviewsQuery }]} />
        ) : (
          <DataTable
            columns={columns}
            rows={interviews}
            rowKey={(r) => r.id}
            loading={interviewsQuery.isLoading}
            loadingRows={4}
            density="compact"
            emptyState={<EmptyState meaning="NO_DATA" title="No interviews recorded yet" message="Interviews recorded here appear in this log." compact />}
          />
        )}
      </Section>
    </Page>
  );
};

export default AssayerInterviewsPage;
