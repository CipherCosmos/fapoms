import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, Lock, Map, RefreshCw,
  CheckCircle2, Inbox, Layers, CalendarClock, Users, ClipboardCheck,
  Send, IndianRupee, Activity as ActivityIcon, FolderKanban, Wallet,
  FileText, GitMerge,
} from 'lucide-react';
import { api } from '../services/api';
import { AppError } from '../services/errors';
import { canAccessRoute, defaultRouteFor } from '../config/route-permissions';
import { useCurrentPermissions, useCurrentRoles } from '../hooks/useCurrentRoles';
import { queryClient } from '../queryClient';
import { queryKeys } from '../hooks/queryKeys';
import { useScope, withScope } from '../context/ScopeContext';
import { formatRupees as money, activityEventLabel } from '@fapoms/shared';
import { HBarChart, DonutChart, StackedColumnChart, type HBarDatum, type ColumnDatum } from '../components/charts';

interface Attention {
  key: string; severity: 'critical' | 'high' | 'medium';
  count: number; label: string; detail: string; link: string; isMoney?: boolean;
}
interface DueItem {
  projectBranchId: string; branchName: string; district: string | null; state: string;
  scheduledDate: string; daysAway: number;
  hasAssayer: boolean; packetSent: boolean;
  blocker: 'NO_ASSAYER' | 'PACKET_NOT_SENT' | null;
}
interface Validation {
  pending: number; inReview: number; needsCorrection: number;
  assignedToMe: number; openQueries: number; overdueQueries: number;
}
/**
 * Sections the caller's roles do not include arrive as null. Rendering is driven
 * by that rather than by a role check in the client, so the page cannot show a
 * block the server declined to populate.
 */
interface Snapshot {
  generatedAt: string;
  roles: string[];
  focus: string;
  sections: string[];
  attention: Attention[];
  funnel: Array<{ key: string; label: string; count: number; packets: number }> | null;
  due: DueItem[] | null;
  documents: { packetsUnsent: number; awaitingReturn: number; awaitingOcr: number; inOcr: number } | null;
  money: { unbilled: number; outstanding: number; collected: number } | null;
  capacity: { assayers: number; idle: number; dailyCapacity: number } | null;
  validation: Validation | null;
  projects: Array<{
    id: string; name: string; projectNumber: string; status: string; clientName: string;
    totalBranches: number; audited: number; unplanned: number; packets: number; progressPct: number;
  }> | null;
  activities: Array<{ id: string; action: string; detail: string | null; occurredAt: string }> | null;
}

const SEVERITY: Record<Attention['severity'], string> = {
  critical: 'var(--danger)', high: 'var(--warning)', medium: 'var(--accent)',
};

const BLOCKER_TEXT: Record<string, string> = {
  NO_ASSAYER: 'no assayer confirmed',
  PACKET_NOT_SENT: 'packet not released',
};

type Tone = 'danger' | 'warning' | 'success' | 'accent' | 'muted';
const TONE: Record<Tone, string> = {
  danger: 'var(--danger)', warning: 'var(--warning)', success: 'var(--success)',
  accent: 'var(--accent)', muted: 'var(--text-muted)',
};

interface Kpi {
  key: string; label: string; value: string; sub: string;
  tone: Tone; icon: React.ReactNode; onClick?: () => void;
}

/**
 * Operational home.
 *
 * The previous dashboard led with counts of clients, users and branches — master
 * data that does not change day to day and that nobody acts on. This one leads with a
 * scannable strip of the handful of numbers that decide the day, then everything that
 * needs a decision, ordered by urgency, each linking to where the work happens.
 *
 * Every figure on this page comes from one server snapshot (`/system-dashboard/operations`);
 * nothing is invented in the client. Sections the caller's role cannot see arrive null and
 * simply do not render — the KPI strip below is built the same way, tile by tile, so it never
 * shows a headline for data the server withheld.
 */
