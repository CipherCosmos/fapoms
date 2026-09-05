import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Hourglass, Send, Trash2, XCircle } from 'lucide-react';
import {
  DestructiveActionRequest,
  DestructiveActionRequestStatus,
} from '@fapoms/shared';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { SectionCard, Pill } from '../../../components/ui/settings';
import { useConfirm, useToast } from '../../../components/ui';
import { useCurrentUserId } from '../../../hooks/useCurrentRoles';
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

/** "23h 40m" / "12 min" / "expiring now", for a moment already in the future. */
const formatCountdown = (iso: string): string => {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expiring now';
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

/** The frozen domains of a request, as labelled chips with the row counts the approver saw. */
const DomainChips: React.FC<{ request: DestructiveActionRequest; domains: WipeDomain[] }> = ({ request, domains }) => {
  const labelOf = (key: string) => domains.find((d) => d.key === key)?.label ?? key;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
      {request.domainKeys.map((key) => (
        <span
          key={key}
          style={{
            fontSize: '11px', fontWeight: 700, padding: '2px 9px', borderRadius: '10px',
            border: '1px solid var(--border-color)', color: 'var(--text-secondary)',
            background: 'var(--bg-secondary)',
          }}
        >
          {labelOf(key)} · {(request.previewCounts?.[key] ?? 0).toLocaleString()}
        </span>
      ))}
    </div>
  );
};

/**
 * The entry point for clearing accumulated test/seed data. Since 2026-09-05 it runs the
 * developer's half of the destructive-action two-person rule (destructive-action.ts in
 * @fapoms/shared): pick domains → preview → FILE A REQUEST, wait for an admin to approve it on
 * /admin/approvals, and only then execute — with the same typed phrase as before plus the
 * approved request's id. Nobody wipes alone any more; the direct execute path is gone on the
 * backend too (execute requires a requestId).
 *
 * Kept on the Platform Settings page (a "Danger Zone" group, see PlatformSettings.tsx) rather
 * than a separate route: same place the developer already looks for this kind of control.
 */
