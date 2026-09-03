import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { daysUntilExpiry } from '@fapoms/shared';

import { api } from '../../services/api';
import { useConfirm, useToast, AlertBanner, SkeletonList } from '../../components/ui';
import { label, Empty, Notice, Lede, LinkButton, Field, fieldInput, Editor } from './hr-ui';
import { fmtDate } from '../../utils/dates';
import { userMessage } from '../../services/errors';
import { counted } from '../../utils/plural';

/**
 * What this person can be matched on, and what has stopped working.
 *
 * This used to be a page of its own — pick somebody from a list on the left, edit their skills
 * on the right — sitting beside a drawer that showed the same rows read-only with a link across
 * to it. Two ways to reach one fact, and only the far one could change it, so the near one was a
 * dead end that sent you somewhere else to do the obvious thing. This is that editor, on the
 * record, where the rest of the person is.
 */

export const ATTRIBUTE_TYPE_LABEL: Record<string, string> = {
  SKILL: 'Skill',
  LANGUAGE: 'Language',
  CERTIFICATION: 'Certificate',
  SPECIALIZATION: 'Specialisation',
};

export const attributeTypeLabel = (type?: string | null): string =>
  (type && ATTRIBUTE_TYPE_LABEL[type]) || '—';

const TYPES = ['CERTIFICATION', 'SKILL', 'LANGUAGE', 'SPECIALIZATION'] as const;
type AttrType = (typeof TYPES)[number];

/** Only certificates lapse. Offering an expiry against a language invites a meaningless date. */
const EXPIRES: Record<string, boolean> = { CERTIFICATION: true };

interface Attribute {
  id: string; type: string; name: string; level?: string | null; expiryDate?: string | null;
}

/**
 * Days until a certificate stops working, on the same clock the rest of the console uses.
 *
 * Measuring from the device disagreed with the server every morning between midnight and 05:30
 * IST — the badge said a certificate had run out while this list chipped it amber "0d left" and
 * withheld the warning that the person cannot be given work. One rule, in `@fapoms/shared`.
 */
const daysUntil = (iso?: string | null): number | null => daysUntilExpiry(iso ?? null);

/** The date box that sits in a row rather than on a form — narrower, same skin. */
const inlineDate: React.CSSProperties = { ...fieldInput, width: 'auto', padding: '4px 7px', fontSize: '12px' };