export const Dashboard: React.FC = () => {
  const navigate = useNavigate();

  // The territorial sections (funnel, due, capacity, projects) follow the header's global
  // scope; documents/validation/money stay national — see OperationsSnapshotService.
  const { scopeParams, scopeKey } = useScope();
  const roles = useCurrentRoles();
  const permissions = useCurrentPermissions();

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: [...queryKeys.dashboard.all, 'operations', scopeKey],
    queryFn: () => api.request<Snapshot>(`/system-dashboard/operations?${withScope(scopeParams)}`),
    staleTime: 30_000,
  });

  /**
   * A 403 here is an answer, not a fault: the snapshot spans every project, and a role scoped to
   * one desk is refused it by design. Told apart from a real outage so the page can say which.
   */
  const isNotEntitled = error instanceof AppError && error.status === 403;
  const landing = defaultRouteFor(roles, permissions);

  const dueSoon = (data?.due ?? []).filter((d) => d.daysAway >= 0).slice(0, 8);
  /**
   * Asked of the route table rather than answered again here. The hand-kept copy of the role list
   * had drifted — it named ADMIN twice, a leftover of the consolidation that merged two admin
   * roles into one — and being a second copy it could not see a role built in Admin → Roles at
   * all, so a coordinator on a database role was denied a button to a page they could open.
   */
  const canSeeCommandCenter = canAccessRoute(roles, permissions, '/executive-map');

  // ── The headline strip: at most five numbers that decide the day ───────────
  // Each tile is pushed only when the server sent the section behind it, so the strip
  // respects the same role gating as the rest of the page.
  const kpis: Kpi[] = [];
  if (data?.due) {
    const week = data.due.filter((d) => d.daysAway >= 0 && d.daysAway <= 6);
    const blocked = week.filter((d) => d.blocker).length;
    kpis.push({
      key: 'due', label: 'Audits due this week', value: String(week.length),
      sub: blocked > 0 ? `${blocked} not ready to go` : week.length ? 'all ready' : 'nothing scheduled',
      tone: blocked > 0 ? 'warning' : 'success', icon: <CalendarClock size={18} />,
      onClick: () => navigate('/scheduling'),
    });
  }
  if (data?.capacity) {
    kpis.push({
      key: 'free', label: 'Assayers free today', value: String(data.capacity.idle),
      sub: `of ${data.capacity.assayers} on the roster · ${data.capacity.dailyCapacity}/day capacity`,
      tone: data.capacity.idle > 0 ? 'accent' : 'muted', icon: <Users size={18} />,
      onClick: () => navigate('/hr/roster'),
    });
  }
  if (data?.validation) {
    const open = data.validation.pending + data.validation.inReview + data.validation.needsCorrection;
    kpis.push({
      key: 'cases', label: 'Audits to check', value: String(open),
      sub: data.validation.overdueQueries > 0
        ? `${data.validation.overdueQueries} clarification${data.validation.overdueQueries === 1 ? '' : 's'} overdue`
        : 'no clarifications overdue',
      tone: data.validation.overdueQueries > 0 ? 'danger' : data.validation.needsCorrection > 0 ? 'warning' : 'accent',
      icon: <ClipboardCheck size={18} />, onClick: () => navigate('/data-entry'),
    });
  }
  if (data?.documents) {
    kpis.push({
      key: 'packets', label: 'Packets to send', value: String(data.documents.packetsUnsent),
      sub: `${data.documents.awaitingReturn} out with assayers`,
      tone: data.documents.packetsUnsent > 0 ? 'warning' : 'success', icon: <Send size={18} />,
      onClick: () => navigate('/documents'),
    });
  }
  if (data?.money) {
    kpis.push({
      key: 'outstanding', label: 'Outstanding', value: money(data.money.outstanding),
      sub: data.money.unbilled > 0 ? `${money(data.money.unbilled)} still unbilled` : 'all work billed',
      tone: data.money.outstanding > 0 ? 'accent' : 'success', icon: <IndianRupee size={18} />,
      onClick: () => navigate('/billing'),
    });
  }

  // ── Chart data, derived from the same snapshot ─────────────────────────────

  const funnelBars: HBarDatum[] = (data?.funnel ?? [])
    .filter((f) => f.count > 0)
    .map((f) => ({
      key: f.key, label: f.label, value: f.count, color: 'var(--accent-primary)',
      sublabel: `${f.packets.toLocaleString('en-IN')} packets`,
    }));

  const today = new Date();
  const dueByDay: ColumnDatum[] = Array.from({ length: 8 }, (_, i) => {
    const items = (data?.due ?? []).filter((d) => d.daysAway === i);
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    return {
      key: String(i),
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : date.toLocaleDateString(undefined, { weekday: 'short' }),
      segments: [
        { key: 'ready', label: 'Ready', value: items.filter((d) => !d.blocker).length, color: 'var(--success)' },
        { key: 'blocked', label: 'Not ready', value: items.filter((d) => !!d.blocker).length, color: 'var(--warning)' },
      ],
    };
  });

  const validationSegments = data?.validation ? [
    { key: 'pending', label: 'Pending', value: data.validation.pending, color: 'var(--accent-secondary)' },
    { key: 'inReview', label: 'In review', value: data.validation.inReview, color: 'var(--accent-primary)' },
    { key: 'needsCorrection', label: 'Needs correction', value: data.validation.needsCorrection, color: 'var(--warning)' },
  ] : [];

  const capacitySegments = data?.capacity ? [
    { key: 'loaded', label: 'Loaded', value: Math.max(data.capacity.assayers - data.capacity.idle, 0), color: 'var(--success)' },
    { key: 'idle', label: 'Idle', value: data.capacity.idle, color: 'var(--text-muted)' },
  ] : [];

  const documentBars: HBarDatum[] = data?.documents ? [
    { key: 'unsent', label: 'Packets unsent', value: data.documents.packetsUnsent, color: 'var(--warning)' },
    { key: 'withAssayers', label: 'With assayers', value: data.documents.awaitingReturn, color: 'var(--accent-primary)' },
    { key: 'awaitingOcr', label: 'Awaiting OCR', value: data.documents.awaitingOcr, color: 'var(--accent-secondary)' },
    { key: 'inOcr', label: 'In OCR', value: data.documents.inOcr, color: 'var(--success)' },
  ] : [];

  const moneyBars: HBarDatum[] = data?.money ? [
    { key: 'unbilled', label: 'Unbilled', value: data.money.unbilled, color: 'var(--warning)', formattedValue: money(data.money.unbilled) },
    { key: 'outstanding', label: 'Outstanding', value: data.money.outstanding, color: 'var(--accent-secondary)', formattedValue: money(data.money.outstanding) },
    { key: 'collected', label: 'Collected', value: data.money.collected, color: 'var(--success)', formattedValue: money(data.money.collected) },
  ] : [];

  const projectBars: HBarDatum[] = (data?.projects ?? [])
    .slice()
    .sort((a, b) => a.progressPct - b.progressPct)
    .slice(0, 8)
    .map((p) => ({
      key: p.id, label: p.name, value: p.progressPct,
      color: p.progressPct < 34 ? 'var(--warning)' : 'var(--accent-primary)',
      formattedValue: `${p.progressPct}%`, sublabel: p.clientName,
      onClick: () => navigate(`/planning?projectId=${p.id}`),
    }));

  const updatedAt = data?.generatedAt
    ? new Date(data.generatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <DashboardStyles />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 22, fontWeight: 800, margin: 0, fontFamily: 'var(--font-display)' }}>Operations</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '4px 0 0' }}>
            {data?.focus ?? 'What needs doing, what’s at risk, and where the book stands.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {updatedAt && (
            <span title="Figures refresh automatically" style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600,
              color: 'var(--text-muted)', padding: '5px 11px', borderRadius: 'var(--radius-full)',
              background: 'var(--bg-secondary)', border: '1px solid var(--border-hair)',
            }}>
              <span className={isFetching ? 'dash-live-dot dash-live-dot--busy' : 'dash-live-dot'} />
              {isFetching ? 'Updating…' : `Updated ${updatedAt}`}
            </span>
          )}
          <button onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all })}
            className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <RefreshCw size={14} className={isFetching ? 'dash-spin' : undefined} /> Refresh
          </button>
          {canSeeCommandCenter && (
            <button onClick={() => navigate('/executive-map')} className="btn btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600 }}>
              <Map size={14} /> Command Center <ArrowRight size={13} />
            </button>
          )}
        </div>
      </div>

      {isLoading && <DashboardSkeleton />}

      {error && (isNotEntitled ? (
        /**
         * Refused, not broken — and they are different things to the person reading the screen.
         *
         * Every failure used to render "Could not load the operational snapshot" with a Retry
         * button. For someone whose role simply does not include these figures, that button could
         * only ever fail in exactly the same way, so the page read as an outage and generated a
         * support call for a decision somebody had made on purpose. This says what is true, and
         * offers the one thing that does help: the page they can use.
         */
        <div style={{ padding: 14, background: 'var(--bg-secondary)', border: '1px solid var(--border-hair)', borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, lineHeight: 1.5 }}>
            <Lock size={15} style={{ flexShrink: 0 }} />
            These figures are not part of your access. They cover work across every project, and
            your account has not been given that. Ask an administrator if you need it.
          </span>
          {landing !== '/dashboard' && (
            <button onClick={() => navigate(landing)} className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: 12, whiteSpace: 'nowrap' }}>
              Go to my start page
            </button>
          )}
        </div>
      ) : (
        <div style={{ padding: 14, background: 'var(--status-cancelled-bg)', border: '1px solid var(--danger)', borderRadius: 'var(--radius-md)', color: 'var(--danger)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><AlertTriangle size={15} /> Could not load the operational snapshot.</span>
          <button onClick={() => refetch()} className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: 12 }}>Retry</button>
        </div>
      ))}

      {data && (
        <>
          {/* 0. Headline strip — the day in five numbers. */}
          {kpis.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(198px, 1fr))', gap: 14 }}>
              {kpis.map((k) => <KpiTile key={k.key} kpi={k} />)}
            </div>
          )}

          {/* 1. Needs attention — the only section that should change hour to hour. */}
          <div>
            <SectionLabel icon={<AlertTriangle size={13} />}>Needs attention</SectionLabel>
            {data.attention.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '15px 17px', background: 'var(--status-active-bg)', border: '1px solid color-mix(in srgb, var(--success) 40%, transparent)', borderRadius: 'var(--radius-md)', color: 'var(--success)', fontSize: 13, fontWeight: 500 }}>
                <CheckCircle2 size={17} /> Nothing blocked. No audits at risk, no paperwork waiting, nothing unbilled.
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(262px, 1fr))', gap: 12 }}>
                {data.attention.map((a) => {
                  const c = SEVERITY[a.severity];
                  return (
                    <button key={a.key} onClick={() => navigate(a.link)} className="dash-attention"
                      style={{
                        textAlign: 'left', cursor: 'pointer', background: 'var(--bg-secondary)',
                        border: `1px solid color-mix(in srgb, ${c} 28%, transparent)`, borderLeft: `3px solid ${c}`,
                        borderRadius: 'var(--radius-md)', padding: '13px 15px', color: 'var(--text-primary)',
                      }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: c, fontSize: 11.5, fontWeight: 700 }}>
                        <AlertTriangle size={13} />{a.label}
                        <ArrowRight size={13} style={{ marginLeft: 'auto', opacity: 0.6 }} />
                      </div>
                      <div style={{ fontSize: 23, fontWeight: 800, marginTop: 6, fontFamily: 'var(--font-display)' }}>
                        {a.isMoney ? money(a.count) : a.count}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45 }}>{a.detail}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 2. The week ahead + where the book is piling up. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
            {data.due && (
              <ChartCard title="Audits due — next 7 days" icon={<CalendarClock size={15} />}>
                <StackedColumnChart data={dueByDay} legend={[
                  { key: 'ready', label: 'Ready', color: 'var(--success)' },
                  { key: 'blocked', label: 'Not ready', color: 'var(--warning)' },
                ]} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginTop: 4 }}>
                  {dueSoon.length === 0 ? (
                    <EmptyLine>No audits scheduled in the next week.</EmptyLine>
                  ) : dueSoon.map((d) => (
                    <div key={d.projectBranchId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-hair)', flexWrap: 'wrap' }}>
                      <span style={{
                        fontSize: 10.5, fontWeight: 700, minWidth: 58, textAlign: 'center',
                        padding: '2px 7px', borderRadius: 'var(--radius-sm)',
                        background: d.daysAway === 0 ? 'var(--status-cancelled-bg)' : 'var(--bg-tertiary)',
                        color: d.daysAway === 0 ? 'var(--danger)' : 'var(--text-secondary)',
                      }}>
                        {d.daysAway === 0 ? 'today' : d.daysAway === 1 ? 'tomorrow' : `${d.daysAway}d`}
                      </span>
                      <span style={{ flex: 1, minWidth: 130, fontSize: 12.5 }}>
                        <strong>{d.branchName}</strong>
                        <span style={{ color: 'var(--text-muted)' }}> · {d.district}</span>
                      </span>
                      {d.blocker ? (
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--warning)', whiteSpace: 'nowrap' }}>
                          {BLOCKER_TEXT[d.blocker]}
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 700, color: 'var(--success)' }}>
                          <CheckCircle2 size={11} /> ready
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </ChartCard>
            )}

            {data.funnel && (
              <ChartCard title="Branches by status" icon={<GitMerge size={15} />}>
                {funnelBars.length === 0 ? (
                  <EmptyLine>No branches yet. Once branches are added to a project, this chart shows how many are at each stage of the audit.</EmptyLine>
                ) : (
                  <HBarChart data={funnelBars} valueColumnWidth={72} />
                )}
              </ChartCard>
            )}
          </div>

          {/* 3. Validation composition + cross-cutting callouts. */}
          {data.validation && (
            <div>
              <SectionLabel icon={<ClipboardCheck size={13} />}>Audits waiting to be checked</SectionLabel>
              <div className="glass-card" style={{ padding: 18, display: 'flex', gap: 26, flexWrap: 'wrap', alignItems: 'center' }}>
                {validationSegments.every((s) => s.value === 0) ? (
                  <EmptyLine>Nothing in the queue — every audit has been checked.</EmptyLine>
                ) : (
                  <DonutChart
                    segments={validationSegments.map((s) => ({ ...s, onClick: () => navigate('/data-entry') }))}
                    centerLabel="Open cases" centerValue={String(data.validation.pending + data.validation.inReview + data.validation.needsCorrection)}
                  />
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minWidth: 190 }}>
                  <Stat icon={<Inbox size={15} />} label="Assigned to you" value={String(data.validation.assignedToMe)}
                        sub="cases where you are the reviewer" color="var(--accent)" onClick={() => navigate('/data-entry')} />
                  <Stat icon={<AlertTriangle size={15} />} label="Open clarifications" value={String(data.validation.openQueries)}
                        sub={data.validation.overdueQueries > 0 ? `${data.validation.overdueQueries} past deadline` : 'none overdue'}
                        color={data.validation.overdueQueries ? 'var(--danger)' : 'var(--success)'} onClick={() => navigate('/data-entry')} />
                </div>
              </div>
            </div>
          )}

          {/* 4. Standing position — checked occasionally, not hourly. */}
          {(data.capacity || data.documents || data.money) && (
            <div>
              <SectionLabel icon={<Layers size={13} />}>Standing position</SectionLabel>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
                {data.capacity && (
                  <ChartCard title="Assayers available" icon={<Users size={15} />} center>
                    <DonutChart
                      segments={capacitySegments.map((s) => ({ ...s, onClick: () => navigate('/hr/roster') }))}
                      centerLabel="capacity / day" centerValue={String(data.capacity.dailyCapacity)}
                    />
                  </ChartCard>
                )}
                {data.documents && (
                  <ChartCard title="Documents by stage" icon={<FileText size={15} />}>
                    <HBarChart data={documentBars} valueColumnWidth={56} />
                  </ChartCard>
                )}
                {data.money && (
                  <ChartCard title="Money billed and received" icon={<Wallet size={15} />}>
                    <HBarChart data={moneyBars} valueColumnWidth={104} />
                  </ChartCard>
                )}
              </div>
            </div>
          )}

          {/* 5. Projects — real progress, counted server-side. */}
          {data.projects && (
            <div>
              <SectionLabel icon={<FolderKanban size={13} />}>Projects</SectionLabel>
              {projectBars.length > 0 && (
                <ChartCard
                  title={`Progress by project${data.projects.length > projectBars.length ? ` — lowest ${projectBars.length} of ${data.projects.length}` : ''}`}
                  icon={<Layers size={15} />}
                >
                  <HBarChart data={projectBars} maxValue={100} valueColumnWidth={48} />
                </ChartCard>
              )}
              <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
                {data.projects.length === 0 && <EmptyLine>No active projects.</EmptyLine>}
                {data.projects.map((p) => (
                  <button type="button" key={p.id} className="dash-project" style={{ display: 'block', width: '100%', textAlign: 'left', font: 'inherit', background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', borderRadius: 'var(--radius-sm)' }} onClick={() => navigate(`/planning?projectId=${p.id}`)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>
                        {p.name} <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }}>{p.projectNumber}</span>
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {p.clientName} · <strong style={{ color: 'var(--text-primary)' }}>{p.progressPct}%</strong> audited
                      </span>
                    </div>
                    <div style={{ height: 7, background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-full)', overflow: 'hidden', margin: '7px 0 5px' }}>
                      <div style={{ width: `${p.progressPct}%`, height: '100%', borderRadius: 'var(--radius-full)', background: p.progressPct < 34 ? 'var(--warning)' : 'var(--gradient-neon, var(--success))', transition: 'width 0.5s cubic-bezier(0.4,0,0.2,1)' }} />
                    </div>
                    <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                      <span><Layers size={10} style={{ display: 'inline', verticalAlign: '-1px' }} /> {p.totalBranches} branches</span>
                      <span>{p.packets.toLocaleString('en-IN')} packets</span>
                      <span>{p.audited} audited</span>
                      {p.unplanned > 0 && <span style={{ color: 'var(--warning)' }}>{p.unplanned} not yet planned</span>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 6. Activity */}
          {data.activities && data.activities.length > 0 && (
            <div>
              <SectionLabel icon={<ActivityIcon size={13} />}>Recent activity</SectionLabel>
              <div className="glass-card" style={{ padding: 16, maxHeight: 240, overflowY: 'auto' }}>
                {data.activities.map((a) => (
                  <div key={a.id} style={{ display: 'flex', gap: 10, padding: '6px 0', fontSize: 12, alignItems: 'baseline' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-secondary)', flexShrink: 0, transform: 'translateY(-1px)' }} />
                    <span style={{ fontWeight: 600, minWidth: 0 }}>{activityEventLabel(a.action)}</span>
                    {a.detail && <span style={{ color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.detail}</span>}
                    <span style={{ color: 'var(--text-muted)', fontSize: 10.5, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                      {new Date(a.occurredAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ── Presentational helpers ───────────────────────────────────────────────────

/**
 * A single headline number. The icon sits in a tinted chip in its tone colour, the value is the
 * biggest thing on the tile, and the whole card is one click-through to where that number is
 * worked. Tone is semantic, never decorative: a warning tone means "there is something to do",
 * not "this is a big number" — see how the KPIs above pick their tone from the underlying state.
 */
const KpiTile: React.FC<{ kpi: Kpi }> = ({ kpi }) => {
  const c = TONE[kpi.tone];
  return (
    <button
      onClick={kpi.onClick}
      className="dash-kpi"
      style={{
        textAlign: 'left', cursor: kpi.onClick ? 'pointer' : 'default',
        background: 'var(--bg-secondary)', border: '1px solid var(--border-hair)',
        borderRadius: 'var(--radius-lg)', padding: '15px 16px', color: 'var(--text-primary)',
        position: 'relative', overflow: 'hidden', ['--kpi-tone' as any]: c,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 34, height: 34, borderRadius: 'var(--radius-md)', color: c,
          background: `color-mix(in srgb, ${c} 14%, transparent)`,
        }}>{kpi.icon}</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', lineHeight: 1.25 }}>
          {kpi.label}
        </span>
      </div>
      <div style={{ fontSize: 27, fontWeight: 800, fontFamily: 'var(--font-display)', lineHeight: 1.05, letterSpacing: '-0.3px' }}>
        {kpi.value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>{kpi.sub}</div>
    </button>
  );
};

/**
 * Titled card chrome, so every panel on the page shares one shape (icon · title, then the body)
 * rather than the older label-floating-above-a-card pattern that read as a stack of loose pieces.
 */
const ChartCard: React.FC<{ title: string; icon?: React.ReactNode; action?: React.ReactNode; center?: boolean; children: React.ReactNode }> = ({ title, icon, action, center, children }) => (
  <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, height: '100%' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {icon && <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>{icon}</span>}
      <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
      {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
    </div>
    <div style={{ display: center ? 'flex' : 'block', justifyContent: 'center', flex: 1 }}>{children}</div>
  </div>
);

const Stat: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string; color: string; onClick?: () => void }> = ({ icon, label, value, sub, color, onClick }) => (
  <button onClick={onClick} className="dash-stat" style={{
    textAlign: 'left', cursor: onClick ? 'pointer' : 'default', background: 'var(--bg-secondary)',
    border: '1px solid var(--border-hair)', borderLeft: `3px solid ${color}`,
    borderRadius: 'var(--radius-md)', padding: '13px 15px', color: 'var(--text-primary)',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', fontWeight: 700 }}>
      <span style={{ color }}>{icon}</span>{label}
    </div>
    <div style={{ fontSize: 20, fontWeight: 800, marginTop: 5, fontFamily: 'var(--font-display)' }}>{value}</div>
    {sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
  </button>
);

const SectionLabel: React.FC<{ icon?: React.ReactNode; children: React.ReactNode }> = ({ icon, children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.9px', color: 'var(--text-muted)', marginBottom: 10 }}>
    {icon && <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>{icon}</span>}
    {children}
  </div>
);

const EmptyLine: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>{children}</div>
);

/**
 * Shown while the first snapshot loads. It mirrors the real layout (a KPI strip and two panels)
 * so the page keeps its shape instead of collapsing to a single line of text and then jumping —
 * a calmer load than a bare spinner, and it tells the eye where things are about to appear.
 */
const DashboardSkeleton: React.FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(198px, 1fr))', gap: 14 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="glass-card" style={{ padding: '15px 16px' }}>
          <div className="dash-shimmer" style={{ width: 34, height: 34, borderRadius: 'var(--radius-md)', marginBottom: 11 }} />
          <div className="dash-shimmer" style={{ width: '62%', height: 24, borderRadius: 6 }} />
          <div className="dash-shimmer" style={{ width: '84%', height: 11, borderRadius: 5, marginTop: 9 }} />
        </div>
      ))}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="glass-card" style={{ padding: 16 }}>
          <div className="dash-shimmer" style={{ width: '40%', height: 13, borderRadius: 5 }} />
          <div className="dash-shimmer" style={{ width: '100%', height: 120, borderRadius: 8, marginTop: 14 }} />
        </div>
      ))}
    </div>
  </div>
);

/** Component-scoped keyframes + hover polish, injected once. Keeps the visual behaviour with the
 *  code that uses it rather than scattering it into the global stylesheet. */
const DashboardStyles: React.FC = () => (
  <style>{`
    .dash-kpi, .dash-attention, .dash-stat, .dash-project { transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease, background-color .15s ease; }
    .dash-kpi:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--kpi-tone) 55%, var(--border-hair)); box-shadow: var(--shadow-md); }
    .dash-attention:hover, .dash-stat:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); }
    .dash-project:hover { background: var(--bg-secondary); }
    .dash-spin { animation: spin 0.9s linear infinite; }
    .dash-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 0 color-mix(in srgb, var(--success) 60%, transparent); }
    .dash-live-dot--busy { background: var(--accent); animation: dashPulse 1.1s ease-in-out infinite; }
    @keyframes dashPulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); } 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
    .dash-shimmer { background: linear-gradient(90deg, var(--bg-tertiary) 25%, var(--bg-secondary) 37%, var(--bg-tertiary) 63%); background-size: 400% 100%; animation: dashShimmer 1.4s ease infinite; }
    @keyframes dashShimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
    @media (prefers-reduced-motion: reduce) { .dash-kpi:hover, .dash-attention:hover, .dash-stat:hover { transform: none; } .dash-spin, .dash-live-dot--busy, .dash-shimmer { animation: none; } }
  `}</style>
);
