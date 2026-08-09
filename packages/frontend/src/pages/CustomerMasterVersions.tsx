import React, { useCallback, useEffect, useState } from 'react';
import { Check, FileSpreadsheet, Layers } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { DataTable, Column, Modal, StatusBadge, useToast } from '../components/ui';
import { useCurrentRoles, hasAnyRole } from '../hooks/useCurrentRoles';
import { getProjects, ProjectOption } from '../services/planning';
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
export const CustomerMasterVersions: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const { toast } = useToast();
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

  useEffect(() => {
    getProjects()
      .then((list) => {
        setProjects(list);
        if (list.length > 0) setProjectId(list[0].id);
      })
      .catch(() => toast({ type: 'error', title: 'Could not load projects', message: 'Please refresh the page.' }));
  }, [toast]);

  const loadVersions = useCallback(async (pid: string) => {
    if (!pid) return;
    setLoading(true);
    try {
      setVersions(await getVersions(pid));
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not load versions', message: err?.message });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (projectId) void loadVersions(projectId);
  }, [projectId, loadVersions]);

  const approve = async (v: CustomerMasterVersion) => {
    if (!window.confirm(`Approve version ${v.versionNumber}? This supersedes the currently approved version and lets its PDFs generate.`)) return;
    setBusyId(v.id);
    try {
      await approveVersion(v.id);
      toast({ type: 'success', title: `Version ${v.versionNumber} approved`, message: 'It is now the active customer data for this project.' });
      await loadVersions(projectId);
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not approve', message: err?.message });
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
      toast({ type: 'error', title: 'Could not load records', message: err?.message });
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
    <div style={{ padding: embedded ? 0 : '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        {embedded ? <div /> : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FileSpreadsheet size={22} style={{ color: 'var(--accent)' }} />
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Customer Master</h1>
              <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>
                Version history and approval. A version must be approved before its branch PDFs generate.
              </p>
            </div>
          </div>
        )}
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border, #d1d5db)', background: 'var(--bg-surface, #fff)', color: 'inherit', fontSize: 13, minWidth: 240, maxWidth: '100%' }}
        >
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.projectNumber})</option>
          ))}
        </select>
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
        emptyMessage={projectId ? 'No customer-master versions uploaded for this project yet.' : 'Select a project.'}
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
          emptyMessage="No records in this version."
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
