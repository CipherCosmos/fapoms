import React from 'react';
import { ViewChips, useViewParam } from './hr-ui';
import { HrUtilisationPage } from './HrUtilisationPage';
import { HrDeploymentPage } from './HrDeploymentPage';
import { HrActivityPage } from './HrActivityPage';

/**
 * Where people are — how loaded they are, where they sit against the work, and what has changed.
 *
 * WHY THIS EXISTS AS ONE PAGE (please do not split it back into three):
 *
 * Utilisation, Deployment and Activity were three tabs answering one question an HR manager
 * actually asks in one breath: "where is everybody, and are they busy?" None of the three
 * carried a badge, so none of them was ever a *destination* — they were three places you had to
 * visit in turn to assemble a single picture, which is exactly the kind of navigation cost that
 * eleven tabs imposed on non-technical staff.
 *
 * They are now one destination with plain-language chips:
 *
 *   Workload         — who is over capacity, who is idle, who never got deployed, and attrition
 *   Coverage by area — branches vs assayers per state, and where hiring is needed
 *   Recent changes   — the audit trail: every change to a person's record, and who made it
 *
 * As with Paperwork, the chip bodies are the previous page components mounted unchanged, so
 * every query and callback inside them is the one that was already reviewed. Old
 * `/hr/utilisation`, `/hr/deployment` and `/hr/activity` URLs redirect here with the matching
 * `?view=` selected — see LEGACY_PATHS in HrLayout.
 */

const VIEWS = [
  { key: 'workload', label: 'Workload', hint: 'Who is over capacity, who is idle, and who has left' },
  { key: 'coverage', label: 'Coverage by area', hint: 'Assayers against branches, state by state' },
  { key: 'changes', label: 'Recent changes', hint: 'Every change to a person’s record, and who made it' },
] as const;

type ViewKey = (typeof VIEWS)[number]['key'];

const KEYS = VIEWS.map((v) => v.key) as ReadonlyArray<ViewKey>;

export const HrWherePeopleArePage: React.FC = () => {
  const [view, setView] = useViewParam<ViewKey>(KEYS, 'workload');

  return (
    <div>
      <ViewChips value={view} onChange={setView} options={VIEWS} />

      {view === 'workload' && <HrUtilisationPage />}
      {view === 'coverage' && <HrDeploymentPage />}
      {view === 'changes' && <HrActivityPage />}
    </div>
  );
};
