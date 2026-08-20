import React, { useEffect, useMemo, useState } from 'react';
import { Award, Languages as LangIcon, Wrench, Plus, Trash2, AlertTriangle, Search } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { assayerLifecycleLabel, daysUntilExpiry } from '@fapoms/shared';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { SkeletonList } from '../../components/ui';
import { listPhase } from '../../components/ui/list-phase';
import { card, label, Empty, ExpiryChip, fmtDate } from './hr-ui';
import { ChipMultiSelect } from '../../components/ui/ChipMultiSelect';
import { useToast } from '../../components/ui';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { useHr } from './HrLayout';

/**
 * Capability & certifications.
 *
 * The backend has always had full CRUD on skills, languages and certifications, gated to
 * HR_MANAGER, and never had a screen. Every one of the 126 attribute rows in the database
 * arrived through the Excel importer, and an HR manager could not add a language, record a new
 * certification with its expiry, or remove a lapsed one. This page is that missing write path.
 *
 * Certification expiry is the reason it matters most: the eligibility gate refuses an assayer
 * whose certification has lapsed by the audit date, so a renewal that is recorded nowhere
 * quietly takes someone out of the assignable pool.
 */

type AttrType = 'SKILL' | 'LANGUAGE' | 'CERTIFICATION' | 'SPECIALIZATION';

interface WorkforceAttribute {
  id: string;
  assayerId: string;
  type: AttrType;
  name: string;
  level: string | null;
  expiryDate: string | null;
}

interface AssayerLite {
  id: string;
  assayerCode: string;
  displayName: string;
  state: string | null;
  district: string | null;
  lifecycleStatus: string;
  /**
   * The roster endpoint already hydrates each person's certifications with their expiry dates
   * (AssayerService.hydrateAllWorkforceAttributes), so the picker can flag a lapse without a
   * second request. Without this the only way to find an expired certification was to click
   * through all eight people one at a time — or to be told no when an assignment was refused.
   */
  certifications: { name: string; expiryDate: string | null }[] | null;
}

/** Worst certification standing for one person: expired beats expiring beats fine. */
const certificationAlert = (a: AssayerLite): 'expired' | 'expiring' | null => {
  let worst: 'expired' | 'expiring' | null = null;
  for (const c of a.certifications ?? []) {
    const d = daysUntil(c.expiryDate ?? null);
    if (d === null) continue;
    if (d < 0) return 'expired';
    if (d <= 30) worst = 'expiring';
  }
  return worst;
};

type Vocabulary = Record<string, Array<{ name: string; assayerCount: number }>>;

const TYPE_META: Record<AttrType, { label: string; icon: typeof Award; hasExpiry: boolean }> = {
  SKILL: { label: 'Skills', icon: Wrench, hasExpiry: false },
  LANGUAGE: { label: 'Languages', icon: LangIcon, hasExpiry: false },
  CERTIFICATION: { label: 'Certificates', icon: Award, hasExpiry: true },
  SPECIALIZATION: { label: 'Specialisations', icon: Award, hasExpiry: false },
};

/**
 * Singular wording for one attribute, exported because the assayer detail drawer's Skills tab
 * showed the raw database value ("CERTIFICATION") next to each name. One map, two surfaces.
 */
export const ATTRIBUTE_TYPE_LABEL: Record<string, string> = {
  SKILL: 'Skill',
  LANGUAGE: 'Language',
  CERTIFICATION: 'Certificate',
  SPECIALIZATION: 'Specialisation',
};

export const attributeTypeLabel = (type?: string | null): string =>
  (type && ATTRIBUTE_TYPE_LABEL[type]) || '—';

/**
 * Days until a certificate stops working, on the same clock the HR console uses.
 *
 * This measured from `Date.now()` on the device, while the compliance panel's figures come from
 * Postgres counting calendar days against the Indian working day. The two disagreed every
 * morning between midnight and 05:30 IST: the badge would say a certificate had already run
 * out while this tab chipped it amber "0d left" and withheld the warning that the person cannot
 * be given work. One rule now, in `@fapoms/shared`.
 */
const daysUntil = (iso: string | null): number | null => daysUntilExpiry(iso);

/**
 * Certifications sort by the date they stop working, soonest first, with the ones that have no
 * expiry recorded last.
 *
 * Insertion order was the previous behaviour, which is the one order that tells nobody anything:
 * an expired certification takes its holder out of the assignable pool (the eligibility gate in
 * assayer.service.ts refuses them), so the row that matters is the one nearest the top of the
 * calendar, not the one that happened to be imported first.
 */
