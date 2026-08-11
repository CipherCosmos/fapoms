import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, Plus, ExternalLink, ArrowLeftRight, RefreshCw, Pencil } from 'lucide-react';
import { SearchInput, FilterSelect, DataTable, Pagination, DetailDrawer, StatusBadge } from '../components/ui';
import { useSocketInvalidation } from '../hooks/useSocketInvalidation';
import { useClientsList } from '../hooks/useClients';
import type { Column } from '../components/ui';
import type { Client } from '@fapoms/shared';
import { ClientLifecycleStatus } from '@fapoms/shared';
import { api } from '../services/api';
import { userMessage } from '../services/errors';
import { useToast } from '../components/ui';
import { clientLifecycleLabel, clientTypeLabel } from '../utils/statusLabels';
import { CreateClientModal } from './clients/CreateClientModal';
import { EditClientModal } from './clients/EditClientModal';
import { LifecycleModal } from './clients/LifecycleModal';
import { ContactsPanel } from './clients/ContactsPanel';
import { ContractsPanel } from './clients/ContractsPanel';
import { BillingPanel } from './clients/BillingPanel';
import { ConfigurationPanel } from './clients/ConfigurationPanel';

const LIFECYCLE_COLORS: Record<string, { color: string; bg: string }> = {
  PROSPECT: { color: 'var(--warning)', bg: 'var(--status-pending-bg)' },
  ONBOARDING: { color: 'var(--accent)', bg: 'var(--status-pending-bg)' },
  ACTIVE: { color: 'var(--success)', bg: 'var(--status-active-bg)' },
  SUSPENDED: { color: 'var(--danger)', bg: 'var(--status-cancelled-bg)' },
  UNDER_REVIEW: { color: 'var(--warning)', bg: 'var(--status-pending-bg)' },
  INACTIVE: { color: 'var(--text-muted)', bg: 'var(--bg-surface-2)' },
  TERMINATED: { color: 'var(--danger)', bg: 'var(--status-cancelled-bg)' },
  ARCHIVED: { color: 'var(--text-muted)', bg: 'var(--bg-surface-2)' },
};

const PRIORITY_COLORS: Record<string, { color: string; bg: string }> = {
  LOW: { color: 'var(--text-muted)', bg: 'var(--bg-surface-2)' },
  MEDIUM: { color: 'var(--accent)', bg: 'var(--status-pending-bg)' },
  HIGH: { color: 'var(--warning)', bg: 'var(--status-pending-bg)' },
  CRITICAL: { color: 'var(--danger)', bg: 'var(--status-cancelled-bg)' },
};

const LIFECYCLE_FILTERS = ['PROSPECT', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'UNDER_REVIEW', 'INACTIVE', 'TERMINATED', 'ARCHIVED'];
const CLIENT_TYPE_FILTERS = ['BANK', 'NBFC', 'MICROFINANCE', 'INSURANCE', 'CORPORATE', 'GOVERNMENT', 'OTHER'];
const PRIORITY_FILTERS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Legal next lifecycle steps per stage, mirroring the backend state machine. */
const CLIENT_LIFECYCLE_TRANSITIONS: Record<string, string[]> = {
  [ClientLifecycleStatus.PROSPECT]: [ClientLifecycleStatus.ONBOARDING, ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.ONBOARDING]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.INACTIVE],
  [ClientLifecycleStatus.ACTIVE]: [ClientLifecycleStatus.SUSPENDED, ClientLifecycleStatus.UNDER_REVIEW, ClientLifecycleStatus.INACTIVE],
  [ClientLifecycleStatus.SUSPENDED]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.UNDER_REVIEW, ClientLifecycleStatus.TERMINATED],
  [ClientLifecycleStatus.UNDER_REVIEW]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.SUSPENDED, ClientLifecycleStatus.TERMINATED],
  [ClientLifecycleStatus.INACTIVE]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.TERMINATED]: [ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.ARCHIVED]: [],
};

function findPathTo(from: string, target: string): string[] | null {
  if (from === target) return [];
  const queue: { stage: string; path: string[] }[] = [{ stage: from, path: [] }];
  const visited = new Set<string>([from]);
  while (queue.length) {
    const { stage, path } = queue.shift()!;
    for (const next of CLIENT_LIFECYCLE_TRANSITIONS[stage] ?? []) {
      if (next === target) return [...path, next];
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ stage: next, path: [...path, next] });
      }
    }
  }
  return null;
}

