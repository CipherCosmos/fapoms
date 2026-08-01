import { ProjectStateMachine, ProjectBranchStateMachine } from './project.state-machine';
import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { ProjectStatus, ProjectBranchStatus } from '@fapoms/shared';
import { BadRequestException } from '@nestjs/common';

describe('ProjectStateMachine', () => {
  let project: ProjectEntity;

  beforeEach(() => {
    project = {
      id: 'proj-1',
      status: ProjectStatus.DRAFT,
      isActive: true,
    } as ProjectEntity;
  });

  it('should transition from DRAFT to PLANNING', () => {
    const event = ProjectStateMachine.startPlanning(project, 'user-1');
    expect(project.status).toBe(ProjectStatus.PLANNING);
    expect(event.previousState).toBe(ProjectStatus.DRAFT);
    expect(event.newState).toBe(ProjectStatus.PLANNING);
  });

  it('should throw BadRequestException on invalid transition', () => {
    expect(() => {
      ProjectStateMachine.startExecution(project, 'user-1');
    }).toThrow(BadRequestException);
  });

  it('should throw BadRequestException on inactive project', () => {
    project.isActive = false;
    expect(() => {
      ProjectStateMachine.startPlanning(project, 'user-1');
    }).toThrow(BadRequestException);
  });

  it('should put a SCHEDULING project on hold, and an EXECUTION project on hold', () => {
    project.status = ProjectStatus.SCHEDULING;
    const event = ProjectStateMachine.holdProject(project, 'user-1');
    expect(project.status).toBe(ProjectStatus.ON_HOLD);
    expect(event.previousState).toBe(ProjectStatus.SCHEDULING);

    project.status = ProjectStatus.EXECUTION;
    ProjectStateMachine.holdProject(project, 'user-1');
    expect(project.status).toBe(ProjectStatus.ON_HOLD);
  });

  it('should refuse to hold a project outside SCHEDULING/EXECUTION', () => {
    project.status = ProjectStatus.PLANNING;
    expect(() => {
      ProjectStateMachine.holdProject(project, 'user-1');
    }).toThrow(BadRequestException);
  });

  it('should resume an ON_HOLD project into either SCHEDULING or EXECUTION', () => {
    project.status = ProjectStatus.ON_HOLD;
    ProjectStateMachine.readyForScheduling(project, 'user-1');
    expect(project.status).toBe(ProjectStatus.SCHEDULING);

    project.status = ProjectStatus.ON_HOLD;
    ProjectStateMachine.startExecution(project, 'user-1');
    expect(project.status).toBe(ProjectStatus.EXECUTION);
  });

  it('should archive a COMPLETED project but refuse any other status', () => {
    project.status = ProjectStatus.COMPLETED;
    const event = ProjectStateMachine.archiveProject(project, 'user-1');
    expect(project.status).toBe(ProjectStatus.ARCHIVED);
    expect(event.previousState).toBe(ProjectStatus.COMPLETED);

    project.status = ProjectStatus.EXECUTION;
    expect(() => {
      ProjectStateMachine.archiveProject(project, 'user-1');
    }).toThrow(BadRequestException);
  });
});

describe('ProjectBranchStateMachine', () => {
  let pb: ProjectBranchEntity;

  beforeEach(() => {
    pb = {
      id: 'pb-1',
      status: ProjectBranchStatus.IMPORTED,
      isActive: true,
    } as ProjectBranchEntity;
  });

  it('should transition from IMPORTED to PLANNING', () => {
    const event = ProjectBranchStateMachine.initiatePlanning(pb, 'user-1');
    expect(pb.status).toBe(ProjectBranchStatus.PLANNING);
    expect(event.previousState).toBe(ProjectBranchStatus.IMPORTED);
    expect(event.newState).toBe(ProjectBranchStatus.PLANNING);
  });
});