const byExpiryThenName = (a: WorkforceAttribute, b: WorkforceAttribute): number => {
  const ea = a.expiryDate ? new Date(a.expiryDate).getTime() : Number.POSITIVE_INFINITY;
  const eb = b.expiryDate ? new Date(b.expiryDate).getTime() : Number.POSITIVE_INFINITY;
  if (ea !== eb) return ea - eb;
  return a.name.localeCompare(b.name);
};

/** Stacks the two-pane layout below this width so the picker/detail don't overlap on phones. */
function useNarrow(breakpoint = 760): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < breakpoint);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return narrow;
}

export const HrCapabilityPage: React.FC = () => {

  const { canManage } = useHr();
  const narrow = useNarrow();
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [searchParams] = useSearchParams();
  const [roster, setRoster] = useState<AssayerLite[]>([]);
  const [vocab, setVocab] = useState<Vocabulary>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attrs, setAttrs] = useState<WorkforceAttribute[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [attrsLoading, setAttrsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * Kept apart from `error` on purpose. `error` is a failure of the *initial* load and replaces
   * the whole screen, which is right when there is nothing to show. A failed add, remove or
   * renewal is not that: the register is still on screen and still correct, so it gets a banner
   * over the top instead of blanking the page the user was working in.
   */
  const [actionError, setActionError] = useState<string | null>(null);

  // Roster and vocabulary load once; the vocabulary drives the picker so names stay consistent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [people, vocabulary] = await Promise.all([
          api.request<AssayerLite[]>('/assayers?limit=1000'),
          api.request<Vocabulary>('/assayers/workforce-attribute/vocabulary'),
        ]);
        if (cancelled) return;
        setRoster(people);
        setVocab(vocabulary);
        /*
         * `?assayer=<id>` lands on that person instead of whoever sorts first. The detail
         * drawer's expired-certification warning links here, and being dropped on an unrelated
         * assayer's register is how someone records a renewal against the wrong person. Falls
         * back to the first row when the id is not on this user's (region-scoped) roster.
         */
        const wanted = searchParams.get('assayer');
        const preselected = wanted && people.some((p) => p.id === wanted) ? wanted : null;
        setSelectedId((prev) => preselected ?? prev ?? people[0]?.id ?? null);
      } catch (e) {
        if (!cancelled) setError(userMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Deliberately once: `?assayer=` is read as the landing intent, not as a live binding — a
    // later click in the picker must not be undone by the (unchanged) query string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAttrs = async (assayerId: string) => {
    setAttrsLoading(true);
    try {
      const rows = await api.request<WorkforceAttribute[]>(`/assayers/${assayerId}/workforce-attribute`);
      setAttrs(rows);
    } catch (e) {
      setActionError(userMessage(e));
    } finally {
      setAttrsLoading(false);
    }
  };

  useEffect(() => {
    if (selectedId) loadAttrs(selectedId);
  }, [selectedId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter((a) =>
      a.displayName.toLowerCase().includes(q) || a.assayerCode.toLowerCase().includes(q));
  }, [roster, search]);

  const selected = roster.find((a) => a.id === selectedId) ?? null;

  const byType = (t: AttrType) =>
    attrs.filter((a) => a.type === t).sort(byExpiryThenName);

  const addAttr = async (type: AttrType, name: string, expiryDate?: string) => {
    if (!selectedId || !name.trim()) return;
    setActionError(null);
    try {
      await api.request(`/assayers/${selectedId}/workforce-attribute`, {
        method: 'POST',
        body: JSON.stringify({ type, name: name.trim(), expiryDate: expiryDate || undefined }),
      });
    } catch (e) {
      // Previously this rejection escaped into the void: the row cleared itself as though the
      // save had worked, and the assayer silently did not hold the skill.
      setActionError(userMessage(e));
      return;
    }
    await loadAttrs(selectedId);
    /*
     * Say so. A save that only *stops showing an error* asks the clerk to work out for themselves
     * whether the row in the list below is the one they just added or one that was already there —
     * so the safe habit was to add it a second time "to be sure".
     */
    toast({
      type: 'success',
      title: `${attributeTypeLabel(type)} added`,
      message: `“${name.trim()}” is now on ${roster.find((a) => a.id === selectedId)?.displayName ?? 'this assayer'}’s record.`,
    });
    // A newly-typed name becomes part of the shared list of names immediately.
    setVocab((v) => {
      const list = v[type] ?? [];
      if (list.some((x) => x.name.toLowerCase() === name.trim().toLowerCase())) return v;
      return { ...v, [type]: [...list, { name: name.trim(), assayerCount: 1 }] };
    });
  };

  /**
   * Removing an attribute changes who can be sent where, and there is no undo — the row is gone
   * and its expiry date with it. Removing a certification is the sharper end: it takes the
   * assayer out of the pool for every branch that requires it, immediately.
   *
   * This ran on a single click of a small bin icon, with nothing in between.
   */
  const removeAttr = async (row: WorkforceAttribute) => {
    if (!selectedId) return;
    const who = roster.find((a) => a.id === selectedId)?.displayName ?? 'this assayer';
    const ok = await confirm({
      title: `Remove “${row.name}”?`,
      message: row.type === 'CERTIFICATION'
        ? `${who} will no longer count as holding this certification, so any branch that requires it will stop matching them from now on. The expiry date on record is removed too.`
        : `${who} will no longer be matched on “${row.name}” when work is planned.`,
      confirmLabel: `Remove ${attributeTypeLabel(row.type).toLowerCase()}`,
      reversible: false,
      tone: 'danger',
    });
    if (!ok) return;
    setActionError(null);
    try {
      await api.request(`/assayers/workforce-attribute/${row.id}`, { method: 'DELETE' });
    } catch (e) {
      setActionError(userMessage(e));
      return;
    }
    await loadAttrs(selectedId);
    toast({
      type: 'success',
      title: `${attributeTypeLabel(row.type)} removed`,
      message: `“${row.name}” is no longer on ${who}’s record.`,
    });
  };

  const updateExpiry = async (id: string, expiryDate: string) => {
    setActionError(null);
    try {
      await api.request(`/assayers/workforce-attribute/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ expiryDate }),
      });
    } catch (e) {
      setActionError(userMessage(e));
      return;
    }
    if (selectedId) await loadAttrs(selectedId);
    /*
     * The renewal is the single most consequential edit on this page — it is what puts a lapsed
     * assayer back into the assignable pool — and it was made by typing into a small date box that
     * gave no sign of having saved. Confirming it by name and date is how the clerk knows the
     * renewal is recorded and not still sitting unsaved in the box.
     */
    const row = attrs.find((a) => a.id === id);
    toast({
      type: 'success',
      title: 'Renewal recorded',
      message: `${row ? `“${row.name}” now expires` : 'New expiry date:'} ${fmtDate(expiryDate)}.`,
    });
  };

  // Loading no longer replaces the page — it keeps its shape and the list fills into it.
  const phase = listPhase({ loading, rowCount: filtered.length });
  if (error) return <div style={{ padding: '20px 4px', color: 'var(--danger)' }}>{error}</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(240px, 300px) 1fr', gap: '18px', alignItems: 'start' }}>
      {/* Roster picker */}
      <div style={{ ...card, padding: '12px', position: narrow ? 'static' : 'sticky', top: '12px' }}>
        <div style={{ position: 'relative', marginBottom: '10px' }}>
          <Search size={13} style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find an assayer…"
            style={{ width: '100%', padding: '7px 10px 7px 28px', fontSize: '12.5px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)' }}
          />
        </div>
        <div style={{ maxHeight: '68vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {phase === 'skeleton' && <SkeletonList rows={7} height={44} />}
          {filtered.map((a) => {
            const active = a.id === selectedId;
            const alert = certificationAlert(a);
            return (
              <button
                key={a.id}
                onClick={() => setSelectedId(a.id)}
                style={{
                  textAlign: 'left', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer', border: 'none',
                  background: active ? 'var(--status-pending-bg)' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--text-secondary)',
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.displayName}</span>
                  {alert && (
                    <AlertTriangle
                      size={12}
                      style={{ flexShrink: 0, color: alert === 'expired' ? 'var(--danger)' : 'var(--warning)' }}
                      aria-label={alert === 'expired' ? 'Certificate has run out' : 'Certificate runs out soon'}
                    />
                  )}
                </div>
                <div style={{ fontSize: '11px', color: alert === 'expired' ? 'var(--danger)' : 'var(--text-muted)' }}>
                  {alert === 'expired'
                    ? 'Certificate has run out — cannot be given work'
                    : alert === 'expiring'
                      ? 'Certificate runs out within 30 days'
                      : `${a.assayerCode}${a.district ? ` · ${a.district}` : ''}`}
                </div>
              </button>
            );
          })}
          {phase === 'empty' && <Empty>No assayer matches “{search}”.</Empty>}
        </div>
      </div>

      {/* What this person can do, and what their certificates say */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {actionError && (
          <div style={{ ...card, borderLeft: '3px solid var(--danger)', color: 'var(--danger)', fontSize: '12.5px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <AlertTriangle size={14} style={{ flexShrink: 0 }} /> {actionError}
          </div>
        )}
        {selected && (
          <div style={{ ...card }}>
            <div style={{ fontSize: '16px', fontWeight: 700 }}>{selected.displayName}</div>
            {/* Was the raw column value ("ON_LEAVE"). The shared label is what every other
                workforce surface prints, so the two can never read differently. */}
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {selected.assayerCode} · {assayerLifecycleLabel(selected.lifecycleStatus)}
            </div>
            {/*
              Said in one sentence, because nothing on the old screen explained why any of it
              mattered. A clerk reading four lists of words had no way to know that these entries
              are what the planner matches on, or that a certificate past its date takes the person
              out of the running entirely — so entries were left half-recorded as decoration.
            */}
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px', lineHeight: 1.5 }}>
              What is recorded here decides the work {selected.displayName.split(' ')[0]} can be matched to.
              A certificate whose date has passed takes them out of the running until the new date is entered below.
            </div>
          </div>
        )}

        {(Object.keys(TYPE_META) as AttrType[]).map((type) => (
          <AttributeSection
            /*
             * Keyed by assayer AND attribute type. Keying by type alone kept the same section
             * instances mounted while the selected assayer changed, so the "add" row's typed name
             * and expiry survived the switch — and adding then recorded that skill/certification
             * against whoever was selected second.
             */
            key={`${selectedId ?? 'none'}:${type}`}
            type={type}
            rows={byType(type)}
            vocab={vocab[type] ?? []}
            canManage={canManage}
            busy={attrsLoading}
            onAdd={addAttr}
            onRemove={removeAttr}
            onUpdateExpiry={updateExpiry}
          />
        ))}
      </div>
      {confirmDialog}
    </div>
  );
};

const AttributeSection: React.FC<{
  type: AttrType;
  rows: WorkforceAttribute[];
  vocab: Array<{ name: string; assayerCount: number }>;
  canManage: boolean;
  busy: boolean;
  onAdd: (type: AttrType, name: string, expiry?: string) => Promise<void>;
  onRemove: (row: WorkforceAttribute) => Promise<void>;
  onUpdateExpiry: (id: string, expiry: string) => Promise<void>;
}> = ({ type, rows, vocab, canManage, busy, onAdd, onRemove, onUpdateExpiry }) => {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('');
  const [saving, setSaving] = useState(false);
  /**
   * Picking from the register is the default; typing a brand-new name is behind a disclosure.
   *
   * These names are matched by exact string comparison, so "Gold Valuar" is never rejected — it
   * simply becomes a competency nobody holds, and the branch requiring it quietly matches no one.
   * A free-text box made that the easiest thing to do by accident. The write path is preserved
   * in full, because this page is the only place a genuinely new certification can be recorded.
   */
  const [newName, setNewName] = useState(false);

  const held = new Set(rows.map((r) => r.name.toLowerCase()));
  const suggestions = vocab.filter((v) => !held.has(v.name.toLowerCase()));

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onAdd(type, name, meta.hasExpiry ? expiry : undefined);
      setName('');
      setExpiry('');
      setNewName(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ ...card }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <Icon size={15} style={{ color: 'var(--accent)' }} />
        <span style={{ ...label, fontSize: '12px' }}>{meta.label}</span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>({rows.length})</span>
      </div>

      {/*
        The renewal instruction, said where the renewal is made. This page is the only place in the
        system a new expiry date can be entered, and the way to enter one was an unlabelled little
        date box at the end of a row — so the common outcome was a clerk holding a renewed
        certificate, seeing "expired" on screen, and going to look for an "upload" or "renew"
        button that does not exist anywhere.
      */}
      {meta.hasExpiry && canManage && rows.length > 0 && (
        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginBottom: '10px', lineHeight: 1.5 }}>
          Renewed a certificate? Change the date at the end of its row to the new expiry date —
          it saves as soon as you click away, and no other screen records renewals.
        </div>
      )}

      {rows.length === 0 ? (
        <Empty>
          {meta.hasExpiry
            ? 'No certificates recorded for this person yet. Add one below with the date it runs out — until it is here, no branch that asks for a certificate will match them.'
            : `No ${meta.label.toLowerCase()} recorded for this person yet. Add one below so they can be matched to work that asks for it.`}
        </Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {rows.map((r) => {
            const days = daysUntil(r.expiryDate);
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 10px', background: 'var(--bg-surface-2)', borderRadius: '8px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{r.name}</span>
                {meta.hasExpiry && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
                    {days !== null && <ExpiryChip days={days} />}
                    {canManage && (
                      <input
                        type="date"
                        defaultValue={r.expiryDate ? r.expiryDate.slice(0, 10) : ''}
                        /*
                         * Saved when the field is left, not on every keystroke. A date input
                         * fires `change` for each edited part, so typing a year sent a PUT for
                         * "0002-…", then "0202-…", then the real date — three writes, two of
                         * them recording a certification as decades expired. Whoever looked in
                         * between saw a person wrongly out of the assignable pool.
                         */
                        onBlur={(e) => {
                          const next = e.target.value;
                          const current = r.expiryDate ? r.expiryDate.slice(0, 10) : '';
                          if (!next || next === current) return;
                          onUpdateExpiry(r.id, next);
                        }}
                        min="2000-01-01"
                        title="Date this certificate runs out. Change it to record a renewal — it saves when you click away."
                        aria-label={`Expiry date for ${r.name} — change it to record a renewal`}
                        style={{ fontSize: '11px', padding: '3px 6px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-secondary)' }}
                      />
                    )}
                  </div>
                )}
                {canManage && (
                  <button
                    onClick={() => onRemove(r)}
                    title={`Remove ${r.name}`}
                    style={{ marginLeft: meta.hasExpiry ? 0 : 'auto', background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: '2px', display: 'flex' }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {meta.hasExpiry && rows.some((r) => { const d = daysUntil(r.expiryDate); return d !== null && d < 0; }) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', fontSize: '11.5px', color: 'var(--danger)' }}>
          <AlertTriangle size={12} /> This person cannot be given work that needs this certificate until a new expiry date is entered above.
        </div>
      )}

      {canManage && (
        <>
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/*
            Names already in use first. `single` because one row is added at a time and the expiry date
            below belongs to that one row — a multi-select would need one date per chip, which is
            the form this page deliberately does not have.
          */}
          {!newName && (
            <ChipMultiSelect
              single
              /*
                The count is the TOTAL number of assayers recorded under that exact
                name — `COUNT(DISTINCT assayer_id)` over the whole roster, not "others besides
                this one". Shown because it is the useful signal when choosing between two
                near-identical names: the one nobody else holds is usually the typo.
              */
              options={suggestions.map((s) => ({
                value: s.name,
                label: `${s.name} · held by ${s.assayerCount} ${s.assayerCount === 1 ? 'person' : 'people'}`,
              }))}
              value={name ? [name] : []}
              onChange={(next) => setName(next[0] ?? '')}
              searchPlaceholder={`Search ${meta.label.toLowerCase()}…`}
              emptyText={`This person already has every ${meta.label.toLowerCase().replace(/s$/, '')} used elsewhere in the system. To record one under a new name, use the link below.`}
              aria-label={`Add a ${meta.label.toLowerCase().replace(/s$/, '')} already used elsewhere`}
            />
          )}
          {newName && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              autoFocus
              placeholder={`Name of the new ${meta.label.toLowerCase().replace(/s$/, '')}`}
              style={{ padding: '7px 10px', fontSize: '12.5px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)' }}
            />
          )}
          <button
            type="button"
            onClick={() => { setNewName((v) => !v); setName(''); }}
            style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, fontSize: '11.5px', fontWeight: 600, color: 'var(--accent)', cursor: 'pointer' }}
          >
            {newName
              ? '← Choose from the existing names instead'
              : `Not in the list? Record a new ${meta.label.toLowerCase().replace(/s$/, '')} name`}
          </button>
        </div>
        <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {/*
            The date box was bare: a clerk adding a certificate saw two controls and no clue that
            the second one was the date the certificate runs out, or that leaving it blank means
            the system will never warn anyone when it lapses. Saying both, out loud, next to it.
          */}
          {meta.hasExpiry && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>
              Date it runs out (leave blank if it never does)
              <input
                type="date"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                title="The date this certificate stops being valid. Without it, nobody is warned when it lapses."
                style={{ padding: '7px 8px', fontSize: '12px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-secondary)' }}
              />
            </label>
          )}
          <button
            onClick={submit}
            disabled={!name.trim() || saving || busy}
            className="btn btn-primary"
            style={{ padding: '7px 14px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px', opacity: !name.trim() || saving ? 0.5 : 1 }}
          >
            <Plus size={13} /> Add
          </button>
        </div>
        </>
      )}
    </div>
  );
};
