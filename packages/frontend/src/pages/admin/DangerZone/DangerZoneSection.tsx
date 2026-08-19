import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { api } from '../../../services/api';
import { SectionCard, Pill } from '../../../components/ui/settings';
import { DataResetModal } from './DataResetModal';

export interface WipeDomain {
  key: string;
  label: string;
  description: string;
  tables: string[];
  requiresKeepList?: true;
  requiresBillingConfirmation?: true;
  counts: Record<string, number>;
}

/** Sum of a domain's own table counts — what "N rows" means on its row. */
export const domainRowCount = (d: WipeDomain) => Object.values(d.counts).reduce((a, b) => a + b, 0);

/**
 * The entry point for clearing accumulated test/seed data — a picker of domains with live row
 * counts, feeding into `DataResetModal` for the actual confirm-and-preview flow. Kept on the
 * Platform Settings page (a new "Danger Zone" group, see PlatformSettings.tsx) rather than a
 * separate route: same place a super administrator already looks for this kind of control.
 */
export const DangerZoneSection: React.FC = () => {
  const queryClient = useQueryClient();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [modalOpen, setModalOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['data-reset', 'domains'],
    queryFn: () => api.request<{ domains: WipeDomain[] }>('/admin/data-reset/domains'),
    /**
     * Never serve these counts from cache.
     *
     * The app-wide default is `staleTime: 5 minutes` (see queryClient.ts), which is right for
     * ordinary lists and wrong here: this screen was observed offering "Geography reference
     * data · 51" for tables that had already been emptied, because the numbers came from a
     * five-minute-old fetch. A row count is the only thing on this page telling an operator how
     * much they are about to destroy, so it has to be what the database says right now.
     */
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const domains = data?.domains ?? [];

  const toggle = (key: string) =>
    setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const onWiped = () => {
    setModalOpen(false);
    setSelectedKeys([]);
    queryClient.invalidateQueries({ queryKey: ['data-reset'] });
    // The rest of the app is reading data this may have just removed — a stale Clients list or
    // Operations Inbox after a wipe is the one place "trust the cache" is actively wrong.
    queryClient.invalidateQueries();
  };

  return (
    <>
      <div
        className="glass-card"
        style={{ padding: '10px 14px', display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: 'var(--danger)', border: '1px solid rgba(216,71,71,0.35)' }}
      >
        <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
        <span>
          This clears real rows from the live database. There is no undo except restoring a backup —
          take one first if you are not certain.
        </span>
      </div>

      <SectionCard
        title="Clear application data"
        description="Pick what to remove. Roles, permissions and organisation settings are never touched by this tool — see each domain's note for exactly what it covers."
      >
        {isLoading ? (
          <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {domains.map((d, i) => {
              const count = domainRowCount(d);
              const checked = selectedKeys.includes(d.key);
              return (
                <label
                  key={d.key}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '20px 1fr auto',
                    gap: '12px',
                    alignItems: 'start',
                    padding: '12px 4px',
                    borderBottom: i === domains.length - 1 ? 'none' : '1px solid var(--border-hair, var(--border-color))',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(d.key)}
                    style={{ marginTop: '2px', cursor: 'pointer' }}
                  />
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', gap: '7px', alignItems: 'center', flexWrap: 'wrap' }}>
                      {d.label}
                      {d.requiresKeepList && <Pill tone="warning">Keeps accounts you choose</Pill>}
                      {d.requiresBillingConfirmation && <Pill tone="warning">Extra confirmation</Pill>}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.5, maxWidth: '62ch' }}>
                      {d.description}
                    </div>
                  </div>
                  <Pill tone={count > 0 ? 'accent' : 'muted'}>{count.toLocaleString()} row{count === 1 ? '' : 's'}</Pill>
                </label>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--border-hair, var(--border-color))' }}>
          <button
            className="btn btn-primary"
            disabled={selectedKeys.length === 0}
            onClick={() => setModalOpen(true)}
            style={{ background: 'var(--danger)', border: 'none', display: 'flex', alignItems: 'center', gap: '7px', padding: '9px 16px', fontSize: '12.5px' }}
          >
            <Trash2 size={14} /> Wipe selected data…
          </button>
        </div>
      </SectionCard>

      {modalOpen && (
        <DataResetModal
          domains={domains}
          initialSelectedKeys={selectedKeys}
          onClose={() => setModalOpen(false)}
          onWiped={onWiped}
        />
      )}
    </>
  );
};

export default DangerZoneSection;
