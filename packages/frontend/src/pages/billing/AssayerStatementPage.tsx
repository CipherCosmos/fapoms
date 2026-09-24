import React, { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Banknote, Search } from 'lucide-react';
import { useAssayerStatement } from '../../hooks/useBilling';
import { fetchWholeAssayerRoster } from '../../services/assayer-roster';
import { userMessage } from '../../services/errors';
import { LoadFailure } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import { Select } from '../../components/ui';
import { StatementBody, card } from './AssayerStatementSections';
import { Page } from '../../components/ui/Page';

/**
 * Assayer statement — what an assayer has earned, been paid, and is still owed.
 *
 * Assayers are the party the business pays, yet the finance app had no per-assayer view: the
 * payables tab is a flat cross-assayer list, so "what have we paid this assayer, what do we
 * still owe, show the payment history" could not be answered from the UI. The endpoint existed
 * and only the mobile app (the assayer's own view) consumed it. The finance manager who signs
 * disbursements now has a statement to sign against.
 */

interface AssayerLite {
  id: string;
  assayerCode: string;
  displayName: string;
  district: string | null;
}

export const AssayerStatementPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const assayerId = params.get('assayer') ?? '';

  const [roster, setRoster] = useState<AssayerLite[]>([]);
  const [search, setSearch] = useState('');
  /** Why the dropdown is not showing everyone: a failed load, or a roster too big to load whole. */
  const [rosterProblem, setRosterProblem] = useState<string | null>(null);
  const statement = useAssayerStatement(assayerId || null);

  /**
   * Every page of the roster, and a sentence when that could not be managed.
   *
   * This asked for `?limit=1000` and swallowed any failure. On the customer's roster of 1,155
   * appraisers, the 155 oldest records were missing from the only control on this page — so their
   * statement could not be opened at all, and the dropdown looked like a complete list of the
   * people who have one. The empty-on-failure case was worse still: a caught-and-discarded error
   * left an empty picker that reads as "nobody is on the roster".
   */
  useEffect(() => {
    let cancelled = false;
    fetchWholeAssayerRoster<AssayerLite>()
      .then(({ people, total, missing }) => {
        if (cancelled) return;
        setRoster(people);
        setRosterProblem(
          missing > 0
            ? `Only ${people.length} of the ${total} people on the roster could be loaded, so ${missing} are not in this list. Reload the page to try again.`
            : null,
        );
      })
      .catch((e) => {
        if (!cancelled) setRosterProblem(`The list of assayers could not be loaded. ${userMessage(e)}`);
      });
    return () => { cancelled = true; };
  }, []);

  const setAssayer = (id: string) => setParams(id ? { assayer: id } : {}, { replace: true });

  const q = search.trim().toLowerCase();
  const filtered = q
    ? roster.filter((a) => a.displayName.toLowerCase().includes(q) || a.assayerCode.toLowerCase().includes(q))
    : roster;

  return (
    <Page width="medium">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, margin: 0 }}>Assayer statement</h1>
        <Link to="/billing?tab=payouts" style={{ fontSize: 'var(--text-xs)', color: 'var(--accent)', textDecoration: 'none' }}>← Back to Billing</Link>
      </div>

      <div style={{ ...card, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Banknote size={16} style={{ color: 'var(--accent)' }} />
        <div style={{ position: 'relative' }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find an assayer…"
            style={{ padding: '7px 10px 7px 28px', fontSize: 'var(--text-xs)', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', minWidth: 220 }} />
        </div>
        <Select
          value={assayerId}
          onChange={setAssayer}
          placeholder="Choose an assayer…"
          options={filtered.map((a) => ({ value: a.id, label: `${a.displayName} · ${a.assayerCode}` }))}
          compact
          style={{ minWidth: 240 }}
        />
        {/* A picker that is quietly short of names is indistinguishable from one whose names have
            all been shown, so the difference is stated rather than left to be discovered. */}
        {rosterProblem && (
          <div style={{ flexBasis: '100%', fontSize: 'var(--text-2xs)', color: 'var(--warning)', lineHeight: 1.5 }}>
            {rosterProblem}
          </div>
        )}
      </div>

      {!assayerId && <div style={{ ...card, color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Pick an assayer to see their statement.</div>}
      {/*
        `(statement.error as Error).message` printed whatever the throw carried — a bare
        "Request failed with status code 403", or the raw body of a 500 — to a finance manager
        about to sign a disbursement. `LoadFailure` says the same thing in the words the rest of
        the app uses, and drops the Retry button when retrying cannot help. It also catches the
        paused-with-no-data state `error` alone misses, which here rendered nothing at all: no
        statement, no loading line, no reason.
      */}
      {assayerId && loadFailed(statement) && <LoadFailure loads={[{ label: "this assayer's statement", query: statement }]} />}
      {assayerId && !loadFailed(statement) && statement.isLoading && <div style={{ ...card, color: 'var(--text-muted)' }}>Loading statement…</div>}
      {statement.data && !loadFailed(statement) && <StatementBody data={statement.data} />}
    </Page>
  );
};
