import React, { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, Building2, Phone, FileCheck, AlertTriangle, Plus, Check } from 'lucide-react';
import {
  EmpanelmentStatus, BackgroundCheckVerdict, RiskGrade, CibilBand,
  ONBOARDING_DOCUMENT_LABELS,
} from '@fapoms/shared';

import { api } from '../../services/api';
import { Select, Modal, useConfirm, useToast } from '../../components/ui';
import { card, label, Empty, Table } from './hr-ui';
import { fmtDate } from '../../utils/dates';
import { userMessage } from '../../services/errors';
import { counted } from '../../utils/plural';

/**
 * May we send this person out, and to whom.
 *
 * Four things answer that together and they used to be columns on one spreadsheet row: who
 * vouched for them, what the background check found, which banks accept them, and whether their
 * joining paperwork is actually in the building. Splitting them across four tabs would mean
 * asking one question four times, so they share this one.
 *
 * The order is the order the question is asked in. Vetting first, because an adverse finding
 * ends the conversation regardless of what the other three say. Then standing, which is per
 * client and is the operative answer for planning. References and paperwork last: they are how
 * the first two got their grounds.
 */

const VERDICT_LABELS: Record<string, string> = {
  [BackgroundCheckVerdict.CLEAR]: 'Clear',
  [BackgroundCheckVerdict.CRIMINAL_CASE]: 'Criminal case',
  [BackgroundCheckVerdict.CIVIL_CASE]: 'Civil case',
  [BackgroundCheckVerdict.ADVERSE_FINDING]: 'Adverse finding',
  [BackgroundCheckVerdict.NOT_CHECKED]: 'Not checked',
};

/**
 * A verdict is not a status badge; it is a decision about somebody's livelihood and access to a
 * vault. Only two colours are used — the ordinary one and the one that means stop — because a
 * five-colour scale invites reading "civil case" as merely worse than "clear" rather than as a
 * thing a person has to look at.
 */
const verdictTone = (v?: string | null): string =>
  v === BackgroundCheckVerdict.CRIMINAL_CASE || v === BackgroundCheckVerdict.ADVERSE_FINDING
    ? 'var(--danger)'
    : v === BackgroundCheckVerdict.CIVIL_CASE
      ? 'var(--warning)'
      : 'var(--text-primary)';

const RISK_LABELS: Record<string, string> = {
  [RiskGrade.LOW]: 'Low risk', [RiskGrade.MEDIUM]: 'Medium risk',
  [RiskGrade.HIGH]: 'High risk', [RiskGrade.VERY_HIGH]: 'Very high risk',
};

const CIBIL_LABELS: Record<string, string> = {
  [CibilBand.GOOD]: 'Good', [CibilBand.AVERAGE]: 'Average', [CibilBand.POOR]: 'Poor',
  [CibilBand.BAD]: 'Bad', [CibilBand.NO_CREDIT_HISTORY]: 'No credit history',
  [CibilBand.NOT_CHECKED]: 'Not checked', [CibilBand.CHECK_FAILED]: 'Check failed',
};

const STANDING_LABELS: Record<string, string> = {
  [EmpanelmentStatus.ACTIVE]: 'Active',
  [EmpanelmentStatus.RECOMMENDED]: 'Recommended',
  [EmpanelmentStatus.NOT_RECOMMENDED]: 'Not recommended',
  [EmpanelmentStatus.DOCUMENTS_PENDING]: 'Documents pending',
  [EmpanelmentStatus.REJECTED]: 'Rejected',
  [EmpanelmentStatus.RESIGNED]: 'Resigned',
  [EmpanelmentStatus.TERMINATED]: 'Terminated',
};

/** Which standings mean "do not plan them for this client". */
const BLOCKING_STANDINGS = new Set<string>([
  EmpanelmentStatus.NOT_RECOMMENDED, EmpanelmentStatus.REJECTED,
  EmpanelmentStatus.RESIGNED, EmpanelmentStatus.TERMINATED,
]);

interface Dossier {
  references: any[];
  empanelments: any[];
  backgroundChecks: any[];
  currentCheck: any | null;
  onboarding: any[];
  openIssues: any[];
}

