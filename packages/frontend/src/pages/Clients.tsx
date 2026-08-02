import React, { useState, useEffect } from 'react';
import { Building2, Plus, ExternalLink, ArrowLeftRight, RefreshCw, Pencil } from 'lucide-react';
import { SearchInput, FilterSelect, DataTable, Pagination, DetailDrawer, StatusBadge } from '../components/ui';
import { useSocketInvalidation } from '../hooks/useSocketInvalidation';
import { useClientsList } from '../hooks/useClients';
import type { Column } from '../components/ui';
import type { Client } from '@fapoms/shared';
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showLifecycle, setShowLifecycle] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [tab, setTab] = useState<'contacts' | 'contracts' | 'billing' | 'config'>('contacts');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Building2 size={20} /> Clients
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>Manage client records, lifecycle, contacts, contracts and billing.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => refetch()} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={14} className={isFetching ? 'spin' : ''} /> Refresh
          </button>
          <button onClick={() => setShowCreate(true)} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> Add Client
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ width: 260 }}><SearchInput value={search} onChange={setSearch} placeholder="Search clients..." /></div>
        <FilterSelect value={status} onChange={(v) => setStatus(v)} options={LIFECYCLE_FILTERS.map((s) => ({ value: s, label: clientLifecycleLabel(s) }))} label="Lifecycle" />
        <FilterSelect value={clientType} onChange={(v) => setClientType(v)} options={CLIENT_TYPE_FILTERS.map((t) => ({ value: t, label: clientTypeLabel(t) }))} label="Type" />
        <FilterSelect value={priority} onChange={(v) => setPriority(v)} options={PRIORITY_FILTERS.map((p) => ({ value: p, label: p }))} label="Priority" />
        {(status || clientType || priority || debouncedSearch) && (
          <button onClick={() => { setStatus(''); setClientType(''); setPriority(''); setSearch(''); setDebouncedSearch(''); setPage(1); }} className="btn btn-secondary" style={{ fontSize: 12 }}>Clear</button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(r) => r.id}
        onRowClick={(r) => setSelectedId(r.id)}
        loading={isLoading}
        sortKey={sortBy}
        sortOrder={sortOrder}
        onSort={handleSort}
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

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
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
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-color)' }}>
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
