import React from 'react';
import { InterviewOutcome } from '@fapoms/shared';
import { DetailDrawer } from '../../../components/ui';
import { fmtWhen } from '../hr-ui';
import type { InterviewLike } from './pipeline';

/**
 * AN INTERVIEW THAT DID NOT PASS, AND WHY.
 *
 * The hiring pipeline lists failed interviews so that somebody about to talk to the same person
 * again can see it happened. Clicking the row did nothing: the page set `?id=interview:<id>` and no
 * drawer existed for it, so the only row kind that carried a story was the only one that could not
 * be opened. What the interviewer wrote was stored every time and shown on no screen at all.
 *
 * Read-only on purpose. A second interview is a new interview — recorded from "Add candidate" —
 * not an edit to the verdict somebody else gave.
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
  onClose: () => void;
}> = ({ interview, onClose }) => (
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
    <Line label="What the interviewer wrote">
      {interview.notes?.trim()
        ? <span style={{ whiteSpace: 'pre-line' }}>{interview.notes}</span>
        : <span style={{ color: 'var(--text-muted)' }}>Nothing was written down.</span>}
    </Line>
    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.55 }}>
      Talking to them again is a new interview — record it from “Add candidate”, and this one stays
      on file as it was.
    </div>
  </DetailDrawer>
);

export default InterviewDetailDrawer;
