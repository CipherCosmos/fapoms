import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check, CheckCircle2, Circle, ExternalLink, FileCheck, Landmark, MapPin, Phone, ShieldCheck,
} from 'lucide-react';
import {
  AssayerLifecycleStatus, assayerLifecycleLabel, nextAssayerLifecycleStates, payoutBlockingGaps,
  IDENTITY_GATE_DOCUMENTS, ONBOARDING_DOCUMENT_LABELS, type OnboardingDocument,
} from '@fapoms/shared';

import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { queryKeys } from '../../hooks/queryKeys';
import { canManageAssayers, canApproveJoiners, useCurrentRoles, useCurrentPermissions, useCurrentUserId } from '../../hooks/useCurrentRoles';
import { ApprovalPanel } from './record/ApprovalPanel';
import { DetailDrawer, AlertBanner, useConfirm } from '../../components/ui';
import { useToast } from '../../components/ui/Toast';
import { LocationPicker } from '../../components/LocationPicker';
import { PinCoordinateControl } from '../../components/PinCoordinateControl';
import { GeoPrecisionBadge, geoNeedsFixing } from '../../components/GeoPrecisionBadge';
import { AssayerVettingTab, ADVERSE_BACKGROUND_VERDICTS, VERDICT_LABELS } from './AssayerVettingTab';
import { STAGE_CONSEQUENCE } from './AssayerRecord';
import { QuickRecordForm, PAYOUT_BOXES, CONTACT_BOXES } from './record/QuickRecordForm';
import { missingCriticalFields, type Assayer } from './assayer-shared';
import type { AssayerDossier, PaperworkDocument } from './record/record-types';

export interface OnboardingVerificationDrawerProps {
  candidateId: string | null;
  onClose: () => void;
  onSuccess: () => void;
}

const STEPS: Array<{ key: AssayerLifecycleStatus; title: string }> = [
  { key: AssayerLifecycleStatus.INVITED, title: 'Invited' },
  { key: AssayerLifecycleStatus.DOCUMENT_VERIFICATION, title: 'Documents' },
  { key: AssayerLifecycleStatus.BACKGROUND_VERIFICATION, title: 'Background check' },
  { key: AssayerLifecycleStatus.FINAL_APPROVAL, title: 'Approval' },
  { key: AssayerLifecycleStatus.TRAINING, title: 'Training' },
  { key: AssayerLifecycleStatus.ACTIVE, title: 'Active' },
];

type WorkArea = 'documents' | 'background' | 'bank';

const WORK_AREAS: Array<{ key: WorkArea; label: string; icon: React.ElementType }> = [
  { key: 'documents', label: 'Documents', icon: FileCheck },
  { key: 'background', label: 'Background check', icon: ShieldCheck },
  { key: 'bank', label: 'Bank, location & details', icon: Landmark },
];

const AREA_FOR_STAGE: Partial<Record<string, WorkArea>> = {
  [AssayerLifecycleStatus.INVITED]: 'documents',
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: 'documents',
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: 'background',
  [AssayerLifecycleStatus.FINAL_APPROVAL]: 'background',
  [AssayerLifecycleStatus.TRAINING]: 'bank',
  [AssayerLifecycleStatus.ACTIVE]: 'bank',
};

interface ChecklistItem {
  label: string;
  done: boolean;
  /** When false the item is shown for information and never holds the button back. */
  blocking: boolean;
  /** Where the clerk fixes it. */
  area?: WorkArea;
}

interface StepPlan {
  next: AssayerLifecycleStatus | null;
  actionLabel: string;
  items: ChecklistItem[];
}

const hasScan = (d?: PaperworkDocument) => !!d && (d.filePaths ?? []).length > 0;

/** "Checked" for one identity document, in the words the checklist uses. */
function identityItem(label: string, doc: PaperworkDocument | undefined): ChecklistItem {
  if (!doc || !hasScan(doc)) return { label: `${label}: scan uploaded and checked`, done: false, blocking: true, area: 'documents' };
  if (doc.verificationStatus === 'REJECTED') return { label: `${label}: sent back — a new scan is needed`, done: false, blocking: true, area: 'documents' };
  return { label: `${label}: checked against the original`, done: doc.verificationStatus === 'VERIFIED', blocking: true, area: 'documents' };
}

