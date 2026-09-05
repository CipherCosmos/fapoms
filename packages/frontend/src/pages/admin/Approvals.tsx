import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Info, ShieldCheck, Trash2 } from 'lucide-react';
import {
  DestructiveActionRequest,
  DestructiveActionRequestStatus,
} from '@fapoms/shared';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { PageHeader, useConfirm, useToast } from '../../components/ui';
import { useCurrentRoles, canApproveDestructiveActions } from '../../hooks/useCurrentRoles';

/**
 * The admin's half of the destructive-action two-person rule (destructive-action.ts in
 * @fapoms/shared): a DEVELOPER files a data-wipe request in Platform Settings' Danger Zone, and
 * it is decided HERE — approve, and the developer has a bounded window to execute; reject, with
 * a reason the developer sees on their screen.
 *
 * The route admits ADMIN by name, but implication (DEVELOPER ⇒ ADMIN, role-hierarchy.ts) means a
 * developer passes that gate too — so the ACTIONS are gated in-page on the DIRECT role
 * (`canApproveDestructiveActions`), exactly as the backend gates them on the caller's stored role
 * rows. A developer landing here reads the queue and cannot touch it; approving their own request
 * from a second hat is the precise thing the rule exists to prevent.
 */

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: '10px', padding: '16px',
};

/** "USERS_AND_ROLES" / "users-and-roles" → "Users and roles" — the keys are machine names. */
const prettyDomain = (key: string): string =>
  key.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());

const STATUS_STYLE: Record<DestructiveActionRequestStatus, { label: string; fg: string; bg: string }> = {
  [DestructiveActionRequestStatus.REQUESTED]: { label: 'Awaiting decision', fg: 'var(--warning)', bg: 'rgba(216,120,71,0.14)' },
  [DestructiveActionRequestStatus.APPROVED]: { label: 'Approved', fg: 'var(--success, #34a853)', bg: 'rgba(52,168,83,0.14)' },
  [DestructiveActionRequestStatus.REJECTED]: { label: 'Rejected', fg: 'var(--danger)', bg: 'rgba(216,71,71,0.12)' },
  [DestructiveActionRequestStatus.EXPIRED]: { label: 'Expired unused', fg: 'var(--text-muted)', bg: 'var(--bg-surface-2, rgba(255,255,255,0.06))' },
  [DestructiveActionRequestStatus.CANCELLED]: { label: 'Withdrawn', fg: 'var(--text-muted)', bg: 'var(--bg-surface-2, rgba(255,255,255,0.06))' },
  [DestructiveActionRequestStatus.EXECUTED]: { label: 'Executed', fg: 'var(--danger)', bg: 'rgba(216,71,71,0.12)' },
};

