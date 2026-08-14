import { ProjectStatus, PROJECT_TRANSITIONS, toWorkflowTransitions } from '@fapoms/shared';
import { ProjectStateMachine } from './project.state-machine';
import { ProjectEntity } from './project.entity';

/**
 * The project state machine and the table the workflow engine gates on must describe the same
 * graph.
 *
 * They are two encodings of one rule and neither can be derived from the other: `PROJECT_TRANSITIONS`
 * is a map, while `ProjectStateMachine` spells its rules out as per-method `if` chains
 * ("cannot cancel a completed project", "cannot cancel an archived project", …). Rewriting the
 * machine to read the map would be a large change to code that is correct today, so this pins
 * them together instead — the drift is what's dangerous, not the duplication.
 *
 * The asymmetry that makes drift expensive: `executeCommand` checks the TABLE first and throws
 * before the machine ever runs. So an edge the machine allows but the table omits is simply
 * dead — the operation fails with "Invalid transition" and no amount of reading the state
 * machine explains why. That is precisely how the shared table came to be missing five
 * `-> CANCELLED` edges without anyone noticing: nothing was reading it.
 */
describe('project transitions — machine and table agree', () => {
  const project = (status: ProjectStatus) =>
    ({ id: 'p1', status, isActive: true }) as ProjectEntity;

  /** Every transition the machine will actually perform, discovered by trying them all. */
  const machineEdges = (): Set<string> => {
    const moves: [ProjectStatus, (p: ProjectEntity) => unknown][] = [
      [ProjectStatus.PLANNING, (p) => ProjectStateMachine.startPlanning(p, 'u')],
      [ProjectStatus.SCHEDULING, (p) => ProjectStateMachine.readyForScheduling(p, 'u')],
      [ProjectStatus.EXECUTION, (p) => ProjectStateMachine.startExecution(p, 'u')],
      [ProjectStatus.VALIDATION, (p) => ProjectStateMachine.startValidation(p, 'u')],
      [ProjectStatus.COMPLETED, (p) => ProjectStateMachine.completeProject(p, 'u')],
      [ProjectStatus.CANCELLED, (p) => ProjectStateMachine.cancelProject(p, 'u')],
      [ProjectStatus.ON_HOLD, (p) => ProjectStateMachine.holdProject(p, 'u')],
      [ProjectStatus.ARCHIVED, (p) => ProjectStateMachine.archiveProject(p, 'u')],
    ];
    const found = new Set<string>();
    for (const from of Object.values(ProjectStatus)) {
      for (const [to, run] of moves) {
        try {
          run(project(from));
          found.add(`${from}->${to}`);
        } catch {
          /* refused — not an edge */
        }
      }
    }
    return found;
  };

  const tableEdges = new Set(
    Object.entries(PROJECT_TRANSITIONS).flatMap(([from, tos]) =>
      (tos ?? []).map((to) => `${from}->${to}`),
    ),
  );

  it('has no machine edge the engine would refuse', () => {
    // These are the invisible ones: the machine permits the move, the engine rejects the
    // command before the machine is reached, and the operation is unreachable in production
    // while looking perfectly implemented in the source.
    const unreachable = [...machineEdges()].filter((e) => !tableEdges.has(e));
    expect(unreachable).toEqual([]);
  });

  it('has no table edge the machine would refuse', () => {
    // The other direction is a weaker failure — the engine waves it through and the machine
    // throws — but it still means the table is describing a system that does not exist.
    const machine = machineEdges();
    const phantom = [...tableEdges].filter((e) => !machine.has(e));
    expect(phantom).toEqual([]);
  });

  it('cancels from every non-terminal state', () => {
    // The specific regression: the shared table listed only PLANNING->CANCELLED, so wiring it
    // up would have made a project in DRAFT, SCHEDULING, EXECUTION, VALIDATION or ON_HOLD
    // impossible to abandon.
    for (const from of [
      ProjectStatus.DRAFT, ProjectStatus.PLANNING, ProjectStatus.SCHEDULING,
      ProjectStatus.EXECUTION, ProjectStatus.VALIDATION, ProjectStatus.ON_HOLD,
    ]) {
      expect(PROJECT_TRANSITIONS[from]).toContain(ProjectStatus.CANCELLED);
    }
  });

  it('never cancels a project that is finished, archived or already cancelled', () => {
    for (const from of [ProjectStatus.COMPLETED, ProjectStatus.ARCHIVED, ProjectStatus.CANCELLED]) {
      expect(PROJECT_TRANSITIONS[from] ?? []).not.toContain(ProjectStatus.CANCELLED);
      expect(() => ProjectStateMachine.cancelProject(project(from), 'u')).toThrow();
    }
  });

  it('flattens to the registration the engine receives without losing an edge', () => {
    const flattened = new Set(
      toWorkflowTransitions(PROJECT_TRANSITIONS).flatMap(({ from, to }) =>
        from.map((f) => `${f}->${to}`),
      ),
    );
    expect(flattened).toEqual(tableEdges);
  });
});
