import React from 'react';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';
import {
  AssayerLifecycleStatus,
  AssayerStatus,
  ProjectBranchStatus,
  ProjectStatus,
  AssignmentStatus,
  EmpanelmentStatus,
  CustomerMasterStatus,
  InvoiceStatus,
  BillingState,
  AssayerPayableStatus,
  AssayerInvoiceStatus,
  ExpenseStatus,
  DocumentVerification,
  DocumentStatus,
  ValidationStatus,
  ScheduleStatus,
  FeedbackStatus,
  UserStatus,
} from '@fapoms/shared';

describe('StatusBadge', () => {
  it('renders the label it is given', () => {
    render(<StatusBadge color="#fff" bg="#333" label="Scheduled" />);
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });

  it('applies the caller-resolved colours rather than choosing its own', () => {
    render(<StatusBadge color="rgb(255, 255, 255)" bg="rgb(51, 51, 51)" label="Due" />);
    const el = screen.getByText('Due');
    expect(el).toHaveStyle({ color: 'rgb(255, 255, 255)' });
  });

  it('never conveys state by colour alone — the label is always rendered', () => {
    const { container } = render(<StatusBadge color="#0f0" bg="#020" label="Paid" />);
    expect(container.textContent).toContain('Paid');
  });

  describe('domain status resolution & coverage', () => {
    it('resolves assayerLifecycle domain status automatically', () => {
      render(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.ACTIVE} />);
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('resolves distinct labels for SUSPENDED vs INACTIVE vs RESIGNED vs TERMINATED', () => {
      const { rerender } = render(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.SUSPENDED} />);
      expect(screen.getByText('Suspended')).toBeInTheDocument();

      rerender(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.INACTIVE} />);
      expect(screen.getByText('Inactive')).toBeInTheDocument();

      rerender(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.RESIGNED} />);
      expect(screen.getByText('Resigned')).toBeInTheDocument();

      rerender(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.TERMINATED} />);
      expect(screen.getByText('Terminated')).toBeInTheDocument();
    });

    it('distinguishes onboarding pipeline states without flattening', () => {
      const { rerender } = render(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.INVITED} />);
      expect(screen.getByText('Invited')).toBeInTheDocument();

      rerender(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.DOCUMENT_VERIFICATION} />);
      expect(screen.getByText('Document Check')).toBeInTheDocument();

      rerender(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.BACKGROUND_VERIFICATION} />);
      expect(screen.getByText('Background Check')).toBeInTheDocument();

      rerender(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.TRAINING} />);
      expect(screen.getByText('In Training')).toBeInTheDocument();
    });

    it('resolves assayerOperational status', () => {
      render(<StatusBadge domain="assayerOperational" status={AssayerStatus.ACTIVE} />);
      expect(screen.getByText('Operational')).toBeInTheDocument();
    });

    it('resolves branch domain status automatically', () => {
      render(<StatusBadge domain="branch" status={ProjectBranchStatus.SCHEDULED} />);
      expect(screen.getByText('Scheduled')).toBeInTheDocument();
    });

    it('resolves project domain status automatically', () => {
      render(<StatusBadge domain="project" status={ProjectStatus.COMPLETED} />);
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('resolves assignment domain status automatically', () => {
      render(<StatusBadge domain="assignment" status={AssignmentStatus.CHECKED_IN} />);
      expect(screen.getByText('Checked In on Site')).toBeInTheDocument();
    });

    it('resolves empanelment domain status automatically', () => {
      const { rerender } = render(<StatusBadge domain="empanelment" status={EmpanelmentStatus.ACTIVE} />);
      expect(screen.getByText('Empanelled')).toBeInTheDocument();

      rerender(<StatusBadge domain="empanelment" status={EmpanelmentStatus.RECOMMENDED} />);
      expect(screen.getByText('Recommended')).toBeInTheDocument();

      rerender(<StatusBadge domain="empanelment" status={EmpanelmentStatus.DOCUMENTS_PENDING} />);
      expect(screen.getByText('Docs Pending')).toBeInTheDocument();

      rerender(<StatusBadge domain="empanelment" status={EmpanelmentStatus.TERMINATED} />);
      expect(screen.getByText('Empanelment Terminated')).toBeInTheDocument();

      rerender(<StatusBadge domain="empanelment" status="OVERRIDDEN" />);
      expect(screen.getByText('Override Active')).toBeInTheDocument();
    });

    it('resolves customerMaster reconciliation status', () => {
      render(<StatusBadge domain="customerMaster" status={CustomerMasterStatus.APPROVED} />);
      expect(screen.getByText('Approved')).toBeInTheDocument();
    });

    it('resolves documentVerification status', () => {
      render(<StatusBadge domain="documentVerification" status={DocumentVerification.VERIFIED} />);
      expect(screen.getByText('Verified')).toBeInTheDocument();
    });

    it('resolves strictly-typed billing subdomains', () => {
      const { rerender } = render(<StatusBadge domain="billingState" status={BillingState.UNBILLED} />);
      expect(screen.getByText('Unbilled')).toBeInTheDocument();

      rerender(<StatusBadge domain="invoice" status={InvoiceStatus.ISSUED} />);
      expect(screen.getByText('Issued (Sent)')).toBeInTheDocument();

      rerender(<StatusBadge domain="assayerPayable" status={AssayerPayableStatus.APPROVED} />);
      expect(screen.getByText('Approved (Frozen)')).toBeInTheDocument();

      rerender(<StatusBadge domain="assayerInvoice" status={AssayerInvoiceStatus.SUBMITTED} />);
      expect(screen.getByText('Submitted')).toBeInTheDocument();
    });

    it('resolves unified billing domain for backwards compatibility', () => {
      render(<StatusBadge domain="billing" status={InvoiceStatus.PAID} />);
      expect(screen.getByText('Paid')).toBeInTheDocument();
    });

    it('resolves expense status', () => {
      render(<StatusBadge domain="expense" status={ExpenseStatus.APPROVED} />);
      expect(screen.getByText('Approved')).toBeInTheDocument();
    });

    it('resolves document workflow status', () => {
      render(<StatusBadge domain="document" status={DocumentStatus.DISPATCHED} />);
      expect(screen.getByText('Dispatched')).toBeInTheDocument();
    });

    it('resolves validation status', () => {
      render(<StatusBadge domain="validation" status={ValidationStatus.APPROVED} />);
      expect(screen.getByText('Validation Approved')).toBeInTheDocument();
    });

    it('resolves schedule status', () => {
      render(<StatusBadge domain="schedule" status={ScheduleStatus.CONFIRMED} />);
      expect(screen.getByText('Confirmed')).toBeInTheDocument();
    });

    it('resolves feedback thread status', () => {
      render(<StatusBadge domain="feedback" status={FeedbackStatus.IN_PROGRESS} />);
      expect(screen.getByText('In Progress')).toBeInTheDocument();
    });

    it('resolves user account status', () => {
      render(<StatusBadge domain="user" status={UserStatus.LOCKED} />);
      expect(screen.getByText('Locked')).toBeInTheDocument();
    });

    it('resolves derived operational attention states', () => {
      const { rerender } = render(<StatusBadge domain="attention" status="NEEDS_RESPONSE" />);
      expect(screen.getByText('Needs Response')).toBeInTheDocument();

      rerender(<StatusBadge domain="attention" status="OVERDUE" />);
      expect(screen.getByText('Overdue')).toBeInTheDocument();

      rerender(<StatusBadge domain="attention" status="CHECKIN_MISSING" />);
      expect(screen.getByText('Check-in Missing')).toBeInTheDocument();

      rerender(<StatusBadge domain="attention" status="IN_PROGRESS" />);
      expect(screen.getByText('In Field')).toBeInTheDocument();

      rerender(<StatusBadge domain="attention" status="AWAITING_VALIDATION" />);
      expect(screen.getByText('Awaiting QA')).toBeInTheDocument();

      rerender(<StatusBadge domain="attention" status="CONFLICT" />);
      expect(screen.getByText('Conflict')).toBeInTheDocument();

      rerender(<StatusBadge domain="attention" status="BLOCKED" />);
      expect(screen.getByText('Blocked')).toBeInTheDocument();

      rerender(<StatusBadge domain="attention" status="NORMAL" />);
      expect(screen.getByText('On Track')).toBeInTheDocument();
    });
  });

  describe('accessibility and non-color semantics', () => {
    it('does NOT apply role="status" by default on static badges to avoid noisy live region announcements in tables', () => {
      const { container } = render(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.ACTIVE} />);
      expect(screen.queryByRole('status')).toBeNull();
      const badge = container.querySelector('span');
      expect(badge).toBeInTheDocument();
      expect(badge?.getAttribute('role')).toBeNull();
    });

    it('applies role="status" and aria-live="polite" when live={true}', () => {
      render(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.ACTIVE} live />);
      const badge = screen.getByRole('status');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveAttribute('aria-live', 'polite');
    });

    it('allows explicit role override when specified by caller', () => {
      render(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.ACTIVE} role="status" />);
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('renders contextual icon inside an aria-hidden container', () => {
      const { container } = render(<StatusBadge domain="assayerLifecycle" status={AssayerLifecycleStatus.ACTIVE} />);
      const iconSpan = container.querySelector('span[aria-hidden="true"]');
      expect(iconSpan).toBeInTheDocument();
    });

    it('honors custom icon override when provided', () => {
      render(
        <StatusBadge
          domain="assayerLifecycle"
          status={AssayerLifecycleStatus.ACTIVE}
          icon={<span data-testid="custom-icon">★</span>}
        />
      );
      expect(screen.getByTestId('custom-icon')).toBeInTheDocument();
    });
  });

  describe('safe unknown status fallback', () => {
    it('safely renders humanized fallback without crashing when encountering unknown backend status', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      render(<StatusBadge domain="billing" status="PENDING_ARBITRATION" />);
      expect(screen.getByText('Pending Arbitration')).toBeInTheDocument();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('gracefully handles null or undefined status', () => {
      render(<StatusBadge domain="branch" status={null} />);
      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });
  });
});