const StatusPill: React.FC<{ status: DestructiveActionRequestStatus }> = ({ status }) => {
  const s = STATUS_STYLE[status];
  return (
    <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.03em', padding: '2px 8px', borderRadius: '10px', background: s.bg, color: s.fg, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  );
};

/** The request's frozen domains, with the row counts previewed at request time. */
const DomainChips: React.FC<{ request: DestructiveActionRequest }> = ({ request }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
    {request.domainKeys.map((key) => (
      <span
        key={key}
        style={{
          fontSize: '11px', fontWeight: 700, padding: '2px 9px', borderRadius: '10px',
          border: '1px solid var(--border-color)', color: 'var(--text-secondary)',
          background: 'var(--bg-secondary)',
        }}
      >
        {prettyDomain(key)} · {(request.previewCounts?.[key] ?? 0).toLocaleString()} rows
      </span>
    ))}
  </div>
);

const totalRows = (r: DestructiveActionRequest) =>
  Object.values(r.previewCounts ?? {}).reduce((a, b) => a + b, 0);

export const Approvals: React.FC = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const roles = useCurrentRoles();
  /**
   * DIRECT role only — deliberately not implication-aware, and the WHY is the whole feature:
   * `expandRoles` makes every developer an admin for gates, so an expanded check would offer
   * Approve to the person whose own request needs a second pair of eyes. Mirrors the backend's
   * direct-role check, so the buttons show exactly for the accounts whose click is honoured.
   */
  const canDecide = canApproveDestructiveActions(roles);

  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  /**
   * Same query key the Danger Zone uses, so a decision made here refreshes an open developer
   * screen sharing this cache, and vice versa. Polled + refetched on focus (the app default is
   * refetchOnWindowFocus: false) because the other half of the flow happens on someone else's
   * screen; the bell notification covers the gap between polls.
   */
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['data-reset', 'requests'],
    queryFn: () => api.request<DestructiveActionRequest[]>('/admin/data-reset/requests'),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 30_000,
  });

  const requests = useMemo(
    () => (data ?? []).slice().sort(
      (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime(),
    ),
    [data],
  );
  // The queue reads oldest-first — the longest-waiting request is the one to decide next.
  const pending = requests
    .filter((r) => r.status === DestructiveActionRequestStatus.REQUESTED)
    .slice()
    .sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime());
  const decided = requests.filter((r) => r.status !== DestructiveActionRequestStatus.REQUESTED).slice(0, 20);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['data-reset', 'requests'] });

  const approve = useMutation({
    mutationFn: (id: string) => api.request(`/admin/data-reset/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => { toast('success', 'Approved — the requesting developer can now execute it.'); refresh(); },
    onError: (err) => toast({ type: 'error', title: 'Could not approve it', message: userMessage(err) }),
  });

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.request(`/admin/data-reset/requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: () => {
      toast('success', 'Rejected — the developer sees your reason.');
      setRejectingId(null);
      setRejectReason('');
      refresh();
    },
    onError: (err) => toast({ type: 'error', title: 'Could not reject it', message: userMessage(err) }),
  });

  const onApprove = async (r: DestructiveActionRequest) => {
    const ok = await confirm({
      title: `Approve this data wipe?`,
      message: (
        <>
          <b>{r.requestedByName ?? 'A developer'}</b> asked to wipe{' '}
          <b>{r.domainKeys.length} domain{r.domainKeys.length === 1 ? '' : 's'}</b> covering about{' '}
          <b>{totalRows(r).toLocaleString()} rows</b>:
          <div style={{ margin: '8px 0' }}><DomainChips request={r} /></div>
          Approving authorises deletion: they can execute this wipe at any time until the approval
          expires, and the records it removes cannot be brought back by the app.
        </>
      ),
      confirmLabel: 'Approve the wipe',
      reversible: false,
      tone: 'danger',
    });
    if (ok) approve.mutate(r.id);
  };

  const PendingRow: React.FC<{ r: DestructiveActionRequest }> = ({ r }) => (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '13.5px', fontWeight: 700, color: 'var(--text-primary)' }}>
            {r.requestedByName ?? 'A developer'} wants to wipe {r.domainKeys.length} domain{r.domainKeys.length === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
            <Clock size={12} /> Requested {new Date(r.requestedAt).toLocaleString()} · about {totalRows(r).toLocaleString()} rows in total
          </div>
        </div>
        <StatusPill status={r.status} />
      </div>
      <DomainChips request={r} />
      {canDecide && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px', borderTop: '1px solid var(--border-hair, var(--border-color))' }}>
          {rejectingId === r.id ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                autoFocus
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Why not — the developer reads this"
                style={{ flex: '1 1 260px', padding: '7px 10px', fontSize: '12.5px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', outline: 'none' }}
              />
              <button
                className="btn btn-primary"
                disabled={rejectReason.trim().length === 0 || reject.isPending}
                onClick={() => reject.mutate({ id: r.id, reason: rejectReason.trim() })}
                style={{ background: 'var(--danger)', border: 'none', padding: '7px 14px', fontSize: '12px' }}
              >
                {reject.isPending ? 'Rejecting…' : 'Reject request'}
              </button>
              <button
                className="btn btn-secondary"
                style={{ padding: '7px 12px', fontSize: '12px' }}
                onClick={() => { setRejectingId(null); setRejectReason(''); }}
              >
                Keep it pending
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                className="btn btn-secondary"
                style={{ padding: '7px 14px', fontSize: '12px' }}
                onClick={() => { setRejectingId(r.id); setRejectReason(''); }}
              >
                Reject…
              </button>
              <button
                className="btn btn-primary"
                disabled={approve.isPending}
                onClick={() => onApprove(r)}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', fontSize: '12px' }}
              >
                <CheckCircle2 size={13} /> Approve…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const DecidedRow: React.FC<{ r: DestructiveActionRequest }> = ({ r }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '7px', padding: '11px 2px', borderBottom: '1px solid var(--border-hair, var(--border-color))' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '12.5px', color: 'var(--text-primary)', fontWeight: 600 }}>
          {r.requestedByName ?? 'A developer'} · {r.domainKeys.map(prettyDomain).join(', ')}
        </div>
        <StatusPill status={r.status} />
      </div>
      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Requested {new Date(r.requestedAt).toLocaleString()}
        {r.decidedAt && <> · decided by {r.decidedByName ?? 'an administrator'} {new Date(r.decidedAt).toLocaleString()}</>}
        {r.status === DestructiveActionRequestStatus.REJECTED && r.decisionReason && <> — “{r.decisionReason}”</>}
        {r.status === DestructiveActionRequestStatus.APPROVED && r.expiresAt && <> · executable until {new Date(r.expiresAt).toLocaleString()}</>}
        {r.status === DestructiveActionRequestStatus.EXECUTED && r.executedAt && <> · executed {new Date(r.executedAt).toLocaleString()}</>}
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '900px', margin: '0 auto' }}>
      {confirmDialog}
      <PageHeader
        icon={<ShieldCheck size={20} />}
        title="Approvals"
        subtitle="Destructive actions need two people: a developer requests, an administrator decides here, and only then can the developer execute. Approvals expire on their own if unused."
      />

      {!canDecide && (
        <div style={{ ...card, display: 'flex', gap: '10px', alignItems: 'flex-start', fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <Info size={15} style={{ flexShrink: 0, marginTop: '1px', color: 'var(--text-muted)' }} />
          <span>
            You can read this queue, but approvals need the Admin role held directly — implication
            does not count here, because the person who files a wipe request must not be the person
            who approves it. Your own requests are decided by an administrator.
          </span>
        </div>
      )}

      {isLoading ? (
        <div style={{ ...card, textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
      ) : isError ? (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start', color: 'var(--danger)', fontSize: '13px' }}>
          <div>Couldn&apos;t load the approval queue. {userMessage(error)}</div>
          <button className="btn btn-secondary" style={{ padding: '6px 14px', fontSize: '12px' }} onClick={() => refetch()}>Try again</button>
        </div>
      ) : (
        <>
          {pending.length === 0 ? (
            <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '9px', color: 'var(--success, #34a853)', fontWeight: 700, fontSize: '13.5px' }}>
              <ShieldCheck size={17} /> Nothing is waiting for a decision.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {pending.map((r) => <PendingRow key={r.id} r={r} />)}
            </div>
          )}

          {decided.length > 0 && (
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 700, marginBottom: '4px' }}>
                <Trash2 size={14} style={{ color: 'var(--text-muted)' }} /> Recently decided
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {decided.map((r) => <DecidedRow key={r.id} r={r} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default Approvals;
