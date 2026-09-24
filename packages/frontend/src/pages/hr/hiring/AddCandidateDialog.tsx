import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { InterviewOutcome, normalizeSourceReferral, type OutboundMessageReceipt } from '@fapoms/shared';

import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { queryKeys } from '../../../hooks/queryKeys';
import { Modal, AlertBanner } from '../../../components/ui';
import { Field, fieldInput, InviteLinkBox } from '../hr-ui';
import { DeliveryNote } from '../../../components/DeliveryNote';
import { ScanOrAttach } from '../../../components/scanner/ScanOrAttach';
import { uploadInterviewFiles } from './InterviewFiles';
import {
  SourceReferralFields, EMPTY_REFERRAL, referralDraftFrom, referralPayload, type SourceReferralDraft,
} from '../../../components/SourceReferralFields';
import type { InterviewLike } from './pipeline';

type Route = 'interview' | 'direct';

interface Sent {
  tone: 'ok' | 'err';
  text: string;
  link?: string | null;
  /**
   * When the outcome involved emailing the form. The email is queued, so whether it went is not
   * known when the response arrives — the note follows it from "Sending…" to its answer.
   */
  delivery?: { receipt: OutboundMessageReceipt | null; lead: string };
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
  /**
   * Interviewing again somebody who did not pass. Their details are carried over, the route is the
   * interview, and the new interview is recorded as following this one — which stays as it was.
   */
  retakeOf?: InterviewLike | null;
}> = ({ open, onClose, onAdded, retakeOf }) => {
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
  /** The test papers, kept with the interview once it is recorded — for either outcome. */
  const [papers, setPapers] = useState<File[]>([]);
  /** Who referred them — the source reference, asked on both routes. */
  const [referral, setReferral] = useState<SourceReferralDraft>(EMPTY_REFERRAL);

  const reset = () => {
    setName(''); setMobile(''); setEmail(''); setNotes(''); setOutcome(''); setReason('');
    setPapers([]); setReferral(EMPTY_REFERRAL); setSent(null); setBusy(false); setRoute('interview');
  };

  // A retake starts from the person already on file, so nobody retypes them — or mistypes them.
  useEffect(() => {
    if (open && retakeOf) {
      setRoute('interview');
      setName(retakeOf.candidateName);
      setMobile(retakeOf.mobile);
      setEmail(retakeOf.email ?? '');
      setReferral(referralDraftFrom(retakeOf.sourceReferral));
    }
  }, [open, retakeOf]);

  const close = () => { reset(); onClose(); };

  const canSubmit = route === 'interview'
    ? name.trim().length > 1 && mobile.trim().length > 0 && !!outcome
    : name.trim().length > 1 && mobile.trim().length > 0 && reason.trim().length >= 10;

  const submit = async () => {
    if (!canSubmit || busy) return;
    // The shared rule, asked here first so a half-filled referrer is said before anything is sent.
    const referralProblem = normalizeSourceReferral(referralPayload(referral), 'HR').error;
    if (referralProblem) {
      setSent({ tone: 'err', text: referralProblem });
      return;
    }
    setBusy(true);
    setSent(null);
    try {
      if (route === 'interview') {
        const res = await api.request<{
          id: string; candidateName: string; outcome: InterviewOutcome; email: string | null;
          emailDelivery?: OutboundMessageReceipt | null; inviteLink?: string;
        }>('/assayer-interviews', {
          method: 'POST',
          body: JSON.stringify({
            candidateName: name.trim(),
            mobile: mobile.trim(),
            email: email.trim() || undefined,
            notes: notes.trim() || undefined,
            outcome,
            previousInterviewId: retakeOf?.id,
            sourceReferral: referralPayload(referral) ?? undefined,
          }),
        });
        // The interview is recorded; its papers follow. A paper that fails to upload is said, and
        // can be added from the interview afterwards — the decision itself is not undone by it.
        const kept = papers.length > 0 ? await uploadInterviewFiles(res.id, papers) : { sent: 0, error: null };
        void queryClient.invalidateQueries({ queryKey: queryKeys.hr.interviews });
        if (kept.error) {
          setSent({
            tone: 'err',
            text: `${res.candidateName}'s interview is recorded (${res.outcome === InterviewOutcome.PASS ? 'passed' : 'not passed'}), `
              + `but ${kept.error} Open the interview from the list to add it again.`,
          });
        } else if (res.outcome === InterviewOutcome.FAIL) {
          setSent({
            tone: 'ok',
            text: `${res.candidateName}'s interview is recorded as not passed`
              + `${kept.sent > 0 ? `, with ${kept.sent} test paper${kept.sent === 1 ? '' : 's'}` : ''}. Nothing was sent to them.`,
          });
        } else {
          // Whether the email went is followed on screen, not assumed: an undelivered invite is a
          // stall somebody has to clear by sending the link by hand.
          setSent({
            tone: 'ok',
            text: '',
            link: res.inviteLink ?? null,
            delivery: { receipt: res.emailDelivery ?? null, lead: `${res.candidateName} passed.` },
          });
        }
      } else {
        const res = await api.request<{ applicationId: string; emailDelivery: OutboundMessageReceipt | null; inviteLink: string }>(
          '/hr/applications/invite',
          {
            method: 'POST',
            body: JSON.stringify({
              fullName: name.trim(),
              mobile: mobile.trim(),
              email: email.trim() || undefined,
              reason: reason.trim(),
              sourceReferral: referralPayload(referral) ?? undefined,
            }),
          },
        );
        setSent({
          tone: 'ok',
          text: '',
          link: res.inviteLink,
          delivery: { receipt: res.emailDelivery ?? null, lead: `${name.trim()} has been added.` },
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
      title={retakeOf ? `Interview ${retakeOf.candidateName} again` : 'Add a candidate'}
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
        {retakeOf && (
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            Their earlier interview did not pass. It stays on file with its test papers; this one is
            recorded as following it, and a pass sends them their registration form.
          </p>
        )}
        {!retakeOf && <div role="tablist" style={{ display: 'flex', gap: '6px' }}>
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
        </div>}

        {sent?.delivery && (
          <DeliveryNote
            receipt={sent.delivery.receipt}
            lead={sent.delivery.lead}
            what="their form"
            noAddress="There is no email on file, so send them the link below."
          />
        )}
        {sent && !sent.delivery && (
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

            <Field title="Who referred them (optional)" wide>
              <SourceReferralFields value={referral} onChange={setReferral} idPrefix="add-referral" />
            </Field>

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
                <Field title="Test papers (optional)" wide>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <ScanOrAttach
                      documentLabel="Interview test paper"
                      onFiles={(picked) => setPapers((prev) => [...prev, ...picked])}
                      multiple
                      disabled={busy}
                      attachLabel="Add test paper"
                      size="sm"
                    />
                    {papers.length > 0 && (
                      <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                        {papers.map((f, i) => (
                          <li key={`${f.name}-${i}`} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            {f.name}
                            <button
                              type="button"
                              aria-label={`Leave out ${f.name}`}
                              onClick={() => setPapers((prev) => prev.filter((_, j) => j !== i))}
                              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--text-2xs)', padding: 0 }}
                            >
                              Leave out
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                      Kept with the interview whichever way it went, and cannot be removed afterwards.
                    </span>
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
