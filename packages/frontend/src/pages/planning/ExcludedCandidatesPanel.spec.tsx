import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExcludedCandidatesPanel, type ExcludedCandidate } from './ExcludedCandidatesPanel';

/**
 * The override-reason box used to open empty for every exclusion. It now pre-fills a suggestion
 * keyed off the engine's own `kind` (DISTANCE/ROTATION/SKILLS/POLICY) — see `OVERRIDE_SUGGESTIONS`
 * in the component. These pin two things: the suggestion actually matches the excluded candidate's
 * real category (not a fixed string regardless of `kind`), and the box stays a fully free,
 * editable/clearable field — never locked to what was suggested.
 */

const candidate = (over: Partial<ExcludedCandidate>): ExcludedCandidate => ({
  assayerId: 'a-1',
  displayName: 'Ravi Kumar',
  reason: 'Outside the 150 km candidate search area for this branch',
  kind: 'DISTANCE',
  ...over,
});

describe('ExcludedCandidatesPanel — override reason suggestion', () => {
  it('suggests a distance-specific phrase for a DISTANCE exclusion', () => {
    render(
      <ExcludedCandidatesPanel excluded={[candidate({ kind: 'DISTANCE' })]} onAssignAnyway={jest.fn()} defaultOpen />,
    );
    fireEvent.click(screen.getByText('Assign anyway'));
    const box = screen.getByPlaceholderText('Reason for overriding this filter (recorded)') as HTMLInputElement;
    expect(box.value).toBe('Distance exception approved by ops');
  });

  it('suggests a different phrase for a SKILLS exclusion — the mapping is real, not a constant string', () => {
    render(
      <ExcludedCandidatesPanel excluded={[candidate({ kind: 'SKILLS', reason: 'Missing a skill or certification this project requires' })]} onAssignAnyway={jest.fn()} defaultOpen />,
    );
    fireEvent.click(screen.getByText('Assign anyway'));
    const box = screen.getByPlaceholderText('Reason for overriding this filter (recorded)') as HTMLInputElement;
    expect(box.value).toBe('Skill or certification requirement waived by ops');
  });

  /** Mutation guard: the suggestion is a starting value, not a locked-in one — it must be editable and clearable. */
  it('lets the operator clear the suggestion and type their own justification', async () => {
    const onAssignAnyway = jest.fn().mockResolvedValue(undefined);
    render(
      <ExcludedCandidatesPanel excluded={[candidate({ kind: 'POLICY', reason: 'Not eligible for this client' })]} onAssignAnyway={onAssignAnyway} defaultOpen />,
    );
    fireEvent.click(screen.getByText('Assign anyway'));
    const box = screen.getByPlaceholderText('Reason for overriding this filter (recorded)') as HTMLInputElement;
    // Starts pre-filled with the suggestion...
    expect(box.value).toBe('Client specifically requested this assayer');
    // ...but is fully free text: clear it and type something the suggestion list never offered.
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.change(box, { target: { value: 'Branch manager personally vouched for this assayer' } });
    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => expect(onAssignAnyway).toHaveBeenCalled());
    expect(onAssignAnyway).toHaveBeenCalledWith(
      expect.objectContaining({ assayerId: 'a-1' }),
      'Branch manager personally vouched for this assayer',
      undefined,
    );
  });

  it('falls back to the generic suggestion when a candidate carries no kind at all', () => {
    render(
      <ExcludedCandidatesPanel excluded={[candidate({ kind: undefined, reason: 'Blocked by a business rule' })]} onAssignAnyway={jest.fn()} defaultOpen />,
    );
    fireEvent.click(screen.getByText('Assign anyway'));
    const box = screen.getByPlaceholderText('Reason for overriding this filter (recorded)') as HTMLInputElement;
    expect(box.value).toBe('Client specifically requested this assayer');
  });
});
