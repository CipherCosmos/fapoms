import React, { useCallback, useEffect, useState } from 'react';
import { Check, Layers } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { DataTable, Column, Modal, StatusBadge, Select, useToast, useConfirm } from '../components/ui';
import { useCurrentRoles, hasAnyRole } from '../hooks/useCurrentRoles';
import { ProjectOption } from '../services/planning';
import { api } from '../services/api';
import { userMessage } from '../services/errors';
import { useScope, withScope, scopeConflict } from '../context/ScopeContext';
import {
  getVersions,
  approveVersion,
  getVersionRecords,
  CUSTOMER_MASTER_STATUS_STYLE,
  CustomerMasterVersion,
  CustomerRecord,
} from '../services/customer-master';

const APPROVER_ROLES = [
  SystemRole.SUPER_ADMINISTRATOR,
  SystemRole.ADMINISTRATOR,
  SystemRole.OPERATIONS_MANAGER,
];
const RECORDS_PAGE_SIZE = 50;

/**
 * Customer Master — version history and the approval gate.
 *
 * A version must be APPROVED before its branch PDFs generate, so this is a real pipeline
 * control, not a report. Approval is limited to the roles the backend allows; everyone else
 * sees the history read-only.
 */
// Always rendered inside <Documents/>, never routed standalone — the `embedded=false` branch this
// used to carry (its own page title/padding) was unreachable and has been removed.
export const CustomerMasterVersions: React.FC = () => {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const { scopeParams, scopeKey } = useScope();
  const roles = useCurrentRoles();
  const canApprove = hasAnyRole(roles, APPROVER_ROLES);

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [versions, setVersions] = useState<CustomerMasterVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Records drill-down
  const [recordsFor, setRecordsFor] = useState<CustomerMasterVersion | null>(null);
  const [records, setRecords] = useState<CustomerRecord[]>([]);
  const [recordsTotal, setRecordsTotal] = useState(0);
  const [recordsPage, setRecordsPage] = useState(1);
  const [recordsLoading, setRecordsLoading] = useState(false);

  /**
   * The project list is the header's list, not everything the account can see.
   *
   * This page used to call `getProjects()` unscoped, so an operator narrowed to one region still
   * got every project in the country here — the scope indicator in the header was, on this screen,
   * simply untrue. Region is enforced server-side regardless (`resolveRegionScope` falls back to
   * `users.regions`), so nothing was ever exposed that should not have been; what was wrong is
   * that the controls stopped describing the data.
   *
   * `scopeKey` is in the dependency list because narrowing the scope has to re-fetch, not re-slice:
   * the list is a server-side result, so filtering the copy already in hand would show "3 of 40"
   * with no way to reach the rest.
   */
  useEffect(() => {
    const query = withScope(scopeParams);
    api
      .request<ProjectOption[]>(`/projects${query ? `?${query}` : ''}`, { method: 'GET' })
      .then((list) => {
        setProjects(list);
        // The header's project, when it has fixed one — that is the narrowing rule, and it is why
        // the local picker below is a choice *within* the scope rather than a competing one.
        const scoped = scopeParams.projectId;
        if (scoped && list.some((p) => p.id === scoped)) setProjectId(scoped);
        else if (list.length > 0) setProjectId((current) => (current && list.some((p) => p.id === current) ? current : list[0].id));
      })
      .catch(() => toast({ type: 'error', title: 'Could not load projects', message: 'Please refresh the page.' }));
  }, [toast, scopeKey, scopeParams]);

  /** Set when the local picker names a different project than the header has fixed. */
  const scopeMismatch = scopeConflict(scopeParams, { projectId: projectId || undefined });

  const loadVersions = useCallback(async (pid: string) => {
    if (!pid) return;
    setLoading(true);
    try {
      setVersions(await getVersions(pid));
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not load versions', message: `Check your connection and try again. ${userMessage(err)}` });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (projectId) void loadVersions(projectId);
  }, [projectId, loadVersions]);

  const approve = async (v: CustomerMasterVersion) => {
    // Approval displaces whichever version is live right now — the risk is approving the
    // wrong row, not the approval itself, so the dialog names the version being approved.
    const ok = await confirm({
      title: `Approve version ${v.versionNumber}?`,
      message:
        'This becomes the active customer data for the project, replacing the version approved now, and its PDFs can then be generated.',
      confirmLabel: `Approve version ${v.versionNumber}`,
      reversibleNote: 'To go back, another version has to be approved instead.',
    });
    if (!ok) return;
    setBusyId(v.id);
    try {
      await approveVersion(v.id);
      toast({ type: 'success', title: `Version ${v.versionNumber} approved`, message: 'It is now the active customer data for this project.' });
      await loadVersions(projectId);
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not approve', message: `This version has not been approved. Try again in a moment. ${userMessage(err)}` });
    } finally {
      setBusyId(null);
    }
  };

  const openRecords = useCallback(async (v: CustomerMasterVersion, page = 1) => {
    setRecordsFor(v);
    setRecordsPage(page);
    setRecordsLoading(true);
    try {
      const res = await getVersionRecords(v.id, page, RECORDS_PAGE_SIZE);
      setRecords(res.data);
      setRecordsTotal(res.meta.total);
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not load records', message: `Close this window and open the version again. ${userMessage(err)}` });
    } finally {
      setRecordsLoading(false);
    }
  }, [toast]);

  const columns: Column<CustomerMasterVersion>[] = [
    { key: 'version', header: 'Version', render: (v) => <span style={{ fontWeight: 600 }}>#{v.versionNumber}</span> },
    { key: 'auditDate', header: 'Audit date', render: (v) => (v.auditDate ? new Date(v.auditDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—') },
    { key: 'file', header: 'File', render: (v) => <span style={{ fontSize: 12 }}>{v.fileName}</span> },
    { key: 'rows', header: 'Rows', align: 'right', sortValue: (v) => v.totalRows, render: (v) => v.totalRows.toLocaleString('en-IN') },
    {
      key: 'accounts',
      header: 'Accounts',
      align: 'right',
      render: (v) => (
        <span title="Unique / duplicate accounts">
          {v.uniqueAccounts.toLocaleString('en-IN')}
          {v.duplicateAccounts > 0 && (
            <span style={{ color: 'var(--warning, #d97706)', fontSize: 11 }}> · {v.duplicateAccounts} dup</span>
          )}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (v) => {
        const s = CUSTOMER_MASTER_STATUS_STYLE[v.status];
        return <StatusBadge color={s.color} bg={s.bg} label={s.label} />;
      },
    },
    { key: 'approved', header: 'Approved', render: (v) => (v.approvedAt ? new Date(v.approvedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—') },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (v) => (
        <div style={{ display: 'inline-flex', gap: 8 }}>
          <button type="button" onClick={() => void openRecords(v, 1)} style={btnStyle('var(--text-muted)')} title="View records">
            <Layers size={14} /> Records
          </button>
          {v.status === 'RECONCILED' && canApprove && (
            <button type="button" onClick={() => void approve(v)} disabled={busyId === v.id} style={btnStyle('var(--success, #16a34a)')} title="Approve this version">
              <Check size={15} /> Approve
            </button>
          )}
        </div>
      ),
    },
  ];

  const recordColumns: Column<CustomerRecord>[] = [
    { key: 'account', header: 'Account', render: (r) => r.accountNumber },
    { key: 'customer', header: 'Customer', render: (r) => r.customerName },
    { key: 'branch', header: 'Branch', render: (r) => r.branch?.branchCode ?? r.branch?.name ?? '—' },
    { key: 'packets', header: 'Packets', align: 'right', render: (r) => r.packetCount },
    { key: 'weight', header: 'Declared weight (g)', align: 'right', render: (r) => (r.declaredWeightGrams != null ? Number(r.declaredWeightGrams).toLocaleString('en-IN') : '—') },
  ];

  const totalRecordPages = Math.max(1, Math.ceil(recordsTotal / RECORDS_PAGE_SIZE));

  return (
    <div style={{ padding: 0 }}>
      {confirmDialog}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        {scopeMismatch && (
          // The picker below chose a project the header has fixed differently. The request carries
          // the header's — it is the ceiling — so say which one is on screen rather than letting
          // the two controls contradict each other in silence.
          <div style={{ flexBasis: '100%', padding: '6px 10px', marginBottom: 8, fontSize: 11.5, fontWeight: 600, borderRadius: 6, color: 'var(--text-warning, #92400e)', background: 'var(--bg-warning-subtle, #fef3c7)' }}>
            Showing the project from your scope filter; the selection here disagrees with it.
          </div>
        )}
        <div />
        <Select
          value={projectId}
          onChange={setProjectId}
          options={
            projects.length === 0
              ? [{ value: '', label: 'No projects' }]
              : projects.map((p) => ({ value: p.id, label: `${p.name} (${p.projectNumber})` }))
          }
          style={{ minWidth: 240, maxWidth: '100%' }}
        />
      </div>

      {!canApprove && (
        <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--text-muted)' }}>
          You have read-only access — approval is limited to administrators and operations managers.
        </p>
      )}

      <DataTable<CustomerMasterVersion>
        columns={columns}
        rows={versions}
        rowKey={(v) => v.id}
        loading={loading}
        emptyMessage={projectId ? 'No customer list has been uploaded for this project yet. Upload one above to get started.' : 'Pick a project above to see the customer lists uploaded for it.'}
      />

      <Modal
        open={!!recordsFor}
        onClose={() => setRecordsFor(null)}
        title={recordsFor ? `Version #${recordsFor.versionNumber} — ${recordsTotal.toLocaleString('en-IN')} records` : 'Records'}
      >
        <DataTable<CustomerRecord>
          columns={recordColumns}
          rows={records}
          rowKey={(r) => r.id}
          loading={recordsLoading}
          emptyMessage="This upload contains no customer rows."
        />
        {recordsTotal > RECORDS_PAGE_SIZE && recordsFor && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
            <button type="button" disabled={recordsPage <= 1 || recordsLoading} onClick={() => void openRecords(recordsFor, recordsPage - 1)} style={btnStyle('var(--text-muted)')}>
              Previous
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Page {recordsPage} of {totalRecordPages}</span>
            <button type="button" disabled={recordsPage >= totalRecordPages || recordsLoading} onClick={() => void openRecords(recordsFor, recordsPage + 1)} style={btnStyle('var(--text-muted)')}>
              Next
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
};

function btnStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12.5, fontWeight: 600,
    color, background: 'transparent', border: `1px solid ${color}`, borderRadius: 8, cursor: 'pointer',
  };
}
