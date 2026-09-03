import React, { useEffect, useMemo, useState } from 'react';
import { Wallet, Pencil, Plus, AlertTriangle, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { onboardingNextStep } from '@fapoms/shared';
import { api } from '../../services/api';
import { fetchWholeAssayerRoster } from '../../services/assayer-roster';
import { userMessage } from '../../services/errors';
import { AlertBanner, DataTable, SearchInput } from '../../components/ui';
import { listPhase } from '../../components/ui/list-phase';
import { card, label, Empty, Notice, Lede, fmtDate } from './hr-ui';
import { counted } from '../../utils/plural';
import { useHr } from './HrLayout';
import { CommercialProfileModal, formatMoney, type CommercialProfile } from './CommercialProfileModal';

/**
 * Pay & terms.
 *
 * Commercial profiles could only be seen and edited one assayer at a time, through a modal
 * buried in the detail drawer. There was no way to see the whole roster's rate card at once —
 * to compare terms, or to find who has no active profile and is therefore being priced at the
 * client's default fee. This page is that view, backed by a single batched call rather than one
 * request per assayer.
 *
 * "In force today" is the same rule the fee calculator uses: the profile effective on the date,
 * newest start winning. A profile dated in the future is flagged, not shown as the current rate,
 * so the pay an assayer is actually being quoted is never confused with one that has not started.
 */

interface AssayerLite {
  id: string;
  assayerCode: string;
  displayName: string;
  district: string | null;
  lifecycleStatus: string;
  /**
   * Banking is not part of the commercial profile — it lives on the assayer record, behind the
   * roster's Edit form. This page priced everybody and never mentioned it, which is how all
   * eight people ended up with rates and no account to pay them into.
   */
  bankAccountNumber: string | null;
  ifscCode: string | null;
}

const bankMissing = (a: AssayerLite) => !a.bankAccountNumber?.trim() || !a.ifscCode?.trim();

interface RosterPayRow {
  assayerId: string;
  profile: CommercialProfile | null;
  hasFutureProfile: boolean;
}

type Filter = 'all' | 'priced' | 'unpriced';

/**
 * Does this person get paid their OWN agreed fee, or the client's default?
 *
 * The screen used to answer "do they have a profile row?", which is not the same question.
 * `FeePolicyService.resolveBaseFee` only uses a profile's base fee when it is **greater than
 * zero** — a profile saved with the base fee left blank falls back to the client's contracted
 * default exactly as if no profile existed at all. Six of the eight live profiles carry a zero in
 * at least one rate box, so this is not a theoretical case: those people were counted under "Have
 * a rate card", and the clerk had no way to see that the system was quietly paying them the
 * default anyway. Same rule, same source, one answer.
 */
const paidOwnFee = (row?: RosterPayRow): boolean => Number(row?.profile?.baseFee ?? 0) > 0;

/**
 * A rate box left at zero is not "₹0 per hour agreed" — it is a box nobody filled in. Printing
 * "₹0" made an unfilled box look like a deliberate term of employment.
 */
const rate = (value: number | string | null | undefined, currency?: string | null): React.ReactNode =>
  Number(value ?? 0) > 0
    ? formatMoney(value, currency)
    : <span title="Nothing agreed for this — it was left blank" style={{ color: 'var(--text-muted)' }}>Not set</span>;

/**
 * One rate off a row, and the difference between "no terms exist" and "this box was left blank".
 *
 * Two different absences that must not print the same word: a person with no pay terms at all has
 * nothing to say about their hourly rate, while a person whose terms exist with the hourly box
 * empty has a term nobody agreed. The first is a dash; the second is "Not set".
 */
const rateOf = (
  row: RosterPayRow | undefined,
  pick: (p: CommercialProfile) => number | string | null | undefined,
): React.ReactNode => (row?.profile
  ? rate(pick(row.profile), row.profile.currency)
  : <span style={{ color: 'var(--text-muted)' }}>—</span>);

export const HrPayPage: React.FC = () => {

  const { canManage } = useHr();
  const [roster, setRoster] = useState<AssayerLite[]>([]);
  const [pay, setPay] = useState<Record<string, RosterPayRow>>({});
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ assayerId: string; profile: CommercialProfile | null } | null>(null);
  /**
   * Set only when the roster could not all be loaded, which the four tiles above have to admit to.
   * Null on any roster the loader got through in full, which is the normal case.
   */
  const [shortfall, setShortfall] = useState<{ shown: number; total: number } | null>(null);

  /**
   * Everybody, in as many requests as it takes — not the first thousand rows.
   *
   * This asked for `?limit=1000` and counted what arrived. On the customer's roster of 1,155
   * appraisers that meant 155 people were absent from the table and absent from every figure on
   * it: "On the roster" read 1,000, and "Cannot be paid — no bank details" counted only the
   * thousand it had, so a person with no account number could be sitting outside the page while
   * this screen reported the roster fully banked. Nothing said the list was partial. The four
   * tiles are the reason this has to be the whole roster rather than a warning — a count is either
   * of everyone or it is wrong.
   */
  const load = async () => {
    try {
      const [everyone, rows] = await Promise.all([
        fetchWholeAssayerRoster<AssayerLite>(),
        api.request<RosterPayRow[]>('/assayers/commercial/roster'),
      ]);
      setRoster(everyone.people);
      setShortfall(everyone.missing > 0 ? { shown: everyone.people.length, total: everyone.total } : null);
      setPay(Object.fromEntries(rows.map((r) => [r.assayerId, r])));
    } catch (e) {
      // userMessage, not `.message` — the raw one can be "Request failed with status code 403".
      setError(userMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return roster
      .filter((a) => !q || a.displayName.toLowerCase().includes(q) || a.assayerCode.toLowerCase().includes(q))
      .filter((a) => {
        const has = paidOwnFee(pay[a.id]);
        return filter === 'all' || (filter === 'priced' ? has : !has);
      });
  }, [roster, pay, search, filter]);

  const unpricedCount = roster.filter((a) => !paidOwnFee(pay[a.id])).length;
  const unbankedCount = roster.filter(bankMissing).length;

  // The error still takes over the screen — there is nothing to show and something to fix.
  // Loading does not: see below, where the page keeps its shape and the rows fill in.
  if (error) return <AlertBanner type="error" message={error} style={{ margin: '20px 4px' }} />;

  /**
   * The page keeps its own shape while it loads.
   *
   * It used to return a line of text instead of itself, so opening it showed an empty panel
   * where the tiles and the table belong and then everything appeared at once. The tiles read
   * zero until the answer lands rather than claiming a total nobody counted.
   */
  const phase = listPhase({ loading, rowCount: rows.length });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/*
        Above the tiles, because it is the tiles it is about: if some of the roster is missing then
        every figure below is a count of part of it, and a wrong count with nothing beside it is
        read as a right one.
      */}
      {shortfall && (
        <Notice tone="warning">
          Only {shortfall.shown} of the {shortfall.total} people on the roster could be loaded, so
          the counts and the table below leave {shortfall.total - shortfall.shown} out. Reload the
          page to try again.
        </Notice>
      )}

      <Lede>
        What each person is paid, side by side. {unpricedCount > 0
          ? `${counted(unpricedCount, 'person', 'people')} have no agreed base fee of their own, so every audit they do is paid at the client’s contracted default — set their terms from the row.`
          : 'Everybody has their own agreed base fee; nothing here is falling back to a client default.'}
      </Lede>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <button onClick={() => setFilter('all')} style={tile(filter === 'all')}>
          <div style={statValue}>{roster.length}</div>
          <div style={label}>On the roster</div>
        </button>
        <button onClick={() => setFilter('priced')} style={tile(filter === 'priced')}>
          <div style={statValue}>{roster.length - unpricedCount}</div>
          <div style={label}>Paid their own agreed fee</div>
        </button>
        <button onClick={() => setFilter('unpriced')} style={tile(filter === 'unpriced', unpricedCount > 0)}>
          <div style={{ ...statValue, color: unpricedCount > 0 ? 'var(--warning)' : undefined }}>{unpricedCount}</div>
          <div style={label}>Paid the client's default fee</div>
        </button>
        {/*
          Not a filter — a count with nothing behind it on this page, because bank details are not
          edited here. Shown anyway: a rate card with no account behind it produces a payout that
          cannot be sent, and this is the screen where someone is thinking about being paid.
        */}
        <div style={{ ...tile(false, unbankedCount > 0), cursor: 'default' }}>
          <div style={{ ...statValue, color: unbankedCount > 0 ? 'var(--danger)' : undefined }}>{unbankedCount}</div>
          <div style={label}>Cannot be paid — no bank details</div>
        </div>
      </div>

      {unbankedCount > 0 && (
        <Notice tone="danger">
          Account number and IFSC are part of the assayer's own record, not their rate card. Use
          the “Add bank details” link on any row below — it opens that person's record with the
          Financial section ready to fill in.
        </Notice>
      )}

      {filter === 'unpriced' && unpricedCount > 0 && (
        <Notice tone="warning">
          These people have no base fee of their own in force today — either no pay terms at all, or
          pay terms saved with the base fee left at zero. Either way every audit they do is paid at
          the client's contracted default fee. Use “Set pay terms” on a row to agree their own.
        </Notice>
      )}

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
          <Wallet size={15} style={{ color: 'var(--accent)' }} />
          <span style={{ ...label, fontSize: '12px' }}>What each person is paid today</span>
          {/* The shared one. This was the magnifier-in-a-relative-wrapper written out by hand for
              the ninth time, a pixel or two off the eight others. */}
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Find an assayer…"
            flex={false}
            compact
            style={{ marginLeft: 'auto', minWidth: '200px' }}
          />
        </div>

        {/*
          The empty state is INSIDE the table now, which fixes a bug the old markup had built in:
          it read `rows.length === 0 ? <Empty> : <table>`, and the skeleton rows lived inside that
          table — so on a first load, with no rows yet, the page showed "Nobody is on the roster
          yet" to somebody whose roster was still being fetched. `listPhase` exists precisely to
          keep an empty answer and an unarrived one apart, and this screen was throwing that away
          one line after computing it.
        */}
        <DataTable<AssayerLite>
          density="compact"
          rows={phase === 'skeleton' ? [] : rows}
          rowKey={(a) => a.id}
          loading={phase === 'skeleton'}
          loadingRows={6}
          emptyState={(
            <Empty>
              {search.trim()
                ? `Nobody on the roster is called “${search.trim()}”. Check the spelling, or clear the search box to see everyone.`
                : filter === 'unpriced'
                  ? 'Everyone on the roster has their own agreed base fee — nobody is falling back to the client default fee.'
                  : filter === 'priced'
                    ? 'Nobody has their own agreed base fee yet. Use “Set pay terms” on a row after switching to “On the roster”, and every audit that person does will be paid at their agreed rate instead of the client default.'
                    : 'Nobody is on the roster yet. People appear here as soon as they are added under Workforce, and their pay terms are set from this screen.'}
            </Empty>
          )}
          columns={[
            {
              key: 'person',
              header: 'Person',
              render: (a) => (
                <>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{a.displayName}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{a.assayerCode}{a.district ? ` · ${a.district}` : ''}</div>
                  {/*
                    Somebody still joining is not a pricing omission, and this page had no way of
                    saying so: `lifecycleStatus` was fetched, typed, and then read by nothing, so a
                    trainee sat in the table beside working assayers with the same amber "paid the
                    client default" against them and no hint that they cannot be sent anywhere yet.

                    The words are `ONBOARDING_NEXT_STEP` from @fapoms/shared — the same sentence the
                    planner prints when it refuses this person work, so a clerk who arrives here
                    from that refusal reads the instruction they were already given rather than a
                    second wording of it.
                  */}
                  {onboardingNextStep(a.lifecycleStatus) && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
                      Still joining — {onboardingNextStep(a.lifecycleStatus)}
                    </div>
                  )}
                  {bankMissing(a) && (
                    <Link
                      /**
                       * `section=financial` so the edit form opens on the Financial tab. Without
                       * it this landed on the top of a four-tab form and the bank fields — the
                       * entire reason for following this link — were three clicks away. The modal
                       * reads the parameter itself (see AssayerForms), so nothing has to be
                       * threaded through the roster.
                       */
                      to={`/hr/roster?assayer=${a.id}&section=financial`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: 600, color: 'var(--danger)', marginTop: '3px' }}
                    >
                      <AlertTriangle size={11} /> No bank details — add them
                    </Link>
                  )}
                </>
              ),
            },
            {
              key: 'base',
              // Every column says per what. "Daily / Hourly / Travel" over four rupee figures left
              // a clerk to guess whether ₹3,600 was a day, a visit or a month — and the only column
              // that decides what is actually paid was indistinguishable from the three that do not.
              header: 'Base fee (per audit) — what is paid',
              align: 'right',
              render: (a) => {
                const row = pay[a.id];
                const p = row?.profile;
                /*
                  ONE PRESENTATION FOR ONE FACT. Both "no pay terms at all" and "pay terms with the
                  base fee left at zero" mean the same thing to the person being paid: the client's
                  default fee. They used to look completely different — the first was a sentence
                  spanning five columns, the second a small amber line under a rupee figure — so a
                  clerk scanning this column could not see that the two rows were in the same state.
                */
                if (!p) {
                  return (
                    <>
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                      <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--warning)', marginTop: '2px' }}>
                        no pay terms · paid the client default
                      </div>
                    </>
                  );
                }
                return (
                  <>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{rate(p.baseFee, p.currency)}</span>
                    {!paidOwnFee(row) && (
                      <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--warning)', marginTop: '2px' }}>
                        paid the client default
                      </div>
                    )}
                  </>
                );
              },
            },
            { key: 'daily', header: 'Daily rate', align: 'right', render: (a) => <>{rateOf(pay[a.id], (p) => p.dailyRate)}</> },
            { key: 'hourly', header: 'Hourly rate', align: 'right', render: (a) => <>{rateOf(pay[a.id], (p) => p.hourlyRate)}</> },
            { key: 'travel', header: 'Travel (per trip)', align: 'right', render: (a) => <>{rateOf(pay[a.id], (p) => p.travelReimbursement)}</> },
            {
              key: 'from',
              header: 'These terms apply from',
              align: 'right',
              render: (a) => {
                const row = pay[a.id];
                if (!row?.profile) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
                return (
                  <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                    {fmtDate(row.profile.effectiveStartDate)}
                    {/*
                      The clock icon on its own said nothing: hovering for a tooltip is not how
                      anyone reads a table, so "these are not the rates from next month" was
                      information only a mouse could find.
                    */}
                    {row.hasFutureProfile && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end', color: 'var(--accent)', marginTop: '2px' }}>
                        <Clock size={11} /> <span>Different terms start later</span>
                      </div>
                    )}
                  </span>
                );
              },
            },
            {
              key: 'act',
              header: '',
              align: 'right',
              render: (a) => (canManage ? (
                <button onClick={() => setEditing({ assayerId: a.id, profile: pay[a.id]?.profile ?? null })}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', fontWeight: 600, padding: '5px 10px', borderRadius: '7px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}>
                  {pay[a.id]?.profile ? <><Pencil size={12} /> Change pay</> : <><Plus size={12} /> Set pay terms</>}
                </button>
              ) : null),
            },
          ]}
        />
      </div>

      {editing && (
        <CommercialProfileModal
          open
          assayerId={editing.assayerId}
          profile={editing.profile}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
};

const statValue: React.CSSProperties = { fontSize: '24px', fontWeight: 700, lineHeight: 1.1 };
const tile = (active: boolean, warn = false): React.CSSProperties => ({
  ...card, flex: '1 1 150px', minWidth: 0, textAlign: 'left', cursor: 'pointer',
  border: `1px solid ${active ? (warn ? 'var(--warning)' : 'var(--accent)') : 'var(--border-color)'}`,
});