const Section: React.FC<{
  title: string; icon: React.ElementType; hint?: string; action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, icon: Icon, hint, action, children }) => (
  <div style={{ ...card, marginBottom: '14px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: hint ? '4px' : '10px' }}>
      <Icon size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      <div style={{ ...label, flex: 1 }}>{title}</div>
      {action}
    </div>
    {hint && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>{hint}</div>}
    {children}
  </div>
);

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 9px', fontSize: '12.5px',
  background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', borderRadius: '7px', fontFamily: 'inherit',
};

const Field: React.FC<{ title: string; children: React.ReactNode; wide?: boolean }> = ({ title, children, wide }) => (
  <div style={{ flex: wide ? '1 1 100%' : '1 1 150px', minWidth: 0 }}>
    <div style={{ ...label, marginBottom: '5px' }}>{title}</div>
    {children}
  </div>
);

const linkButton: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--primary)', fontSize: '12px', fontWeight: 600,
};

export const AssayerVettingTab: React.FC<{ assayerId: string; canManage: boolean }> = ({
  assayerId, canManage,
}) => {
  const [data, setData] = useState<Dossier | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [checkDraft, setCheckDraft] = useState<
    { verdict: string; riskGrade: string; cibilScore: string; cibilBand: string; checkedOn: string; findings: string } | null
  >(null);
  const [refDraft, setRefDraft] = useState<{ fullName: string; relationship: string; phone: string } | null>(null);
  const [standing, setStandingModal] = useState<
    { clientId: string; clientName: string; status: string; statusReason: string } | null
  >(null);
  const { confirm, confirmDialog } = useConfirm();
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    api.request<Dossier>(`/assayers/${assayerId}/dossier`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(userMessage(e)); });
    return () => { cancelled = true; };
  }, [assayerId, reloadKey]);

  // The client list is needed only to offer standings that do not exist yet, so it is fetched
  // alongside rather than blocking the dossier.
  useEffect(() => {
    let cancelled = false;
    api.request<any>('/clients?limit=200')
      .then((d) => {
        const rows = Array.isArray(d) ? d : (d?.items ?? d?.data ?? []);
        if (!cancelled) setClients(rows.map((c: any) => ({ id: c.id, name: c.name })));
      })
      .catch(() => { /* the existing standings still render; only "add" is unavailable */ });
    return () => { cancelled = true; };
  }, []);

  const reload = () => setReloadKey((k) => k + 1);

  const paperwork = useMemo(() => {
    const rows = data?.onboarding ?? [];
    // "In hand" means the hard copy is actually in the building. A soft copy is progress, not
    // completion — the file the roster tracks is a physical one.
    const inHand = rows.filter((r) => r.hardCopyReceived === true).length;
    const softOnly = rows.filter((r) => r.hardCopyReceived !== true && r.softCopyReceived === true).length;
    return { rows, inHand, softOnly, total: rows.length };
  }, [data]);

  const blocking = useMemo(
    () => (data?.empanelments ?? []).filter((e) => BLOCKING_STANDINGS.has(e.status)),
    [data],
  );

  const saveStanding = async () => {
    if (!standing) return;
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/empanelment/${standing.clientId}`, {
        method: 'PUT',
        body: JSON.stringify({ status: standing.status, statusReason: standing.statusReason || undefined }),
      });
      toast({
        type: 'success',
        title: 'Standing recorded',
        message: `${standing.clientName} — ${STANDING_LABELS[standing.status] ?? standing.status}.`,
      });
      setStandingModal(null);
      reload();
    } catch (e) { toast({ type: 'error', message: userMessage(e) }); } finally { setBusy(false); }
  };

  const saveCheck = async () => {
    if (!checkDraft) return;
    setBusy(true);
    try {
      const score = Number(checkDraft.cibilScore.replace(/[^\d]/g, ''));
      await api.request(`/assayers/${assayerId}/background-check`, {
        method: 'POST',
        body: JSON.stringify({
          verdict: checkDraft.verdict,
          riskGrade: checkDraft.riskGrade || undefined,
          cibilBand: checkDraft.cibilBand || undefined,
          cibilScore: Number.isFinite(score) && score > 0 ? score : undefined,
          checkedOn: checkDraft.checkedOn || undefined,
          findings: checkDraft.findings || undefined,
        }),
      });
      toast({ type: 'success', title: 'Check recorded', message: 'It is now the operative one; the previous check is kept below it.' });
      setCheckDraft(null);
      reload();
    } catch (e) { toast({ type: 'error', message: userMessage(e) }); } finally { setBusy(false); }
  };

  const saveReference = async () => {
    if (!refDraft) return;
    if (!refDraft.fullName.trim()) {
      toast({ type: 'error', message: 'A reference needs a name.' });
      return;
    }
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/reference`, {
        method: 'POST',
        body: JSON.stringify({
          fullName: refDraft.fullName.trim(),
          relationship: refDraft.relationship || undefined,
          phone: refDraft.phone || undefined,
        }),
      });
      toast({ type: 'success', title: 'Reference added', message: `${refDraft.fullName.trim()} is on file. Nobody has rung them yet.` });
      setRefDraft(null);
      reload();
    } catch (e) { toast({ type: 'error', message: userMessage(e) }); } finally { setBusy(false); }
  };

  const togglePaperwork = async (requirement: string, field: 'softCopyReceived' | 'hardCopyReceived', value: boolean) => {
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/onboarding-document/${requirement}`, {
        method: 'PUT', body: JSON.stringify({ [field]: value }),
      });
      reload();
    } catch (e) { toast({ type: 'error', message: userMessage(e) }); } finally { setBusy(false); }
  };

  const markChecked = async (ref: any) => {
    const ok = await confirm({
      title: `Record that ${ref.fullName} was spoken to?`,
      message: 'This stamps the reference with your name and today’s date. It says the call actually happened.',
      confirmLabel: 'Yes, I spoke to them',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.request(`/assayers/reference/${ref.id}/checked`, { method: 'POST', body: JSON.stringify({}) });
      reload();
    } catch (e) { toast({ type: 'error', message: userMessage(e) }); } finally { setBusy(false); }
  };

  if (err) return <div style={{ color: 'var(--danger)', fontSize: '13px', padding: '16px' }}>{err}</div>;
  if (!data) return <Empty>Loading…</Empty>;

  const check = data.currentCheck;
  const unstanded = clients.filter((c) => !data.empanelments.some((e) => e.clientId === c.id));

  return (
    <div style={{ opacity: busy ? 0.6 : 1, transition: 'opacity .15s' }}>
      {confirmDialog}

      {standing && (
        <Modal
          open
          onClose={() => setStandingModal(null)}
          title={`Standing with ${standing.clientName}`}
          width={480}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
              This decides whether {standing.clientName} will accept this person on their branches.
              It says nothing about any other client.
            </div>
            <div>
              <div style={{ ...label, marginBottom: '6px' }}>Standing</div>
              <Select
                value={standing.status}
                onChange={(v) => setStandingModal({ ...standing, status: String(v) })}
                options={Object.values(EmpanelmentStatus).map((v) => ({
                  value: v, label: STANDING_LABELS[v] ?? v,
                }))}
              />
            </div>
            <div>
              <div style={{ ...label, marginBottom: '6px' }}>Why (optional)</div>
              <textarea
                value={standing.statusReason}
                onChange={(e) => setStandingModal({ ...standing, statusReason: e.target.value })}
                rows={3}
                placeholder={BLOCKING_STANDINGS.has(standing.status)
                  ? 'What was the reason? This is the record of why they are not being sent.'
                  : 'Anything worth recording alongside this decision.'}
                style={{
                  width: '100%', padding: '8px 10px', fontSize: '13px', resize: 'vertical',
                  background: 'var(--bg-surface)', color: 'var(--text-primary)',
                  border: '1px solid var(--border-color)', borderRadius: '8px', fontFamily: 'inherit',
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={() => setStandingModal(null)} style={{ ...linkButton, color: 'var(--text-muted)' }}>
                Cancel
              </button>
              <button
                onClick={saveStanding}
                disabled={busy}
                style={{
                  background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '8px',
                  padding: '8px 16px', fontSize: '13px', fontWeight: 600, cursor: busy ? 'default' : 'pointer',
                }}
              >
                Save standing
              </button>
            </div>
          </div>
        </Modal>
      )}

      {data.openIssues.length > 0 && (
        <div style={{ ...card, marginBottom: '14px', borderColor: 'var(--warning)' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <AlertTriangle size={15} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>
                {counted(data.openIssues.length, 'cell')} from the roster import could not be read for this person.
              </strong>
              <div style={{ marginTop: '6px' }}>
                {data.openIssues.map((i) => (
                  <div key={i.id} style={{ marginBottom: '3px' }}>
                    <code style={{ fontSize: '11px' }}>{i.sourceColumn}</code>{' — '}
                    {i.reason} Original text: “{i.rawValue}”.
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <Section
        title="Vetting"
        icon={check && verdictTone(check.verdict) === 'var(--danger)' ? ShieldAlert : ShieldCheck}
        hint="The most recent check is the operative one. Earlier checks are kept below it, because a picture that changed is the reason to look at a second one."
        action={canManage && !checkDraft ? (
          <button style={linkButton} onClick={() => setCheckDraft({
            verdict: BackgroundCheckVerdict.CLEAR, riskGrade: '', cibilScore: '',
            cibilBand: '', checkedOn: '', findings: '',
          })}>
            <Plus size={11} style={{ verticalAlign: '-1px' }} /> Record a check
          </button>
        ) : undefined}
      >
        {checkDraft && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '14px', paddingBottom: '14px', borderBottom: '1px solid var(--border-hair)' }}>
            <Field title="Verdict">
              <Select
                value={checkDraft.verdict}
                onChange={(v) => setCheckDraft({ ...checkDraft, verdict: String(v) })}
                options={Object.values(BackgroundCheckVerdict).map((v) => ({ value: v, label: VERDICT_LABELS[v] ?? v }))}
              />
            </Field>
            <Field title="Risk">
              <Select
                value={checkDraft.riskGrade}
                onChange={(v) => setCheckDraft({ ...checkDraft, riskGrade: String(v) })}
                options={[{ value: '', label: 'Not graded' }, ...Object.values(RiskGrade).map((v) => ({ value: v, label: RISK_LABELS[v] ?? v }))]}
              />
            </Field>
            <Field title="Credit band">
              <Select
                value={checkDraft.cibilBand}
                onChange={(v) => setCheckDraft({ ...checkDraft, cibilBand: String(v) })}
                options={[{ value: '', label: 'Not recorded' }, ...Object.values(CibilBand).map((v) => ({ value: v, label: CIBIL_LABELS[v] ?? v }))]}
              />
            </Field>
            <Field title="Credit score">
              <input style={inputStyle} inputMode="numeric" placeholder="e.g. 747"
                value={checkDraft.cibilScore}
                onChange={(e) => setCheckDraft({ ...checkDraft, cibilScore: e.target.value })} />
            </Field>
            <Field title="Checked on">
              <input style={inputStyle} type="date"
                value={checkDraft.checkedOn}
                onChange={(e) => setCheckDraft({ ...checkDraft, checkedOn: e.target.value })} />
            </Field>
            <Field title="Findings" wide>
              <input style={inputStyle}
                placeholder="What the check actually turned up. Leave empty if it turned up nothing."
                value={checkDraft.findings}
                onChange={(e) => setCheckDraft({ ...checkDraft, findings: e.target.value })} />
            </Field>
            <div style={{ flexBasis: '100%', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button style={{ ...linkButton, color: 'var(--text-muted)' }} onClick={() => setCheckDraft(null)}>Cancel</button>
              <button onClick={saveCheck} disabled={busy} style={{
                background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '7px',
                padding: '7px 14px', fontSize: '12.5px', fontWeight: 600, cursor: busy ? 'default' : 'pointer',
              }}>Record check</button>
            </div>
          </div>
        )}
        {!check ? (
          <Empty>No background check has been recorded.</Empty>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px', marginBottom: data.backgroundChecks.length > 1 ? '12px' : 0 }}>
            <div>
              <div style={label}>Verdict</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: verdictTone(check.verdict) }}>
                {VERDICT_LABELS[check.verdict] ?? check.verdict}
              </div>
            </div>
            {check.riskGrade && (
              <div><div style={label}>Risk</div><div style={{ fontSize: '13px' }}>{RISK_LABELS[check.riskGrade] ?? check.riskGrade}</div></div>
            )}
            {check.cibilBand && (
              <div>
                <div style={label}>Credit</div>
                <div style={{ fontSize: '13px' }}>
                  {CIBIL_LABELS[check.cibilBand] ?? check.cibilBand}
                  {check.cibilScore ? ` (${check.cibilScore})` : ''}
                </div>
              </div>
            )}
            <div><div style={label}>Checked</div><div style={{ fontSize: '13px' }}>{fmtDate(check.checkedOn) || '—'}</div></div>
            {check.findings && (
              <div style={{ flexBasis: '100%' }}>
                <div style={label}>Findings</div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>{check.findings}</div>
              </div>
            )}
          </div>
        )}
        {data.backgroundChecks.length > 1 && (
          <Table
            head={['Date', 'Verdict', 'Risk', 'Findings']}
            rows={data.backgroundChecks.slice(1).map((c) => [
              fmtDate(c.checkedOn) || '—',
              <span style={{ color: verdictTone(c.verdict) }}>{VERDICT_LABELS[c.verdict] ?? c.verdict}</span>,
              c.riskGrade ? (RISK_LABELS[c.riskGrade] ?? c.riskGrade) : '—',
              c.findings || '—',
            ])}
          />
        )}
      </Section>

      <Section
        title="Client standing"
        icon={Building2}
        hint="Whether each bank accepts this person. One answer per client — being active for one says nothing about another."
      >
        {data.empanelments.length === 0 ? (
          <Empty>No client standing has been recorded.</Empty>
        ) : (
          <Table
            head={canManage ? ['Client', 'Standing', 'Decided', 'Why', ''] : ['Client', 'Standing', 'Decided', 'Why']}
            rows={data.empanelments.map((e) => {
              const cells: React.ReactNode[] = [
                e.client?.name ?? '—',
                <span style={{ fontWeight: 600, color: BLOCKING_STANDINGS.has(e.status) ? 'var(--danger)' : 'var(--text-primary)' }}>
                  {STANDING_LABELS[e.status] ?? e.status}
                </span>,
                fmtDate(e.decidedAt) || '—',
                e.statusReason || e.documentsOutstanding || '—',
              ];
              if (canManage) {
                cells.push(
                  <button style={linkButton} onClick={() => setStandingModal({ clientId: e.clientId, clientName: e.client?.name ?? 'this client', status: e.status, statusReason: e.statusReason ?? '' })}>
                    Change
                  </button>,
                );
              }
              return cells;
            })}
          />
        )}
        {canManage && unstanded.length > 0 && (
          <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No standing recorded for:</span>
            {unstanded.map((c) => (
              <button key={c.id} style={linkButton} onClick={() => setStandingModal({ clientId: c.id, clientName: c.name, status: EmpanelmentStatus.RECOMMENDED, statusReason: '' })}>
                <Plus size={11} style={{ verticalAlign: '-1px' }} /> {c.name}
              </button>
            ))}
          </div>
        )}
        {blocking.length > 0 && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--danger)' }}>
            Not to be planned for {blocking.map((e) => e.client?.name).filter(Boolean).join(', ')}.
          </div>
        )}
      </Section>

      <Section
        title="References"
        icon={Phone}
        hint="Who vouched for them, and whether anybody actually rang."
        action={canManage && !refDraft ? (
          <button style={linkButton} onClick={() => setRefDraft({ fullName: '', relationship: '', phone: '' })}>
            <Plus size={11} style={{ verticalAlign: '-1px' }} /> Add reference
          </button>
        ) : undefined}
      >
        {refDraft && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '14px', paddingBottom: '14px', borderBottom: '1px solid var(--border-hair)' }}>
            <Field title="Name">
              <input style={inputStyle} autoFocus value={refDraft.fullName}
                onChange={(e) => setRefDraft({ ...refDraft, fullName: e.target.value })} />
            </Field>
            <Field title="Relationship">
              <input style={inputStyle} placeholder="e.g. former manager" value={refDraft.relationship}
                onChange={(e) => setRefDraft({ ...refDraft, relationship: e.target.value })} />
            </Field>
            <Field title="Phone">
              <input style={inputStyle} inputMode="tel" value={refDraft.phone}
                onChange={(e) => setRefDraft({ ...refDraft, phone: e.target.value })} />
            </Field>
            <div style={{ flexBasis: '100%', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button style={{ ...linkButton, color: 'var(--text-muted)' }} onClick={() => setRefDraft(null)}>Cancel</button>
              <button onClick={saveReference} disabled={busy} style={{
                background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '7px',
                padding: '7px 14px', fontSize: '12.5px', fontWeight: 600, cursor: busy ? 'default' : 'pointer',
              }}>Add reference</button>
            </div>
          </div>
        )}
        {data.references.length === 0 ? (
          <Empty>No references are on file.</Empty>
        ) : (
          <Table
            head={canManage ? ['Name', 'Relationship', 'Phone', 'Spoken to', ''] : ['Name', 'Relationship', 'Phone', 'Spoken to']}
            rows={data.references.map((r) => {
              const cells: React.ReactNode[] = [
                r.fullName,
                r.relationship || '—',
                r.phone || '—',
                r.checkedAt
                  ? <span style={{ color: 'var(--success)' }}><Check size={12} style={{ verticalAlign: '-2px' }} /> {fmtDate(r.checkedAt)}</span>
                  : <span style={{ color: 'var(--text-muted)' }}>Not yet</span>,
              ];
              if (canManage) {
                cells.push(
                  r.checkedAt
                    ? <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>—</span>
                    : <button style={linkButton} onClick={() => markChecked(r)}>Record call</button>,
                );
              }
              return cells;
            })}
          />
        )}
      </Section>

      <Section
        title="Joining paperwork"
        icon={FileCheck}
        hint={`${paperwork.inHand} of ${paperwork.total} in hand${paperwork.softOnly ? `, ${paperwork.softOnly} soft copy only` : ''}. A soft copy is progress; the file the roster tracks is a physical one.`}
      >
        <Table
          head={canManage ? ['Document', 'Soft copy', 'Hard copy', 'Where', ''] : ['Document', 'Soft copy', 'Hard copy', 'Where']}
          rows={paperwork.rows.map((d) => {
            const yesNo = (v: boolean | null) =>
              v === true ? <span style={{ color: 'var(--success)' }}>Yes</span>
                : v === false ? <span style={{ color: 'var(--text-muted)' }}>No</span>
                  : <span style={{ color: 'var(--text-muted)' }}>—</span>;
            const cells: React.ReactNode[] = [
              ONBOARDING_DOCUMENT_LABELS[d.requirement as keyof typeof ONBOARDING_DOCUMENT_LABELS] ?? d.label,
              yesNo(d.softCopyReceived),
              yesNo(d.hardCopyReceived),
              d.hardCopyLocation || '—',
            ];
            if (canManage) {
              cells.push(
                <div style={{ display: 'flex', gap: '10px', whiteSpace: 'nowrap' }}>
                  <button style={linkButton} onClick={() => togglePaperwork(d.requirement, 'softCopyReceived', d.softCopyReceived !== true)}>
                    {d.softCopyReceived === true ? 'Unset soft' : 'Soft in'}
                  </button>
                  <button style={linkButton} onClick={() => togglePaperwork(d.requirement, 'hardCopyReceived', d.hardCopyReceived !== true)}>
                    {d.hardCopyReceived === true ? 'Unset hard' : 'Hard in'}
                  </button>
                </div>,
              );
            }
            return cells;
          })}
        />
      </Section>
    </div>
  );
};
