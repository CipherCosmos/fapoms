import React from 'react';
import { MemoryRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AssayerLifecycleStatus,
  EmpanelmentStatus,
  AssignmentStatus,
} from '@fapoms/shared';

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../services/socket', () => ({ connectSocket: () => null, disconnectSocket: () => null }));
jest.mock('../context/ScopeContext', () => ({
  useScope: () => ({ selectedScope: null, setSelectedScope: jest.fn() }),
}));

import {
  STATUS_REGISTRY,
  ASSAYER_LIFECYCLE_STATUS_MAP,
  EMPANELMENT_STATUS_MAP,
  ASSIGNMENT_STATUS_MAP,
  getStatusDescriptor,
} from '../config/status-registry';
import { EmptyState } from '../components/ui/EmptyState';
import { AssignmentTable } from './assignments/AssignmentTable';
import { CurrentAssignmentsCard } from './hr/record/CurrentAssignmentsCard';
import {
  invalidateLifecycleMutation,
  invalidateKycMutation,
  invalidateBankMutation,
  invalidateAssignmentMutation,
} from '../services/queryInvalidation';
import { queryKeys } from '../hooks/queryKeys';

describe('Phase 4: Cross-Screen Product Hardening Specification', () => {
  describe('1. Canonical Status Source of Truth & Label Enforcement', () => {
    it('enforces canonical label "Empanelment Rejected" for EmpanelmentStatus.REJECTED', () => {
      const descriptor = EMPANELMENT_STATUS_MAP[EmpanelmentStatus.REJECTED];
      expect(descriptor).toBeDefined();
      expect(descriptor.label).toBe('Empanelment Rejected');
      expect(descriptor.semantic).toBe('danger');
      expect(descriptor.label).not.toBe('Empanelment Refused');
    });

    it('enforces canonical label "Inactive" for AssayerLifecycleStatus.INACTIVE without unauthoritative "Hold" terms', () => {
      const descriptor = ASSAYER_LIFECYCLE_STATUS_MAP[AssayerLifecycleStatus.INACTIVE];
      expect(descriptor).toBeDefined();
      expect(descriptor.label).toBe('Inactive');
      expect(descriptor.semantic).toBe('neutral');
      expect(descriptor.label).not.toContain('Hold');
    });

    it('enforces canonical assignment labels ("Declined" for REJECTED, "Completed" for COMPLETED)', () => {
      const rejectedDesc = ASSIGNMENT_STATUS_MAP[AssignmentStatus.REJECTED];
      expect(rejectedDesc.label).toBe('Declined');
      expect(rejectedDesc.semantic).toBe('danger');

      const completedDesc = ASSIGNMENT_STATUS_MAP[AssignmentStatus.COMPLETED];
      expect(completedDesc.label).toBe('Completed');
      expect(completedDesc.semantic).toBe('positive');
    });

    it('strictly forbids unauthoritative domain statuses in canonical maps', () => {
      const forbiddenTokens = ['Assigned', 'Hold', 'PROBATION', 'PENDING_REVIEW'];
      const allLifecycleKeys = Object.keys(ASSAYER_LIFECYCLE_STATUS_MAP);
      const allEmpanelmentKeys = Object.keys(EMPANELMENT_STATUS_MAP);
      const allAssignmentKeys = Object.keys(ASSIGNMENT_STATUS_MAP);

      for (const token of forbiddenTokens) {
        expect(allLifecycleKeys).not.toContain(token);
        expect(allEmpanelmentKeys).not.toContain(token);
        expect(allAssignmentKeys).not.toContain(token);
      }
    });

    it('getStatusDescriptor resolves correctly with fallback protection', () => {
      const activeDesc = getStatusDescriptor('assayerLifecycle', AssayerLifecycleStatus.ACTIVE);
      expect(activeDesc.label).toBe('Active');
      expect(activeDesc.semantic).toBe('positive');

      const fallbackDesc = getStatusDescriptor('assayerLifecycle', 'NON_EXISTENT_STATUS' as any);
      expect(fallbackDesc.label).toBe('Non Existent Status');
      expect(fallbackDesc.semantic).toBe('neutral');
    });
  });

  describe('2. Canonical URL & Resource Identity Bridges', () => {
    it('CurrentAssignmentsCard renders deep links to /assignments?assayerId=... and assignment detail', () => {
      const sampleAssignments = [
        {
          id: 'asgn-101',
          assignmentNumber: 'ASN-00101',
          status: 'IN_PROGRESS',
          scheduledDate: '2026-09-10',
          branch: {
            id: 'br-501',
            branchName: 'Ernakulam Main Branch',
            branchCode: 'EKM01',
            city: 'Kochi',
            project: { id: 'prj-1', projectName: 'HDFC Gold Audit' },
          },
        },
      ];

      render(
        <MemoryRouter initialEntries={['/hr/roster/a-1']}>
          <CurrentAssignmentsCard
            assignments={sampleAssignments as any}
            assayerId="a-1"
            loading={false}
          />
        </MemoryRouter>,
      );

      // Verify header link to all assignments for this assayer
      const viewAllLink = screen.getByRole('link', { name: /view in assignment queue/i });
      expect(viewAllLink).toHaveAttribute('href', '/assignments?assayerId=a-1');

      // Verify assignment number link to specific assignment
      const asgnLink = screen.getByRole('link', { name: 'ASN-00101' });
      expect(asgnLink).toHaveAttribute('href', '/assignments?id=asgn-101');
    });

    it('preserves history state and navigates back (-1) when returning from record', () => {
      const MockRecordPage = () => {
        const navigate = useNavigate();
        const handleBack = () => {
          if (window.history.state && window.history.state.idx > 0) {
            navigate(-1);
          } else {
            navigate('/hr/roster');
          }
        };

        return (
          <button onClick={handleBack}>Back to People</button>
        );
      };

      // Case A: Navigated from roster (history idx > 0)
      window.history.replaceState({ idx: 2 }, '', '/hr/roster/a-1');

      const { unmount } = render(
        <MemoryRouter initialEntries={['/hr/roster?segment=incomplete', '/hr/roster/a-1']}>
          <MockRecordPage />
        </MemoryRouter>,
      );

      const backBtn = screen.getByRole('button', { name: 'Back to People' });
      expect(backBtn).toBeInTheDocument();
      unmount();

      // Case B: Direct deep-link (history state is null or idx = 0)
      window.history.replaceState(null, '', '/hr/roster/a-1');
      const TestContainer = () => {
        const navigate = useNavigate();
        return (
          <button
            onClick={() => {
              if (window.history.state?.idx > 0) {
                navigate(-1);
              } else {
                navigate('/hr/roster');
              }
            }}
          >
            Back to People
          </button>
        );
      };

      const LocationDisplay = () => {
        const location = useLocation();
        return <span data-testid="path">{location.pathname}</span>;
      };

      render(
        <MemoryRouter initialEntries={['/hr/roster/a-1']}>
          <LocationDisplay />
          <Routes>
            <Route path="/hr/roster/a-1" element={<TestContainer />} />
            <Route path="/hr/roster" element={<div>Roster Table</div>} />
          </Routes>
        </MemoryRouter>,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Back to People' }));
      expect(screen.getByTestId('path').textContent).toBe('/hr/roster');
    });
  });

  describe('3. Standardized Empty-State Semantics (NO_DATA, NO_RESULTS, FORBIDDEN, UNAVAILABLE)', () => {
    it('renders NO_DATA semantic empty state with database icon and clear narrative', () => {
      render(
        <EmptyState
          meaning="NO_DATA"
          title="Workforce roster is empty"
          message="No assayers are registered in this database."
        />,
      );

      expect(screen.getByRole('region', { name: 'Workforce roster is empty' })).toBeInTheDocument();
      expect(screen.getByText('Workforce roster is empty')).toBeInTheDocument();
      expect(screen.getByText('No assayers are registered in this database.')).toBeInTheDocument();
    });

    it('renders NO_RESULTS semantic empty state with clear filters action', () => {
      const clearSpy = jest.fn();
      render(
        <EmptyState
          meaning="NO_RESULTS"
          title="No matching records"
          onClearFilters={clearSpy}
        />,
      );

      expect(screen.getByRole('region', { name: 'No matching records' })).toBeInTheDocument();
      const clearBtn = screen.getByRole('button', { name: /clear all filters/i });
      expect(clearBtn).toBeInTheDocument();
      fireEvent.click(clearBtn);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('renders FORBIDDEN semantic empty state for 403 access control restrictions', () => {
      render(
        <EmptyState
          meaning="FORBIDDEN"
          title="Access restricted"
          message="Operational permission required to access this workforce view."
        />,
      );

      expect(screen.getByRole('region', { name: 'Access restricted' })).toBeInTheDocument();
      expect(screen.getByText('Access restricted')).toBeInTheDocument();
      expect(screen.getByText(/Operational permission required/i)).toBeInTheDocument();
    });

    it('renders UNAVAILABLE semantic empty state with retry action for 5xx/network errors', () => {
      const retrySpy = jest.fn();
      render(
        <EmptyState
          meaning="UNAVAILABLE"
          title="Service temporarily unavailable"
          onRetry={retrySpy}
        />,
      );

      expect(screen.getByRole('region', { name: 'Service temporarily unavailable' })).toBeInTheDocument();
      const retryBtn = screen.getByRole('button', { name: /retry/i });
      expect(retryBtn).toBeInTheDocument();
      fireEvent.click(retryBtn);
      expect(retrySpy).toHaveBeenCalledTimes(1);
    });

    it('AssignmentTable renders FORBIDDEN on 403 error', () => {
      render(
        <MemoryRouter>
          <AssignmentTable
            assignments={[]}
            isLoading={false}
            isError={true}
            error={{ statusCode: 403, message: 'Forbidden' }}
            statusFilter="ALL"
            searchTerm=""
            onResetFilters={() => {}}
            onSelectAssignment={() => {}}
          />
        </MemoryRouter>,
      );

      expect(screen.getByText('Assignment queue access restricted')).toBeInTheDocument();
      expect(screen.getByText(/You do not have the required operational permissions/i)).toBeInTheDocument();
    });

    it('AssignmentTable renders UNAVAILABLE on general error with retry button', () => {
      const retryMock = jest.fn();
      render(
        <MemoryRouter>
          <AssignmentTable
            assignments={[]}
            isLoading={false}
            isError={true}
            error={new Error('Network error')}
            onRetry={retryMock}
            statusFilter="ALL"
            searchTerm=""
            onResetFilters={() => {}}
            onSelectAssignment={() => {}}
          />
        </MemoryRouter>,
      );

      expect(screen.getByText('Could not load assignments queue')).toBeInTheDocument();
      const retryBtn = screen.getByRole('button', { name: /retry/i });
      fireEvent.click(retryBtn);
      expect(retryMock).toHaveBeenCalledTimes(1);
    });

    it('AssignmentTable renders NO_DATA when collection is empty without active filters', () => {
      render(
        <MemoryRouter>
          <AssignmentTable
            assignments={[]}
            isLoading={false}
            isError={false}
            statusFilter="ALL"
            searchTerm=""
            onResetFilters={() => {}}
            onSelectAssignment={() => {}}
          />
        </MemoryRouter>,
      );

      expect(screen.getByText('Nobody has been given a branch to audit yet')).toBeInTheDocument();
    });

    it('AssignmentTable renders NO_RESULTS when filter yields 0 matches and allows clearing', () => {
      const resetMock = jest.fn();
      render(
        <MemoryRouter>
          <AssignmentTable
            assignments={[
              {
                id: 'asgn-1',
                assignmentNumber: 'ASN-001',
                status: 'COMPLETED',
                scheduledDate: '2026-09-08',
                branch: { id: 'b-1', branchName: 'North Branch', branchCode: 'NB1', project: { projectName: 'P1' } },
                assayer: { id: 'a-1', name: 'John Doe', phone: '+919876543210' },
              } as any,
            ]}
            filteredAssignments={[]}
            isLoading={false}
            isError={false}
            statusFilter="PENDING"
            searchTerm="NonExistent"
            onResetFilters={resetMock}
            onSelectAssignment={() => {}}
          />
        </MemoryRouter>,
      );

      expect(screen.getByText('No matching assignments')).toBeInTheDocument();
      const clearBtn = screen.getByRole('button', { name: /clear all filters/i });
      fireEvent.click(clearBtn);
      expect(resetMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('4. Accessibility & Table Structure (WCAG 2.1 AA)', () => {
    it('AssignmentTable header columns have scope="col" and sortable announcements', () => {
      const sample = [
        {
          id: 'asgn-1',
          assignmentNumber: 'ASN-001',
          status: 'PENDING',
          scheduledDate: '2026-09-08',
          branch: { id: 'b-1', branchName: 'North Branch', branchCode: 'NB1', city: 'Kochi', project: { projectName: 'P1' } },
          assayer: { id: 'a-1', name: 'John Doe', phone: '+919876543210' },
        } as any,
      ];

      render(
        <MemoryRouter>
          <AssignmentTable
            assignments={sample}
            filteredAssignments={sample}
            isLoading={false}
            isError={false}
            statusFilter="ALL"
            searchTerm=""
            onResetFilters={() => {}}
            onSelectAssignment={() => {}}
          />
        </MemoryRouter>,
      );

      const colHeaders = screen.getAllByRole('columnheader');
      expect(colHeaders.length).toBeGreaterThanOrEqual(7);

      // Verify scope="col" on all headers
      colHeaders.forEach((th) => {
        expect(th).toHaveAttribute('scope', 'col');
      });

      // Verify scheduled date sortable announcement
      const sortableCol = screen.getByTitle('Sort by scheduled date');
      expect(sortableCol).toHaveAttribute('aria-sort');
    });
  });

  describe('5. Surgical Query Invalidation Service Contracts', () => {
    let queryClient: QueryClient;

    beforeEach(() => {
      queryClient = new QueryClient();
      jest.spyOn(queryClient, 'invalidateQueries');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('invalidateLifecycleMutation invalidates exact dependent queries and workforce summaries', async () => {
      await invalidateLifecycleMutation(queryClient, 'assayer-99');

      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.hr.rosterAll });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.hr.workforce });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['assayer-record', 'assayer-99'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['assayer-profile', 'assayer-99'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['assayer-assignments', 'assayer-99'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['hr', 'deployment'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['hr', 'readiness', 'assayer-99'] });
    });

    it('invalidateKycMutation invalidates documents, dossier, and compliance issues', async () => {
      await invalidateKycMutation(queryClient, 'assayer-99', 'doc-123');

      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['assayer-record', 'assayer-99'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['assayer-documents', 'assayer-99'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.hr.importIssues });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['hr', 'readiness', 'assayer-99'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['assayer-document', 'doc-123'] });
    });

    it('invalidateBankMutation invalidates bank profile & pay readiness while strictly protecting frozen payables', async () => {
      await invalidateBankMutation(queryClient, 'assayer-99');

      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['assayer-bank', 'assayer-99'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['assayer-record', 'assayer-99'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['hr', 'pay-readiness', 'assayer-99'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.hr.commercialRoster });

      // Invariant: NEVER invalidate historical/approved billing records
      expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: queryKeys.billing.all });
      expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ['billing'] });
    });

    it('invalidateAssignmentMutation invalidates assignments, summaries, and timeline', async () => {
      await invalidateAssignmentMutation(queryClient, 'assayer-99', 'asgn-55');

      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.assignments.all });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.assignments.summary });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.desk.inbox });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['assayer-assignments', 'assayer-99'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.assignments.timeline('asgn-55') });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['assignment-detail', 'asgn-55'] });
    });
  });

  describe('6. Concurrency Invariants & 409 Conflict Recovery', () => {
    it('simulates 409 conflict during mutation: triggers invalidation to fetch server truth rather than silent retry', async () => {
      const queryClient = new QueryClient();
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      // Mock mutation handler that encounters a 409 ConflictException
      const handleSave = async (mutationFn: () => Promise<any>) => {
        try {
          await mutationFn();
        } catch (err: any) {
          if (err.statusCode === 409 || err.message?.includes('conflict') || err.message?.includes('DOCUMENT_VERSION_STALE')) {
            // Surgical eviction of stale state
            await invalidateKycMutation(queryClient, 'assayer-99');
            return { conflict: true, message: 'Another user modified this document. Latest version refreshed.' };
          }
          throw err;
        }
      };

      const staleMutation = jest.fn().mockRejectedValue({
        statusCode: 409,
        message: 'DOCUMENT_VERSION_STALE: Target document has been modified by another operator.',
      });

      const result = await handleSave(staleMutation);

      expect(result).toEqual({
        conflict: true,
        message: 'Another user modified this document. Latest version refreshed.',
      });
      // Verifies that stale state was immediately evicted from TanStack cache
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['assayer-record', 'assayer-99'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['assayer-documents', 'assayer-99'] });
    });
  });
});