export const DangerZoneSection: React.FC = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const currentUserId = useCurrentUserId();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [modal, setModal] = useState<'request' | 'execute' | null>(null);
  /** A REJECTED/EXPIRED notice the developer has read and put away, so a new request can start. */
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
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

  /**
   * The request pipeline, polled rather than socket-wired: an approval happens on someone
   * else's screen and lands here as a status flip, so a 30s poll plus a refetch whenever the
   * developer comes back to the tab (the app default is refetchOnWindowFocus: false, overridden
   * deliberately) keeps the banner honest without inventing a new socket event. The decision
   * itself also reaches the developer through the notification bell.
   */
  const { data: requestsRes } = useQuery({
    queryKey: ['data-reset', 'requests'],
    queryFn: () => api.request<DestructiveActionRequest[]>('/admin/data-reset/requests'),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 30_000,
  });

  /**
   * My newest request decides what this screen is doing. The endpoint already scopes a
   * developer to their own requests; the filter repeats that for the one account shape it
   * would otherwise mis-render — someone holding DEVELOPER and ADMIN together, whose response
   * carries everyone's pending requests.
   */
  const myLatest = useMemo(() => {
    const mine = (requestsRes ?? [])
      .filter((r) => !currentUserId || r.requestedById === currentUserId)
      .slice()
      .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
    return mine[0] ?? null;
  }, [requestsRes, currentUserId]);

  // Re-render every 30s while an approval is counting down, so the "execute within…" line and
  // the client-side expiry flip below track the clock between polls.
  const [, setTick] = useState(0);
  const approvedUntil = myLatest?.status === DestructiveActionRequestStatus.APPROVED ? myLatest.expiresAt : null;
  useEffect(() => {
    if (!approvedUntil) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [approvedUntil]);

  /** APPROVED and still inside its window — the only state in which Execute is offered. */
  const approvedLive = Boolean(
    myLatest
    && myLatest.status === DestructiveActionRequestStatus.APPROVED
    && myLatest.expiresAt
    && new Date(myLatest.expiresAt).getTime() > Date.now(),
  );
  const activeRequest = myLatest
    && (myLatest.status === DestructiveActionRequestStatus.REQUESTED || approvedLive)
    ? myLatest
    : null;
  /** A decided-against-us outcome still on screen: rejected, expired, or approved-then-ran-out. */
  const notice = !activeRequest
    && myLatest
    && myLatest.id !== dismissedId
    && (
      myLatest.status === DestructiveActionRequestStatus.REJECTED
      || myLatest.status === DestructiveActionRequestStatus.EXPIRED
      || (myLatest.status === DestructiveActionRequestStatus.APPROVED && !approvedLive)
    )
    ? myLatest
    : null;
  const noticeExpired = notice != null && notice.status !== DestructiveActionRequestStatus.REJECTED;

  const refreshRequests = () => queryClient.invalidateQueries({ queryKey: ['data-reset', 'requests'] });

  const withdraw = useMutation({
    mutationFn: (id: string) => api.request(`/admin/data-reset/requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => { toast('success', 'Request withdrawn.'); refreshRequests(); },
    onError: (err) => toast({ type: 'error', title: 'Could not withdraw the request', message: userMessage(err) }),
  });

  const toggle = (key: string) =>
    setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const onWiped = () => {
    setModal(null);
    setSelectedKeys([]);
    queryClient.invalidateQueries({ queryKey: ['data-reset'] });
    // The rest of the app is reading data this may have just removed — a stale Clients list or
    // Operations Inbox after a wipe is the one place "trust the cache" is actively wrong.
    queryClient.invalidateQueries();
  };

  /**
   * While a request is in flight the selection IS the request's — frozen, because the admin
   * approved (or is being asked to approve) exactly that payload, and executing anything else
   * against its id would make the approval meaningless. The checkboxes render it read-only.
   */
  const frozenKeys = activeRequest?.domainKeys ?? null;
  const shownKeys = frozenKeys ?? selectedKeys;

  return (
    <>
      {confirmDialog}
      <div
        className="glass-card"
        style={{ padding: '10px 14px', display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: 'var(--danger)', border: '1px solid rgba(216,71,71,0.35)' }}
      >
        <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
        <span>
          This clears real rows from the live database. There is no undo except restoring a backup —
          and nothing is deleted until an administrator has approved your request and you execute it.
        </span>
      </div>

      {/* ── The current request, whatever state it is in ─────────────────── */}
      {activeRequest && activeRequest.status === DestructiveActionRequestStatus.REQUESTED && (
        <div className="glass-card" style={{ padding: '14px 16px', border: '1px solid var(--warning)' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px', fontWeight: 700, color: 'var(--warning)' }}>
            <Hourglass size={15} /> Waiting for an Admin&apos;s approval
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', lineHeight: 1.6 }}>
            Requested {new Date(activeRequest.requestedAt).toLocaleString()}. An administrator has to
            approve it on the Approvals page before anything can be executed; the domains below are
            frozen while the request stands.
          </div>
          <DomainChips request={activeRequest} domains={domains} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
            <button
              className="btn btn-secondary"
              style={{ padding: '6px 14px', fontSize: '12px' }}
              disabled={withdraw.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Withdraw this wipe request?',
                  message: 'The pending request is cancelled and the domain selection unlocks. Nothing is deleted either way.',
                  confirmLabel: 'Withdraw request',
                  reversibleNote: 'You can file a fresh request at any time — it will need a new approval.',
                });
                if (ok) withdraw.mutate(activeRequest.id);
              }}
            >
              {withdraw.isPending ? 'Withdrawing…' : 'Withdraw request'}
            </button>
          </div>
        </div>
      )}

      {activeRequest && activeRequest.status === DestructiveActionRequestStatus.APPROVED && (
        <div className="glass-card" style={{ padding: '14px 16px', border: '1px solid var(--success, #34a853)' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px', fontWeight: 700, color: 'var(--success, #34a853)' }}>
            <CheckCircle2 size={15} /> Approved — you can execute this wipe
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', lineHeight: 1.6 }}>
            Approved by {activeRequest.decidedByName ?? 'an administrator'}
            {activeRequest.decidedAt ? ` on ${new Date(activeRequest.decidedAt).toLocaleString()}` : ''}.
            {activeRequest.expiresAt && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginLeft: '6px', fontWeight: 700 }}>
                <Clock size={12} /> Executable for {formatCountdown(activeRequest.expiresAt)}
                {' '}(until {new Date(activeRequest.expiresAt).toLocaleString()}).
              </span>
            )}
            {' '}The approval covers exactly the domains below — they stay frozen until it is used or runs out.
          </div>
          <DomainChips request={activeRequest} domains={domains} />
        </div>
      )}

      {notice && (
        <div
          className="glass-card"
          style={{ padding: '14px 16px', border: `1px solid ${noticeExpired ? 'var(--border-color)' : 'var(--danger)'}` }}
        >
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px', fontWeight: 700, color: noticeExpired ? 'var(--text-secondary)' : 'var(--danger)' }}>
            <XCircle size={15} />
            {noticeExpired ? 'The approval ran out before the wipe was executed' : 'Your wipe request was rejected'}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', lineHeight: 1.6 }}>
            {noticeExpired ? (
              <>Approvals stay executable for a limited window and this one was not used in time. Nothing was deleted. File a fresh request if the wipe is still wanted.</>
            ) : (
              <>
                {notice.decidedByName ?? 'An administrator'} said no
                {notice.decidedAt ? ` on ${new Date(notice.decidedAt).toLocaleString()}` : ''}
                {notice.decisionReason ? <> — “{notice.decisionReason}”</> : '.'}
                {' '}Nothing was deleted. You can adjust the selection and request again.
              </>
            )}
          </div>
          <DomainChips request={notice} domains={domains} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
            <button
              className="btn btn-secondary"
              style={{ padding: '6px 14px', fontSize: '12px' }}
              onClick={() => setDismissedId(notice.id)}
            >
              Start a new request
            </button>
          </div>
        </div>
      )}

      <SectionCard
        title="Clear application data"
        description={
          frozenKeys
            ? 'A wipe request is in flight, so the selection is locked to what was requested — the approval is for that exact payload. Withdraw the request (or let it lapse) to choose differently.'
            : 'Pick what to remove, then request a wipe — an administrator has to approve it before you can execute. Roles, permissions and organisation settings are never touched by this tool.'
        }
      >
        {isLoading ? (
          <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
        ) : isError ? (
          <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start', color: 'var(--danger)', fontSize: '13px' }}>
            <div>Couldn&apos;t load what can be cleared. {userMessage(error)}</div>
            <button className="btn btn-secondary" style={{ padding: '6px 14px', fontSize: '12px' }} onClick={() => refetch()}>Try again</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {domains.map((d, i) => {
              const count = domainRowCount(d);
              const checked = shownKeys.includes(d.key);
              const locked = frozenKeys !== null;
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
                    cursor: locked ? 'default' : 'pointer',
                    opacity: locked && !checked ? 0.55 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={locked}
                    onChange={() => toggle(d.key)}
                    style={{ marginTop: '2px', cursor: locked ? 'not-allowed' : 'pointer' }}
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

        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px', marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--border-hair, var(--border-color))' }}>
          {!activeRequest && (
            <button
              className="btn btn-primary"
              disabled={selectedKeys.length === 0}
              onClick={() => setModal('request')}
              style={{ background: 'var(--danger)', border: 'none', display: 'flex', alignItems: 'center', gap: '7px', padding: '9px 16px', fontSize: '12.5px' }}
            >
              <Send size={14} /> Request wipe…
            </button>
          )}
          {activeRequest?.status === DestructiveActionRequestStatus.REQUESTED && (
            <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
              Execution unlocks once an administrator approves the request above.
            </span>
          )}
          {activeRequest?.status === DestructiveActionRequestStatus.APPROVED && (
            <button
              className="btn btn-primary"
              onClick={() => setModal('execute')}
              style={{ background: 'var(--danger)', border: 'none', display: 'flex', alignItems: 'center', gap: '7px', padding: '9px 16px', fontSize: '12.5px' }}
            >
              <Trash2 size={14} /> Execute approved wipe…
            </button>
          )}
        </div>
      </SectionCard>

      {modal === 'request' && (
        <DataResetModal
          mode="request"
          domains={domains}
          initialSelectedKeys={selectedKeys}
          onClose={() => setModal(null)}
          onRequested={() => {
            setModal(null);
            setSelectedKeys([]);
            setDismissedId(null);
            refreshRequests();
          }}
          onWiped={onWiped}
        />
      )}
      {modal === 'execute' && activeRequest && (
        <DataResetModal
          mode="execute"
          domains={domains}
          initialSelectedKeys={activeRequest.domainKeys}
          requestId={activeRequest.id}
          onClose={() => setModal(null)}
          onWiped={onWiped}
        />
      )}
    </>
  );
};

export default DangerZoneSection;
