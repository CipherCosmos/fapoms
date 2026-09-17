import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { InterviewOutcome } from '@fapoms/shared';

import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { queryKeys } from '../../../hooks/queryKeys';
import { Modal, AlertBanner } from '../../../components/ui';
import { Field, fieldInput, InviteLinkBox } from '../hr-ui';

type Route = 'interview' | 'direct';

interface Sent {
  tone: 'ok' | 'err';
  text: string;
  link?: string | null;
}

/**
 * The one way into the hiring pipeline, with both routes the owner asked for.
 *
 * Recording an interview is the ordinary route: a pass opens the candidate's application and emails
 * them their form. The second route exists because the first one used to be mandatory, and a
 * mandatory step that blocks real work — a walk-in, a referral, somebody the branch already knows —
 * gets bypassed by recording a fake "pass", which is how a screening log stops meaning anything.
 * So the shortcut is allowed and recorded instead of forbidden and faked: it asks who decided and
 * why, stamps that on the candidate, and writes it to the audit trail.
 */
export const AddCandidateDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}> = ({ open, onClose, onAdded }) => {
  const queryClient = useQueryClient();
  const [route, setRoute] = useState<Route>('interview');
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState<InterviewOutcome | ''>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);

  const reset = () => {
    setName(''); setMobile(''); setEmail(''); setNotes(''); setOutcome(''); setReason('');
    setSent(null); setBusy(false);
  };

  const close = () => { reset(); onClose(); };

  const canSubmit = route === 'interview'
    ? name.trim().length > 1 && mobile.trim().length > 0 && !!outcome
    : name.trim().length > 1 && mobile.trim().length > 0 && reason.trim().length >= 10;

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setSent(null);
    try {
      if (route === 'interview') {
        const res = await api.request<{
          candidateName: string; outcome: InterviewOutcome; email: string | null;
          inviteEmailed?: boolean; inviteLink?: string;
        }>('/assayer-interviews', {
          method: 'POST',
          body: JSON.stringify({
            candidateName: name.trim(),
            mobile: mobile.trim(),
            email: email.trim() || undefined,
            notes: notes.trim() || undefined,
            outcome,
          }),
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.hr.interviews });
        if (res.outcome === InterviewOutcome.FAIL) {
          setSent({ tone: 'ok', text: `${res.candidateName}'s interview is recorded as not passed. Nothing was sent to them.` });
        } else if (res.inviteEmailed) {
          setSent({ tone: 'ok', text: `${res.candidateName} passed — their form has been emailed to ${res.email}.`, link: res.inviteLink ?? null });
        } else {
          // An undelivered invite is a stall, not a success: somebody has to send the link by hand.
          setSent({
            tone: 'err',
            text: res.email
              ? `${res.candidateName} passed, but the email to ${res.email} did not go out. Send them the link below.`
              : `${res.candidateName} passed. There is no email on file, so send them the link below.`,
            link: res.inviteLink ?? null,
          });
        }
      } else {
        const res = await api.request<{ applicationId: string; emailed: boolean; inviteLink: string }>(
          '/hr/applications/invite',
          {
            method: 'POST',
            body: JSON.stringify({
              fullName: name.trim(),
              mobile: mobile.trim(),
              email: email.trim() || undefined,
              reason: reason.trim(),
            }),
          },
        );
        setSent({
          tone: res.emailed ? 'ok' : 'err',
          text: res.emailed
            ? `${name.trim()} has been added and their form emailed to ${email.trim()}.`
            : `${name.trim()} has been added, but no email went out. Send them the link below.`,
          link: res.inviteLink,
        });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.hr.applicationsAll });
      onAdded();
    } catch (e) {
      setSent({ tone: 'err', text: userMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add a candidate"
      width="560px"
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button type="button" className="btn btn-secondary" onClick={close} style={{ fontSize: 'var(--text-xs)', padding: '7px 14px' }}>
            {sent && sent.tone === 'ok' ? 'Done' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit || busy}
            onClick={() => void submit()}
            style={{ fontSize: 'var(--text-xs)', padding: '7px 14px' }}
          >
            {busy ? 'Saving…' : route === 'interview' ? 'Record interview' : 'Add and send their form'}
          </button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div role="tablist" style={{ display: 'flex', gap: '6px' }}>
          {([
            { key: 'interview' as const, label: 'Record an interview' },
            { key: 'direct' as const, label: 'Add without an interview' },
          ]).map((r) => (
            <button
              key={r.key}
              type="button"
              role="tab"
              aria-selected={route === r.key}
              onClick={() => { setRoute(r.key); setSent(null); }}
              style={{
                padding: '6px 12px', fontSize: 'var(--text-xs)', fontWeight: 600, cursor: 'pointer',
                borderRadius: '7px',
                border: `1px solid ${route === r.key ? 'var(--accent)' : 'var(--border-color)'}`,
                background: route === r.key ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                color: route === r.key ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        {sent && (
          <AlertBanner type={sent.tone === 'ok' ? 'success' : 'error'} message={sent.text} />
        )}
        {sent?.link && <InviteLinkBox link={sent.link} note="Send this to them if the email did not arrive." />}

        {!sent?.link && (
          <>
            <Field title="Their name" wide>
              <input style={fieldInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="As printed on their Aadhaar or PAN" />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <Field title="Mobile">
                <input style={fieldInput} value={mobile} onChange={(e) => setMobile(e.target.value)} inputMode="numeric" placeholder="10 digits" />
              </Field>
              <Field title="Email">
                <input style={fieldInput} value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" placeholder="Where their form is sent" />
              </Field>
            </div>

            {route === 'interview' ? (
              <>
                <Field title="How did the interview go?" wide>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {([InterviewOutcome.PASS, InterviewOutcome.FAIL]).map((o) => (
                      <button
                        key={o}
                        type="button"
                        aria-pressed={outcome === o}
                        onClick={() => setOutcome(o)}
                        style={{
                          padding: '7px 14px', fontSize: 'var(--text-xs)', fontWeight: 600, cursor: 'pointer',
                          borderRadius: '7px',
                          border: `1px solid ${outcome === o ? (o === InterviewOutcome.PASS ? 'var(--success)' : 'var(--danger)') : 'var(--border-color)'}`,
                          background: outcome === o
                            ? (o === InterviewOutcome.PASS ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)')
                            : 'transparent',
                          color: outcome === o ? (o === InterviewOutcome.PASS ? 'var(--success)' : 'var(--danger)') : 'var(--text-secondary)',
                        }}
                      >
                        {o === InterviewOutcome.PASS ? 'Passed' : 'Did not pass'}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field title="Notes (optional)" wide>
                  <textarea
                    style={{ ...fieldInput, minHeight: '64px', resize: 'vertical' }}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="What was discussed, and anything the next person should know"
                  />
                </Field>
                <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                  A pass emails them their registration form straight away. A fail records the decision and sends nothing.
                </p>
              </>
            ) : (
              <>
                <Field title="Why is this person being added without an interview?" wide>
                  <textarea
                    style={{ ...fieldInput, minHeight: '64px', resize: 'vertical' }}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Walk-in at the Kochi branch, known to the branch manager, interview booked for Friday"
                  />
                </Field>
                <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                  {reason.trim().length > 0 && reason.trim().length < 10
                    ? 'Say a little more — this is what somebody reviewing the file later will read.'
                    : 'This is kept on their record and in the audit trail, with your name, and shows on their row as “Added without an interview”.'}
                </p>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
