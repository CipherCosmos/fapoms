import React from 'react';
import { InterviewOutcome, sourceReferralLine } from '@fapoms/shared';
import { DetailDrawer } from '../../../components/ui';
import { fmtWhen } from '../hr-ui';
import { followUpOf, type InterviewLike } from './pipeline';
import { InterviewFiles } from './InterviewFiles';

/**
 * AN INTERVIEW THAT DID NOT PASS, AND WHY.
 *
 * The hiring pipeline lists failed interviews so that somebody about to talk to the same person
 * again can see it happened. Clicking the row did nothing: the page set `?id=interview:<id>` and no
 * drawer existed for it, so the only row kind that carried a story was the only one that could not
 * be opened. What the interviewer wrote was stored every time and shown on no screen at all.
 *
 * The verdict is read-only on purpose. A second interview is a new interview — "Interview again"
 * records one that names this one — not an edit to the verdict somebody else gave. The test papers
 * are kept here, and may be added to (never removed).
 */
const OUTCOME_WORDS: Record<string, string> = {
  [InterviewOutcome.PASS]: 'Passed',
  [InterviewOutcome.FAIL]: 'Did not pass',
};

const Line: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{children}</span>
  </div>
);

export const InterviewDetailDrawer: React.FC<{
  interview: InterviewLike;
  /** Every interview, to find the one before and the one after this. */
  all?: InterviewLike[];
  onClose: () => void;
  /** Re-read the interview log — after a paper is added. */
  onChanged?: () => void;
  /** Opens "Interview again" for this candidate. Given to people who may record interviews. */
  onInterviewAgain?: (interview: InterviewLike) => void;
  /** Opens another interview in this drawer. */
  onOpenInterview?: (id: string) => void;
}> = ({ interview, all = [], onClose, onChanged, onInterviewAgain, onOpenInterview }) => {
  const earlier = interview.previousInterviewId ? all.find((i) => i.id === interview.previousInterviewId) ?? null : null;
  const later = followUpOf(interview, all);
  const mayRetake = interview.outcome === InterviewOutcome.FAIL && !later && onInterviewAgain;
  const link = (other: InterviewLike, words: string) => (
    onOpenInterview
      ? (
        <button
          type="button"
          onClick={() => onOpenInterview(other.id)}
          style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 'var(--text-sm)', textAlign: 'left' }}
        >
          {words}
        </button>
      )
      : <span>{words}</span>
  );
  return (
    <DetailDrawer
      open
      onClose={onClose}
      width={480}
      title={interview.candidateName}
      subtitle={OUTCOME_WORDS[interview.outcome] ?? interview.outcome}
    >
      <Line label="Interviewed">
        {fmtWhen(interview.interviewedAt)}
        {interview.interviewedByName ? ` by ${interview.interviewedByName}` : ''}
      </Line>
      <Line label="Mobile">{interview.mobile}</Line>
      {interview.email && <Line label="Email">{interview.email}</Line>}
      <Line label="Referred by">
        {interview.sourceReferral
          ? sourceReferralLine(interview.sourceReferral)
          : <span style={{ color: 'var(--text-muted)' }}>Nobody recorded</span>}
      </Line>
      <Line label="What the interviewer wrote">
        {interview.notes?.trim()
          ? <span style={{ whiteSpace: 'pre-line' }}>{interview.notes}</span>
          : <span style={{ color: 'var(--text-muted)' }}>Nothing was written down.</span>}
      </Line>
      <Line label="Test papers">
        <InterviewFiles interviewId={interview.id} files={interview.attachments ?? []} onAdded={onChanged} />
      </Line>
      {earlier && (
        <Line label="Before this">
          {link(earlier, `Interviewed ${fmtWhen(earlier.interviewedAt)} — ${OUTCOME_WORDS[earlier.outcome] ?? earlier.outcome}`)}
        </Line>
      )}
      {later && (
        <Line label="Interviewed again">
          {link(later, `${fmtWhen(later.interviewedAt)} — ${OUTCOME_WORDS[later.outcome] ?? later.outcome}`)}
        </Line>
      )}
      {mayRetake ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start', fontSize: 'var(--text-xs)', padding: '7px 14px' }}
            onClick={() => onInterviewAgain!(interview)}>
            Interview again
          </button>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.55 }}>
            Records a new interview that follows this one. This one stays on file as it was, with its test papers.
          </span>
        </div>
      ) : !later && interview.outcome === InterviewOutcome.FAIL && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.55 }}>
          This one stays on file as it was.
        </div>
      )}
    </DetailDrawer>
  );
};

export default InterviewDetailDrawer;