/**
 * What the current step needs before its button will be accepted.
 *
 * Mirrors the server's gates rather than inventing new ones: identity documents before leaving
 * document checks, a recorded, non-adverse background check before training, and — before Active —
 * the identity documents AGAIN, then bank account, IFSC and a map location, in the order
 * `doTransitionLifecycle` checks them.
 *
 * "Again" is the part this used to miss. The server runs its identity check at Active as well as
 * at the end of document checks, because somebody can reach training without passing it: the check
 * was set to warn when they moved on, or they came in through an import. The Active list left it
 * out, so the drawer could show everything ticked, the desk pressed "Make them Active", and the
 * server refused for a reason the list had never mentioned.
 */
export function planStep(candidate: Assayer, dossier: AssayerDossier | undefined): StepPlan {
  const docs = dossier?.onboarding ?? [];
  const identity = docs.filter((d) => d.identity);
  const verdict = dossier?.currentCheck?.verdict ?? null;
  const adverse = !!verdict && ADVERSE_BACKGROUND_VERDICTS.includes(verdict);

  switch (candidate.lifecycleStatus) {
    case AssayerLifecycleStatus.INVITED:
      return {
        next: AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
        actionLabel: 'Start checking documents',
        items: [
          { label: 'PAN card scan uploaded', done: hasScan(identity.find((d) => d.requirement === 'PAN_CARD')), blocking: false, area: 'documents' },
          { label: 'Aadhaar scan uploaded', done: hasScan(identity.find((d) => d.requirement.startsWith('AADHAAR'))), blocking: false, area: 'documents' },
        ],
      };
    case AssayerLifecycleStatus.DOCUMENT_VERIFICATION: {
      // The server's list (Aadhaar front, PAN card), plus two desk rules: an Aadhaar back that was
      // uploaded gets checked too, and nothing is left sent back.
      const covered = new Set<string>();
      const itemFor = (requirement: string) => {
        covered.add(requirement);
        const row = docs.find((d) => d.requirement === requirement);
        return identityItem(row?.label ?? ONBOARDING_DOCUMENT_LABELS[requirement as OnboardingDocument] ?? requirement, row);
      };
      const items = IDENTITY_GATE_DOCUMENTS.map((r) => itemFor(r));
      const aadhaarBack = identity.find((d) => d.requirement === 'AADHAAR_BACK');
      if (aadhaarBack && (hasScan(aadhaarBack) || aadhaarBack.verificationStatus === 'REJECTED')) {
        items.push(itemFor('AADHAAR_BACK'));
      }
      for (const d of identity) {
        if (d.verificationStatus === 'REJECTED' && !covered.has(d.requirement)) items.push(itemFor(d.requirement));
      }
      return { next: AssayerLifecycleStatus.BACKGROUND_VERIFICATION, actionLabel: 'Move to background check', items };
    }
    case AssayerLifecycleStatus.BACKGROUND_VERIFICATION:
      return {
        // HR's last step: a senior approves them before training (2026-09-23).
        next: AssayerLifecycleStatus.FINAL_APPROVAL,
        actionLabel: 'Send for approval',
        items: [
          // Mandatory, like the check itself: the server will not let them out of this stage without
          // it — and it asks the CHECK for its own report, not the document, so this does too.
          {
            label: 'Background verification report uploaded',
            done: ((dossier?.currentCheck as { reportFiles?: unknown[] } | null | undefined)?.reportFiles?.length ?? 0) > 0,
            blocking: true,
            area: 'background',
          },
          { label: 'Background check recorded', done: !!verdict && verdict !== 'NOT_CHECKED', blocking: true, area: 'background' },
          {
            label: adverse ? `Background check result: ${VERDICT_LABELS[verdict!] ?? verdict} — they cannot move on` : 'Background check result is clear',
            done: verdict === 'CLEAR',
            blocking: true,
            area: 'background',
          },
        ],
      };
    case AssayerLifecycleStatus.TRAINING: {
      const gaps = payoutBlockingGaps(candidate as unknown as Record<string, unknown>).map((f) => f.key);
      /*
        ONE PAN, IN ONE PLACE.

        This list used to open with a bare "PAN" that sent the desk to a PAN box in the bank form,
        while the Documents step had its own PAN — the card, its number, its verification. Same
        number, two forms, two steps, two different things both called "PAN". The number now lives
        with the card it is printed on, and the one item here says which half is still missing.
      */
      const identityItems: ChecklistItem[] = IDENTITY_GATE_DOCUMENTS.map((requirement) => {
        const row = docs.find((d) => d.requirement === requirement);
        const label = row?.label ?? ONBOARDING_DOCUMENT_LABELS[requirement as OnboardingDocument] ?? requirement;
        if (requirement === 'PAN_CARD' && gaps.includes('panNumber')) {
          return { label: `${label}: its number is not recorded yet`, done: false, blocking: true, area: 'documents' };
        }
        return identityItem(label, row);
      });
      const items: ChecklistItem[] = [
        ...identityItems,
        { label: 'Bank account number', done: !gaps.includes('bankAccountNumber'), blocking: true, area: 'bank' },
        { label: 'IFSC', done: !gaps.includes('ifscCode'), blocking: true, area: 'bank' },
        { label: 'Home location pinned', done: candidate.latitude != null && candidate.longitude != null, blocking: true, area: 'bank' },
      ];
      if (adverse) {
        items.push({ label: `Background check result: ${VERDICT_LABELS[verdict!] ?? verdict} — a new check must clear them`, done: false, blocking: true, area: 'background' });
      }
      // The rest of the record's key fields. Activation does not wait for them, but the roster
      // lists a trainee as "ready to activate" only once they are in — so say which are missing.
      for (const f of missingCriticalFields(candidate)) {
        if (['panNumber', 'bankAccountNumber', 'ifscCode', 'latitude'].includes(String(f.key))) continue;
        items.push({ label: f.label, done: false, blocking: false, area: 'bank' });
      }
      return { next: AssayerLifecycleStatus.ACTIVE, actionLabel: 'Make them Active', items };
    }
    default:
      return { next: null, actionLabel: '', items: [] };
  }
}