const Clients: React.FC = () => {
  useSocketInvalidation();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [clientType, setClientType] = useState('');
  const [priority, setPriority] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [sortBy, setSortBy] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showLifecycle, setShowLifecycle] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [tab, setTab] = useState<'contacts' | 'contracts' | 'billing' | 'config'>('contacts');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkReport, setBulkReport] = useState<{ target: string; succeeded: number; skipped: { id: string; current: string; reason: string }[]; failed: { id: string; reason: string }[] } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Open the client the user picked from global search (/clients?id=…), mirroring the other list
  // pages, then drop the param so a later manual close does not silently reopen it.
  useEffect(() => {
    const id = searchParams.get('id');
    if (!id) return;
    setSelectedId(id);
    const next = new URLSearchParams(searchParams);
    next.delete('id');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const { data, isLoading, isFetching, refetch } = useClientsList({
    page,
    limit,
    search: debouncedSearch || undefined,
    status: status || undefined,
    clientType: clientType || undefined,
    priority: priority || undefined,
    sortBy: sortBy || undefined,
    sortOrder,
  });

  const handleSort = (key: string) => {
    if (sortBy === key) {
      setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortOrder('asc');
    }
    setPage(1);
  };

  const selectedClient = data?.items.find((c) => c.id === selectedId) ?? null;

  const selectedClients = data?.items.filter((c) => selectedIds.has(c.id)) ?? [];
  const bulkTargets = (() => {
    if (selectedClients.length === 0) return [] as string[];
    const reachable = new Set<string>();
    for (const c of selectedClients) {
      for (const s of Object.values(ClientLifecycleStatus)) {
        if (s === c.lifecycleStatus) continue;
        if (findPathTo(c.lifecycleStatus, s) !== null) reachable.add(s);
      }
    }
    return Object.values(ClientLifecycleStatus).filter((s) => reachable.has(s));
  })();

  const runBulkTransition = async () => {
    if (!bulkTarget || selectedIds.size === 0) return;
    setBulkBusy(true);
    setBulkReport(null);
    try {
      const res = await api.request<{ succeeded: { id: string }[]; skipped: { id: string; current: string; reason: string }[]; failed: { id: string; reason: string }[] }>('/clients/bulk/lifecycle', {
        method: 'PATCH',
        body: JSON.stringify({ ids: [...selectedIds], status: bulkTarget }),
      });
      const { succeeded, skipped, failed } = res ?? { succeeded: [], skipped: [], failed: [] };
      setBulkReport({ target: bulkTarget, succeeded: succeeded.length, skipped, failed });
      toast('success', `${succeeded.length} client(s) moved to ${clientLifecycleLabel(bulkTarget)}.`);
    } catch (err: any) {
      toast({ type: 'error', title: 'Bulk lifecycle change failed', message: userMessage(err) });
    } finally {
      setBulkBusy(false);
      setBulkTarget('');
      setSelectedIds(new Set());
      refetch();
    }
  };

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const columns: Column<Client>[] = [
    {
      key: 'clientCode',
      header: 'Code',
      sortValue: (r) => r.clientCode,
      render: (r) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{r.clientCode}</span>,
    },
    {
      key: 'displayName',
      header: 'Client',
      sortValue: (r) => r.displayName,
      render: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Building2 size={14} style={{ color: 'var(--text-muted)' }} />
          <div>
            <div style={{ fontWeight: 600 }}>{r.displayName}</div>
            {r.industry && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.industry}</div>}
          </div>
        </div>
      ),
    },
    {
      key: 'clientType',
      header: 'Type',
      sortValue: (r) => r.clientType,
      render: (r) => <span style={{ fontSize: 12 }}>{clientTypeLabel(r.clientType)}</span>,
    },
    {
      key: 'lifecycleStatus',
      header: 'Lifecycle',
      sortValue: (r) => r.lifecycleStatus,
      render: (r) => {
        const c = LIFECYCLE_COLORS[r.lifecycleStatus] ?? { color: 'var(--text-muted)', bg: 'var(--bg-surface-2)' };
        return <StatusBadge label={clientLifecycleLabel(r.lifecycleStatus)} color={c.color} bg={c.bg} />;
      },
    },
    {
      key: 'priority',
      header: 'Priority',
      sortValue: (r) => r.priority,
      render: (r) => {
        const c = PRIORITY_COLORS[r.priority] ?? { color: 'var(--text-muted)', bg: 'var(--bg-surface-2)' };
        return <StatusBadge label={r.priority} color={c.color} bg={c.bg} variant="tag" />;
      },
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortValue: (r) => r.createdAt,
      render: (r) => <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{new Date(r.createdAt).toLocaleDateString()}</span>,
    },
  ];

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Building2 size={20} /> Clients
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>Manage client records, lifecycle, contacts, contracts and billing.</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={() => refetch()} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', minHeight: '38px', fontSize: '13px', fontWeight: 700 }}>
            <RefreshCw size={15} className={isFetching ? 'spin' : ''} /> Refresh
          </button>
          <button onClick={() => setShowCreate(true)} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', minHeight: '38px', fontSize: '13px', fontWeight: 700 }}>
            <Plus size={15} /> Add Client
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ width: 260, maxWidth: '100%', flex: '1 1 200px' }}><SearchInput value={search} onChange={setSearch} placeholder="Search clients..." /></div>
        <FilterSelect value={status} onChange={(v) => setStatus(v)} options={LIFECYCLE_FILTERS.map((s) => ({ value: s, label: clientLifecycleLabel(s) }))} label="Lifecycle" />
        <FilterSelect value={clientType} onChange={(v) => setClientType(v)} options={CLIENT_TYPE_FILTERS.map((t) => ({ value: t, label: clientTypeLabel(t) }))} label="Type" />
        <FilterSelect value={priority} onChange={(v) => setPriority(v)} options={PRIORITY_FILTERS.map((p) => ({ value: p, label: p }))} label="Priority" />
        {(status || clientType || priority || debouncedSearch) && (
          <button onClick={() => { setStatus(''); setClientType(''); setPriority(''); setSearch(''); setDebouncedSearch(''); setPage(1); }} className="btn btn-secondary" style={{ fontSize: 12 }}>Clear</button>
        )}
      </div>

      {selectedIds.size > 0 && (
        <div style={{
          display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
          padding: '10px 14px', borderRadius: '8px',
          background: 'var(--status-pending-bg)', border: '1px solid rgba(216,174,71,0.3)',
        }}>
          <strong style={{ fontSize: '13px' }}>{selectedIds.size} selected</strong>
          {bulkTargets.length > 0 ? (
            <>
              <ArrowLeftRight size={13} style={{ color: 'var(--text-muted)' }} />
              <select value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value)}
                style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '6px', background: 'var(--bg-page)', color: 'inherit', border: '1px solid var(--border-color)' }}>
                <option value="">Move all to…</option>
                {bulkTargets.map((t) => <option key={t} value={t}>{clientLifecycleLabel(t)}</option>)}
              </select>
              <button onClick={runBulkTransition} disabled={!bulkTarget || bulkBusy} className="btn btn-primary" style={{ fontSize: '12px', padding: '6px 12px' }}>
                {bulkBusy ? 'Applying…' : 'Apply'}
              </button>
            </>
          ) : (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No stage is reachable from the selected clients.</span>
          )}
          <button onClick={() => setSelectedIds(new Set())} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 12px', marginLeft: 'auto' }}>Clear</button>
        </div>
      )}

      {bulkReport && (
        <div style={{ padding: '12px 14px', borderRadius: '8px', fontSize: '12px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontWeight: 600, marginBottom: '8px' }}>
            <span style={{ color: 'var(--status-active-text)' }}>{bulkReport.succeeded} moved</span>
            <span style={{ color: 'var(--text-muted)' }}>{bulkReport.skipped.length} skipped</span>
            {bulkReport.failed.length > 0 && <span style={{ color: 'var(--status-danger-text)' }}>{bulkReport.failed.length} failed</span>}
            <button onClick={() => setBulkReport(null)} className="btn btn-secondary" style={{ fontSize: '11px', padding: '2px 8px', marginLeft: 'auto' }}>Dismiss</button>
          </div>
          {bulkReport.skipped.length > 0 && (
            <div style={{ marginTop: '6px' }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Could not reach {clientLifecycleLabel(bulkReport.target)}:</div>
              {bulkReport.skipped.map((s) => (
                <div key={s.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                  <span>{s.current}</span><span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>— {s.reason}</span>
                </div>
              ))}
            </div>
          )}
          {bulkReport.failed.length > 0 && (
            <div style={{ marginTop: '6px' }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Failed:</div>
              {bulkReport.failed.map((f) => (
                <div key={f.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                  <span>{f.id.slice(0, 8)}</span><span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>— {f.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(r) => r.id}
        onRowClick={(r) => setSelectedId(r.id)}
        loading={isLoading}
        sortKey={sortBy}
        sortOrder={sortOrder}
        onSort={handleSort}
        selectable
        selected={selectedIds}
        onToggleSelect={toggleSelect}
        onSelectAll={(checked) => setSelectedIds(checked ? new Set((data?.items ?? []).map((c) => c.id)) : new Set())}
        emptyState={
          <div style={{ padding: '16px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <Building2 size={34} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            <div style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600 }}>No clients found</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {status || clientType || priority || debouncedSearch
                ? 'Try adjusting your search or filters.'
                : 'Add your first client to start booking audits.'}
            </div>
            {!(status || clientType || priority || debouncedSearch) && (
              <button onClick={() => setShowCreate(true)} className="btn btn-primary" style={{ marginTop: 8, padding: '7px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Plus size={13} /> Add Client
              </button>
            )}
          </div>
        }
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{data?.meta.total ?? 0} clients</div>
        <Pagination
          page={page}
          pageSize={limit}
          total={data?.meta.total ?? 0}
          totalPages={data?.meta.totalPages ?? 1}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setLimit(s); setPage(1); }}
        />
      </div>

      <DetailDrawer
        open={!!selectedClient}
        onClose={() => setSelectedId(null)}
        title={selectedClient?.displayName ?? ''}
        subtitle={selectedClient ? `${selectedClient.clientCode}${selectedClient.industry ? ` • ${selectedClient.industry}` : ''}` : ''}
        footer={
          selectedClient && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <StatusBadge label={clientLifecycleLabel(selectedClient.lifecycleStatus)} color={LIFECYCLE_COLORS[selectedClient.lifecycleStatus]?.color ?? 'var(--text-muted)'} bg={LIFECYCLE_COLORS[selectedClient.lifecycleStatus]?.bg ?? 'var(--bg-surface-2)'} />
                <StatusBadge label={selectedClient.priority} color={PRIORITY_COLORS[selectedClient.priority]?.color ?? 'var(--text-muted)'} bg={PRIORITY_COLORS[selectedClient.priority]?.bg ?? 'var(--bg-surface-2)'} variant="tag" />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setShowEdit(true)} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Pencil size={14} /> Edit
                </button>
                <button onClick={() => setShowLifecycle(true)} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <ArrowLeftRight size={14} /> Transition
                </button>
              </div>
            </div>
          )
        }
      >
        {selectedClient && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {selectedClient.website && (
              <a href={selectedClient.website} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <ExternalLink size={12} /> {selectedClient.website}
              </a>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, fontSize: 13 }}>
              {[
                ['Contact Person', selectedClient.contactPerson],
                ['Email', selectedClient.contactEmail],
                ['Phone', selectedClient.contactPhone],
                ['Address', selectedClient.address],
                ['Budget', selectedClient.budget ? `₹${selectedClient.budget.toLocaleString()}` : '—'],
                ['Tax ID', selectedClient.taxId],
                ['Reg. No.', selectedClient.registrationNumber],
              ].map(([label, value]) => (
                <div key={label as string} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
                  <span style={{ color: 'var(--text-primary)' }}>{value || '—'}</span>
                </div>
              ))}
            </div>

            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 16 }}>
              <TabGroup active={tab} onChange={setTab} />
            </div>
            <div>
              {tab === 'contacts' && <ContactsPanel clientId={selectedClient.id} />}
              {tab === 'contracts' && <ContractsPanel clientId={selectedClient.id} />}
              {tab === 'billing' && <BillingPanel clientId={selectedClient.id} />}
              {tab === 'config' && <ConfigurationPanel clientId={selectedClient.id} />}
            </div>
          </div>
        )}
      </DetailDrawer>

      {showCreate && <CreateClientModal onClose={() => setShowCreate(false)} />}
      {showEdit && selectedClient && <EditClientModal client={selectedClient} onClose={() => setShowEdit(false)} />}
      {showLifecycle && selectedClient && (
        <LifecycleModal
          open={showLifecycle}
          onClose={() => setShowLifecycle(false)}
          clientName={selectedClient.displayName}
          currentStatus={selectedClient.lifecycleStatus}
          clientId={selectedClient.id}
        />
      )}
    </div>
  );
};

const TabGroup: React.FC<{ active: string; onChange: (t: 'contacts' | 'contracts' | 'billing' | 'config') => void }> = ({ active, onChange }) => {
  const tabs = [
    { key: 'contacts' as const, label: 'Contacts' },
    { key: 'contracts' as const, label: 'Contracts' },
    { key: 'billing' as const, label: 'Billing' },
    { key: 'config' as const, label: 'Config & Planning' },
  ];
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--border-color)' }}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          style={{
            padding: '8px 14px',
            background: 'none',
            border: 'none',
            borderBottom: active === t.key ? '2px solid var(--accent-primary)' : '2px solid transparent',
            color: active === t.key ? 'var(--accent-primary)' : 'var(--text-muted)',
            fontWeight: active === t.key ? 600 : 400,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
};

export { Clients };