export const AssayerSkillsPanel: React.FC<{
  assayerId: string;
  assayerName?: string;
  canManage: boolean;
}> = ({ assayerId, assayerName, canManage }) => {
  const [rows, setRows] = useState<Attribute[] | null>(null);
  const [vocab, setVocab] = useState<Record<string, { name: string }[]>>({});
  const [draft, setDraft] = useState<{ type: AttrType; name: string; expiryDate: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const { toast } = useToast();

  const who = assayerName ?? 'this assayer';

  const load = () => api.request<Attribute[]>(`/assayers/${assayerId}/workforce-attribute`)
    .then((d) => setRows(Array.isArray(d) ? d : []))
    .catch((e) => { setRows([]); setErr(userMessage(e)); });

  useEffect(() => { setRows(null); setErr(null); load(); }, [assayerId]);

  // The shared list of names, so two people do not end up with "Hindi" and "hindi".
  useEffect(() => {
    api.request<Record<string, { name: string }[]>>('/assayers/workforce-attribute/vocabulary')
      .then(setVocab)
      .catch(() => { /* typing a name still works; only the suggestions are missing */ });
  }, []);

  const sorted = useMemo(() => {
    if (!rows) return null;
    return [...rows].sort((a, b) => {
      const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Number.POSITIVE_INFINITY;
      const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Number.POSITIVE_INFINITY;
      return ea !== eb ? ea - eb : String(a.name).localeCompare(String(b.name));
    });
  }, [rows]);

  const lapsed = useMemo(
    () => (rows ?? []).filter((r) => r.type === 'CERTIFICATION' && (daysUntil(r.expiryDate) ?? 1) < 0),
    [rows],
  );

  const add = async () => {
    if (!draft?.name.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api.request(`/assayers/${assayerId}/workforce-attribute`, {
        method: 'POST',
        body: JSON.stringify({
          type: draft.type,
          name: draft.name.trim(),
          expiryDate: EXPIRES[draft.type] ? (draft.expiryDate || undefined) : undefined,
        }),
      });
      // Say so. A save that only stops showing an error leaves the clerk to work out whether the
      // row below is the one they just added, so the safe habit becomes adding it twice.
      toast({
        type: 'success',
        title: `${attributeTypeLabel(draft.type)} added`,
        message: `“${draft.name.trim()}” is now on ${who}’s record.`,
      });
      setDraft(null);
      await load();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  /**
   * Removing an attribute changes who can be sent where, and there is no undo — the row is gone
   * and its expiry with it. A certification is the sharper end: it takes the person out of the
   * pool for every branch that requires it, immediately.
   */
  const remove = async (row: Attribute) => {
    const ok = await confirm({
      title: `Remove “${row.name}”?`,
      message: row.type === 'CERTIFICATION'
        ? `${who} will no longer count as holding this certification, so any branch that requires it will stop matching them from now on. The expiry date on record goes too.`
        : `${who} will no longer be matched on “${row.name}” when work is planned.`,
      confirmLabel: `Remove ${attributeTypeLabel(row.type).toLowerCase()}`,
      reversible: false,
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      await api.request(`/assayers/workforce-attribute/${row.id}`, { method: 'DELETE' });
      toast({ type: 'success', title: `${attributeTypeLabel(row.type)} removed`, message: `“${row.name}” is no longer on ${who}’s record.` });
      await load();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  /**
   * The renewal is the most consequential edit here — it is what puts a lapsed assayer back in
   * the assignable pool — and it is made by typing into a small date box that gives no sign of
   * having saved. Confirming it by name and date is how the clerk knows it is recorded rather
   * than still sitting unsaved in the box.
   */
  const renew = async (row: Attribute, expiryDate: string) => {
    if (!expiryDate) return;
    setBusy(true); setErr(null);
    try {
      await api.request(`/assayers/workforce-attribute/${row.id}`, {
        method: 'PUT', body: JSON.stringify({ expiryDate }),
      });
      toast({ type: 'success', title: 'Renewal recorded', message: `“${row.name}” now runs to ${fmtDate(expiryDate)}.` });
      await load();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  // A skeleton the shape of the rows that are coming, rather than the word "Loading…" in the
  // middle of an empty card — the same treatment the rest of the section now uses.
  if (rows === null) return <SkeletonList rows={3} height={46} />;

  return (
    <div style={{ opacity: busy ? 0.6 : 1, transition: 'opacity .15s' }}>
      {confirmDialog}

      {/* The section's one failure channel, not a hand-rolled red line of its own. */}
      <AlertBanner type="error" message={err} onClose={() => setErr(null)} style={{ marginBottom: '10px' }} />

      <Lede>
        What {who} can be matched on when work is planned. A branch that requires a certificate is
        never offered to somebody whose copy of it has lapsed.
      </Lede>

      {/*
        An expired certification is refused by the eligibility gate, so the person is quietly
        unassignable. Said at the top rather than left to be worked out from a date halfway down
        a list — and the renewal is now in this panel rather than a page away.
      */}
      {lapsed.length > 0 && (
        <Notice
          tone="danger"
          style={{ marginBottom: '12px' }}
          title={`${counted(lapsed.length, 'certificate')} expired`}
        >
          {lapsed.map((c) => c.name).join(', ')} — any branch that requires these will refuse
          this assayer until a renewal date is recorded below.
        </Notice>
      )}

      {canManage && (
        <LinkButton
          icon={<Plus size={12} />}
          onClick={() => setDraft({ type: 'CERTIFICATION', name: '', expiryDate: '' })}
          style={{ fontSize: '12.5px', paddingBottom: '12px' }}
        >
          Add a skill, language or certificate
        </LinkButton>
      )}

      {draft && (
        <Editor
          title="Add a skill, language or certificate"
          onCancel={() => setDraft(null)}
          onSave={add}
          saveLabel="Add"
          busy={busy}
          saveDisabled={!draft.name.trim()}
        >
          <Field title="What kind">
            <select
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value as AttrType })}
              style={fieldInput}
            >
              {TYPES.map((t) => <option key={t} value={t}>{ATTRIBUTE_TYPE_LABEL[t]}</option>)}
            </select>
          </Field>
          <Field title="Name">
            <input
              autoFocus
              list={`vocab-${draft.type}`}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={`Name of the ${attributeTypeLabel(draft.type).toLowerCase()}`}
              style={fieldInput}
            />
            {/* Existing names offered, not enforced: a new certification has to be typeable. */}
            <datalist id={`vocab-${draft.type}`}>
              {(vocab[draft.type] ?? []).map((v) => <option key={v.name} value={v.name} />)}
            </datalist>
          </Field>
          {EXPIRES[draft.type] && (
            <Field title="When it stops working">
              <input
                type="date"
                value={draft.expiryDate}
                onChange={(e) => setDraft({ ...draft, expiryDate: e.target.value })}
                style={fieldInput}
              />
            </Field>
          )}
        </Editor>
      )}

      {sorted!.length === 0 ? (
        <Empty>
          No skills, languages or certificates recorded — planning cannot match this person on
          competency.
        </Empty>
      ) : sorted!.map((w) => {
        const days = daysUntil(w.expiryDate);
        const tone = days === null ? 'var(--text-muted)'
          : days < 0 ? 'var(--danger)' : days <= 30 ? 'var(--warning)' : 'var(--text-muted)';
        return (
          <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--border-hair)', fontSize: '12.5px' }}>
            <span style={{ minWidth: 0 }}>
              <strong>{w.name}</strong>
              <span style={{ ...label, marginLeft: '6px' }}>{attributeTypeLabel(w.type)}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '10px', whiteSpace: 'nowrap' }}>
              <span style={{ color: tone, fontSize: '12px' }}>
                {w.level ?? ''}
                {w.expiryDate && (days !== null && days < 0
                  ? ` · expired ${fmtDate(w.expiryDate)}`
                  : ` · expires ${fmtDate(w.expiryDate)}`)}
              </span>
              {canManage && EXPIRES[w.type] && (
                <input
                  type="date"
                  defaultValue={w.expiryDate ? String(w.expiryDate).slice(0, 10) : ''}
                  onChange={(e) => renew(w, e.target.value)}
                  // Named, not just titled: a bare date box beside a certificate name is the same
                  // problem an unlabelled icon button is — the control is reachable and says
                  // nothing about which of the rows it belongs to.
                  aria-label={w.expiryDate ? `Record a renewal for ${w.name}` : `Record when ${w.name} stops working`}
                  title={w.expiryDate ? 'Record a renewal' : 'Record when it stops working'}
                  style={inlineDate}
                />
              )}
              {canManage && (
                <LinkButton
                  onClick={() => remove(w)}
                  tone="muted"
                  label={`Remove ${w.name}`}
                  icon={<Trash2 size={13} />}
                />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
};