export const OnboardingVerificationDrawer: React.FC<OnboardingVerificationDrawerProps> = ({
  candidateId,
  onClose,
  onSuccess,
}) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { confirm, confirmWithReason, confirmDialog } = useConfirm();
  const roles = useCurrentRoles();
  const canManage = canManageAssayers(roles);
  const canApprove = canApproveJoiners(roles, useCurrentPermissions());
  const currentUserId = useCurrentUserId();

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [area, setArea] = useState<WorkArea>('documents');
  const [pickedPin, setPickedPin] = useState<{ lat: number; lng: number } | null>(null);

  const candidateQuery = useQuery({
    queryKey: queryKeys.hr.assayerRecord(candidateId ?? ''),
    queryFn: () => api.request<Assayer>(`/assayers/${candidateId}`),
    enabled: !!candidateId,
  });
  const dossierQuery = useQuery({
    queryKey: queryKeys.hr.assayerDossier(candidateId ?? ''),
    queryFn: () => api.request<AssayerDossier>(`/assayers/${candidateId}/dossier`),
    enabled: !!candidateId,
  });

  const candidate = candidateQuery.data;
  const dossier = dossierQuery.data;
  const stage = candidate?.lifecycleStatus;

  // Open on the work the current step needs, and follow the person when they move on.
  useEffect(() => {
    const preferred = stage ? AREA_FOR_STAGE[stage] : undefined;
    if (preferred) setArea(preferred);
  }, [stage]);

  const plan = useMemo(() => (candidate ? planStep(candidate, dossier) : null), [candidate, dossier]);
  const outstanding = plan?.items.filter((i) => i.blocking && !i.done) ?? [];
  const canStop = !!stage && stage !== AssayerLifecycleStatus.ACTIVE
    && nextAssayerLifecycleStates(stage).includes(AssayerLifecycleStatus.INACTIVE);

  const refreshAll = useCallback(async () => {
    if (!candidateId) return;
    await Promise.all([
      candidateQuery.refetch(),
      dossierQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: queryKeys.hr.rosterAll }),
      queryClient.invalidateQueries({ queryKey: queryKeys.hr.workforce }),
    ]);
  }, [candidateId, candidateQuery, dossierQuery, queryClient]);

  const moveTo = async (target: AssayerLifecycleStatus, reason: string) => {
    if (!candidateId || !candidate) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.request(`/assayers/${candidateId}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: target, reason }),
      });
      toast({ type: 'success', title: 'Stage updated', message: `${candidate.displayName} is now ${assayerLifecycleLabel(target)}.` });
      onSuccess();
      await refreshAll();
    } catch (e) {
      setActionError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const advance = async () => {
    if (!plan?.next || !candidate) return;
    // Sending up for approval carries an optional note for the approver, which opens the round.
    if (plan.next === AssayerLifecycleStatus.FINAL_APPROVAL) {
      const sent = await confirmWithReason({
        title: `Send ${candidate.displayName} for approval?`,
        message: STAGE_CONSEQUENCE[plan.next] ?? '',
        confirmLabel: plan.actionLabel,
        reasonPrompt: { label: 'Note for the approver (optional)', placeholder: 'Anything they should know about this file', optional: true },
      });
      if (sent.confirmed) await moveTo(plan.next, sent.reason.trim() || 'Sent for approval before training');
      return;
    }
    const ok = await confirm({
      title: `Move ${candidate.displayName} to ${assayerLifecycleLabel(plan.next)}?`,
      message: STAGE_CONSEQUENCE[plan.next] ?? '',
      confirmLabel: plan.actionLabel,
    });
    if (ok) await moveTo(plan.next, `Moved to ${assayerLifecycleLabel(plan.next)} from the onboarding page`);
  };

  const stopJoining = async () => {
    if (!candidate) return;
    const { confirmed, reason } = await confirmWithReason({
      title: `Stop ${candidate.displayName}'s joining?`,
      message: `${STAGE_CONSEQUENCE[AssayerLifecycleStatus.INACTIVE] ?? ''} They leave this onboarding list.`,
      confirmLabel: 'Stop joining',
      tone: 'danger',
      reasonPrompt: { label: 'Why? This is kept on their record', placeholder: 'e.g. background check found a criminal case' },
    });
    if (confirmed) await moveTo(AssayerLifecycleStatus.INACTIVE, reason);
  };

  const savePin = async () => {
    if (!candidateId || !pickedPin) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.request(`/geo/precision/assayer/${candidateId}/pin`, {
        method: 'POST',
        body: JSON.stringify({ latitude: pickedPin.lat, longitude: pickedPin.lng, note: 'Pinned on the onboarding page' }),
      });
      setPickedPin(null);
      toast({ type: 'success', title: 'Location saved', message: 'Their home location is pinned.' });
      await refreshAll();
    } catch (e) {
      setActionError(`The pin was not saved. ${userMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!candidateId) return null;

  const stageIndex = STEPS.findIndex((s) => s.key === stage);
  const hasPin = candidate?.latitude != null && candidate?.longitude != null;

  return (
    <>
      <DetailDrawer
        open={!!candidateId}
        onClose={onClose}
        // Wide because it hosts the documents and checks tables, which do not fit 760px — the
        // identity table alone needs about 900 — and they made the whole drawer scroll sideways.
        // A right-anchored drawer pays one gutter where a centred dialog pays two, so this is in
        // line with the 860px the scan-beside verify dialog already uses. `94vw` keeps it on a phone.
        width="min(920px, 94vw)"
        title={(
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)' }}>
              {candidate?.displayName || 'Loading…'}
            </span>
            {candidate?.assayerCode && (
              <span style={{ fontFamily: 'monospace', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                {candidate.assayerCode}
              </span>
            )}
          </div>
        )}
        subtitle={(
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginTop: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              {candidate?.phone && (
                <a href={`tel:${candidate.phone}`} style={{ color: 'inherit', display: 'flex', alignItems: 'center', gap: '4px', textDecoration: 'none' }}>
                  <Phone size={12} /> {candidate.phone}
                </a>
              )}
              {(candidate?.district || candidate?.state) && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <MapPin size={12} /> {[candidate.district, candidate.state].filter(Boolean).join(', ')}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => { onClose(); void navigate(`/hr/roster/${candidateId}`); }}
              title={`Open the full roster record for ${candidate?.displayName ?? 'this candidate'}`}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 'var(--text-xs)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 500 }}
            >
              Full profile <ExternalLink size={12} />
            </button>
          </div>
        )}
        footer={(
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button type="button" className="btn btn-secondary" onClick={onClose} title="Close this verification panel without changing anything" style={{ fontSize: 'var(--text-sm)', padding: '8px 16px' }}>
                Close
              </button>
              {canManage && canStop && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void stopJoining()}
                  title="Stop this candidate's onboarding — they will not join the roster"
                  style={{ background: 'none', border: 'none', color: 'var(--danger)', fontSize: 'var(--text-xs)', cursor: 'pointer', padding: '6px 4px' }}
                >
                  Stop their joining
                </button>
              )}
            </div>
            {canManage && plan?.next && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {outstanding.length > 0 && (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    {outstanding.length === 1 ? '1 thing left above' : `${outstanding.length} things left above`}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || outstanding.length > 0}
                  onClick={() => void advance()}
                  title={outstanding.length > 0 ? `Finish ${outstanding.length} remaining item${outstanding.length === 1 ? '' : 's'} above first` : plan.next ? `Move to: ${plan.next}` : plan.actionLabel}
                  style={{ fontSize: 'var(--text-sm)', padding: '8px 18px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <CheckCircle2 size={15} /> {busy ? 'Saving…' : plan.actionLabel}
                </button>
              </div>
            )}
          </div>
        )}
      >
        {/* Joining steps */}
        <div
          aria-label="Joining steps"
          style={{
            display: 'grid', gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))`, gap: '4px',
            padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: '10px',
            border: '1px solid var(--border-color)', marginBottom: '14px',
          }}
        >
          {STEPS.map((s, idx) => {
            const done = stageIndex > idx;
            const current = stageIndex === idx;
            return (
              <div key={s.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', opacity: current || done ? 1 : 0.5 }}>
                <div style={{
                  width: '24px', height: '24px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 'var(--text-xs)', fontWeight: 700, marginBottom: '4px',
                  background: current ? 'var(--accent)' : done ? 'var(--success)' : 'var(--bg-surface-1)',
                  color: current || done ? '#fff' : 'var(--text-muted)',
                  border: current || done ? 'none' : '1px solid var(--border-color)',
                }}>
                  {done ? <Check size={13} strokeWidth={3} /> : idx + 1}
                </div>
                <div style={{ fontSize: 'var(--text-2xs)', fontWeight: current ? 700 : 500, color: current ? 'var(--accent)' : 'var(--text-secondary)' }}>
                  {s.title}
                </div>
              </div>
            );
          })}
        </div>

        {candidateQuery.isError && (
          <AlertBanner type="error" message={`This person could not be loaded. ${userMessage(candidateQuery.error)}`} style={{ marginBottom: '14px' }} />
        )}
        {actionError && (
          <AlertBanner type="error" message={actionError} onClose={() => setActionError(null)} style={{ marginBottom: '14px' }} />
        )}

        {/* The approval before training — decided here too, so the approver need not leave the list. */}
        {candidate && (
          <div style={{ marginBottom: '14px' }}>
            <ApprovalPanel
              assayerId={candidate.id}
              lifecycleStatus={candidate.lifecycleStatus}
              canManage={canManage}
              canApprove={canApprove}
              currentUserId={currentUserId}
              onChanged={() => { onSuccess(); void refreshAll(); }}
            />
          </div>
        )}

        {/* What this step still needs */}
        {candidate && plan && (
          <section
            data-testid="step-checklist"
            style={{ padding: '12px 14px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-card)', marginBottom: '14px' }}
          >
            {plan.next ? (
              <>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
                  {outstanding.length === 0
                    ? `Ready: ${plan.actionLabel.toLowerCase()}`
                    : `Before they can ${plan.actionLabel.charAt(0).toLowerCase()}${plan.actionLabel.slice(1)}`}
                </div>
                {plan.items.length === 0 ? (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>Nothing else is needed for this step.</div>
                ) : (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {plan.items.map((item) => (
                      <li key={item.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-xs)' }}>
                        {item.done
                          ? <CheckCircle2 size={14} color="var(--success)" aria-label="done" />
                          : <Circle size={14} color={item.blocking ? 'var(--warning)' : 'var(--text-muted)'} aria-label="not done" />}
                        <span style={{ color: item.done ? 'var(--text-secondary)' : 'var(--text-primary)', flex: 1 }}>
                          {item.label}{!item.blocking && !item.done ? ' (can be done later)' : ''}
                        </span>
                        {!item.done && item.area && item.area !== area && (
                          <button
                            type="button"
                            onClick={() => setArea(item.area!)}
                            title={`Jump to the ${item.area} section to complete: ${item.label}`}
                            style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 'var(--text-xs)', cursor: 'pointer', padding: 0 }}
                          >
                            Go there
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : stage === AssayerLifecycleStatus.ACTIVE ? (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--success)', fontWeight: 600 }}>
                Joining is complete — they can be offered work.
              </div>
            ) : (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                They are {assayerLifecycleLabel(stage)}, so there is no joining step to take here.
              </div>
            )}
          </section>
        )}

        {/* The work itself */}
        {candidate && (
          <>
            <div role="tablist" style={{ display: 'flex', gap: '2px', borderBottom: '1px solid var(--border-color)', marginBottom: '12px', overflowX: 'auto' }}>
              {WORK_AREAS.map((w) => {
                const Icon = w.icon;
                const on = w.key === area;
                return (
                  <button
                    key={w.key}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setArea(w.key)}
                    title={`Verify: ${w.label}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 12px', whiteSpace: 'nowrap',
                      fontSize: 'var(--text-xs)', fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none',
                      color: on ? 'var(--accent)' : 'var(--text-muted)',
                      borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                    }}
                  >
                    <Icon size={13} /> {w.label}
                  </button>
                );
              })}
            </div>

            {area === 'documents' && (
              <AssayerVettingTab
                assayerId={candidateId}
                canManage={canManage}
                section="documents"
                lifecycleStatus={stage}
                person={candidate ?? null}
                onGoToChecks={() => setArea('background')}
                onChanged={() => void refreshAll()}
              />
            )}

            {area === 'background' && (
              <AssayerVettingTab
                assayerId={candidateId}
                canManage={canManage}
                section="checks"
                lifecycleStatus={stage}
                person={candidate ?? null}
                onGoToDocuments={() => setArea('documents')}
                onChanged={() => void refreshAll()}
              />
            )}

            {area === 'bank' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <section style={{ padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-card)' }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>Bank details</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '2px 0 10px' }}>
                    Needed before they can be made Active or paid. Type only what you want to add or change.
                    {' '}The PAN is not here: it is recorded with the PAN card, on the{' '}
                    <button
                      type="button"
                      onClick={() => setArea('documents')}
                      style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }}
                    >
                      Documents tab
                    </button>.
                  </div>
                  {canManage
                    ? <QuickRecordForm assayer={candidate} boxes={PAYOUT_BOXES} saveLabel="Save bank details" onSaved={() => { toast({ type: 'success', title: 'Saved', message: 'Bank details saved.' }); void refreshAll(); }} />
                    : <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>You can see these, but not change them.</div>}
                </section>

                {canManage && (
                  <section style={{ padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-card)' }}>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>Contact and joining date</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '2px 0 10px' }}>
                      Not needed to make them Active, but their record counts as complete only once these are in.
                    </div>
                    <QuickRecordForm assayer={candidate} boxes={CONTACT_BOXES} saveLabel="Save details" onSaved={() => { toast({ type: 'success', title: 'Saved', message: 'Details saved.' }); void refreshAll(); }} />
                  </section>
                )}

                <section style={{ padding: '14px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-card)' }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>Home location</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', margin: '4px 0 10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    {hasPin ? (
                      <>
                        <span>Pinned at <span style={{ fontFamily: 'monospace' }}>{Number(candidate.latitude).toFixed(4)}, {Number(candidate.longitude).toFixed(4)}</span></span>
                        <GeoPrecisionBadge source={candidate.geoSource} matchedName={candidate.geoMatchedName} compact />
                      </>
                    ) : (
                      <span style={{ color: 'var(--warning)' }}>No home location yet — they cannot be made Active or found by distance without one.</span>
                    )}
                  </div>
                  {hasPin && geoNeedsFixing(candidate.geoSource) && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warning)', marginBottom: '8px' }}>
                      This pin is only approximate. Move it to their actual home if you can.
                    </div>
                  )}
                  {canManage && (
                    <>
                      <LocationPicker
                        latitude={pickedPin?.lat ?? (hasPin ? Number(candidate.latitude) : null)}
                        longitude={pickedPin?.lng ?? (hasPin ? Number(candidate.longitude) : null)}
                        onChange={(lat, lng) => setPickedPin(lat != null && lng != null ? { lat, lng } : null)}
                      />
                      {pickedPin && (
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' }}>
                          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void savePin()} title="Save this map pin as their home location" style={{ fontSize: 'var(--text-xs)', padding: '6px 12px' }}>
                            Save this pin
                          </button>
                          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPickedPin(null)} title="Throw away the moved pin and keep the old location" style={{ fontSize: 'var(--text-xs)', padding: '6px 12px' }}>
                            Discard
                          </button>
                        </div>
                      )}
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: '10px' }}>
                        Or, if they sent you their location as numbers:
                      </div>
                      <PinCoordinateControl target="assayer" id={candidateId} onPinned={() => void refreshAll()} />
                    </>
                  )}
                </section>
              </div>
            )}
          </>
        )}
      </DetailDrawer>
      {confirmDialog}
    </>
  );
};

export default OnboardingVerificationDrawer;
