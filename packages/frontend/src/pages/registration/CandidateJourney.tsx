import React from 'react';
import { Check, FileWarning } from 'lucide-react';
import {
  CANDIDATE_JOURNEY_NEXT_WORDS, CANDIDATE_JOURNEY_STEP_WORDS, CANDIDATE_JOURNEY_WORDS,
  type CandidateAsk, type CandidateJourneyView,
} from '@fapoms/shared';

/**
 * The road ahead on a finished application's page — the steps, where they are, and one sentence.
 *
 * What the steps are, what they are called and what each sentence says all come from
 * `candidate-journey.ts` in shared, which the phone app's status screen reads too; this file only
 * draws them. Kept short on purpose (owner, 2026-09-24: "keep things simple"): a list of seven
 * words, one of them highlighted, and one line under it.
 */
export const CandidateJourneySteps: React.FC<{ view: CandidateJourneyView }> = ({ view }) => (
  <div style={{ width: '100%', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <ol aria-label={CANDIDATE_JOURNEY_WORDS.stepsLabel} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {view.steps.map(({ step, state }) => (
        <li
          key={step}
          aria-current={state === 'current' ? 'step' : undefined}
          style={{
            display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 10px', borderRadius: '8px',
            background: state === 'current' ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
          }}
        >
          <span
            aria-hidden
            style={{
              flex: '0 0 auto', width: '20px', height: '20px', borderRadius: '50%', boxSizing: 'border-box',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: state === 'done' ? 'color-mix(in srgb, var(--success) 18%, transparent)'
                : state === 'current' ? 'var(--accent)' : 'transparent',
              border: state === 'ahead' ? '1.5px solid var(--border-color)' : 'none',
            }}
          >
            {state === 'done' && <Check size={12} strokeWidth={3} style={{ color: 'var(--success)' }} />}
            {state === 'current' && <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#fff' }} />}
          </span>
          <span
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: state === 'current' ? 700 : 500,
              color: state === 'ahead' ? 'var(--text-muted)' : state === 'current' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            {CANDIDATE_JOURNEY_STEP_WORDS[step]}
          </span>
        </li>
      ))}
    </ol>
    {view.next && (
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
        {CANDIDATE_JOURNEY_NEXT_WORDS[view.next]}
      </p>
    )}
  </div>
);

/**
 * What HR has asked an approved candidate to send again — first on the page, in HR's own words.
 *
 * The link cannot take the file: after approval the record changes only behind the person's own
 * sign-in, so this says where to answer it (the appraiser app's "Your papers"), or that HR can.
 */
export const CandidateAsks: React.FC<{ asks: CandidateAsk[] }> = ({ asks }) => (
  <section
    aria-label={CANDIDATE_JOURNEY_WORDS.resendHeading}
    style={{
      width: '100%', boxSizing: 'border-box', textAlign: 'left', padding: '14px 16px', borderRadius: '10px',
      background: 'color-mix(in srgb, var(--warning) 12%, transparent)', border: '1px solid var(--warning)',
      display: 'flex', flexDirection: 'column', gap: '8px',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>
      <FileWarning size={16} style={{ color: 'var(--warning)', flex: '0 0 auto' }} />
      {CANDIDATE_JOURNEY_WORDS.resendHeading}
    </div>
    <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {asks.map((ask) => (
        <li key={ask.requirement} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)', lineHeight: 1.5 }}>
          <strong>{ask.label}</strong> — {ask.note ?? CANDIDATE_JOURNEY_WORDS.resendFallback}
        </li>
      ))}
    </ul>
    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
      {CANDIDATE_JOURNEY_WORDS.resendHowOnWeb}
    </div>
  </section>
);
