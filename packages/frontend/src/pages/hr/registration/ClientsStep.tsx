import React, { useEffect, useMemo, useState } from 'react';
import { Building2, Search } from 'lucide-react';
import { standingAllowsPlanning } from '@fapoms/shared';
import { AlertBanner, Select, useToast } from '../../../components/ui';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { STANDING_CHOICES } from './steps';
import type { Dossier, DossierEmpanelment } from './useRegistration';

/**
 * Which banks will take this person — the question the enrolment never asked.
 *
 * Everything else on this roster is a fact about a person. This is a fact about a *pair*: a bank
 * empanels an individual, and being on ICICI's panel says nothing whatsoever about AU Small's. It
 * lives in `assayer_client_empanelments`, one row per pair, and `PUT /assayers/:id/empanelment/
 * :clientId` has existed all along — on the record's vetting tab, two clicks past a screen nobody
 * opens on the day somebody joins.
 *
 * The cost of leaving it there is measurable and large. `ClientEligibilityFilter` admits only an
 * ACTIVE or RECOMMENDED standing, and `planning.eligibility.noEmpanelmentRow` defaults to BLOCK —
 * so a person with no row at all is excluded from every client's planning run, silently, with a
 * reason nobody reads. 245 of the 548 people currently ACTIVE on the roster are in exactly that
 * state: complete records, correct addresses, pinned homes, and not one assignment they can be
 * offered. The wizard as it stood produced that person every time it was used.
 *
 * So the step is here, and it is prominent, but it does NOT block finishing. "Put forward,
 * waiting for the client to decide" and "waiting on paperwork" are real states a person can be in
 * on their first day, and a registration that refuses to end until a bank has cleared somebody
 * cannot record the person standing in front of the clerk. What it must not do is let the flow
 * finish quietly — see the Review step, which says in plain words that nobody can be given work
 * until one of these is set.
 */

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg-card)',
  padding: '12px 14px',
};

const searchStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px 8px 32px', fontSize: '13px',
  background: 'var(--bg-page)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
  outline: 'none', boxSizing: 'border-box',
};

const reasonStyle: React.CSSProperties = {
  width: '100%', padding: '7px 9px', fontSize: '12.5px', marginTop: '8px',
  background: 'var(--bg-page)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
  outline: 'none', boxSizing: 'border-box',
};

interface Client { id: string; name: string }

/**
 * Every client, so a standing can be recorded against one that has none yet.
 *
 * There are 24 of them and the list is small enough to hold whole; a picker that only offered
 * clients already carrying a row would be able to change a standing and never create one, which
 * is the entire job here.
 */
const useClients = () => {
  const [clients, setClients] = useState<Client[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.request<unknown>('/clients?limit=200')
      .then((d) => {
        const raw = d as { items?: unknown[]; data?: unknown[] } | unknown[];
        const rows = Array.isArray(raw) ? raw : (raw?.items ?? raw?.data ?? []);
        if (alive) {
          setClients((rows as { id: string; name: string }[]).map((c) => ({ id: c.id, name: c.name })));
          setFailed(null);
        }
      })
      .catch((e) => { if (alive) { setClients([]); setFailed(userMessage(e)); } });
    return () => { alive = false; };
  }, []);

  return { clients, clientsFailed: failed };
};

/**
 * One client, its standing, and what that standing means for planning.
 *
 * The consequence is printed under every choice rather than encoded in a colour, because the two
 * states a clerk most needs to tell apart look identical to optimism: "put forward, waiting" makes
 * somebody plannable and "waiting on paperwork" does not, and nothing about either phrase says so.
 */
const ClientRow: React.FC<{
  client: Client;
  standing: DossierEmpanelment | undefined;
  disabled: boolean;
  onSet: (clientId: string, status: string, reason: string) => Promise<void>;
}> = ({ client, standing, disabled, onSet }) => {
  const chosen = STANDING_CHOICES.find((c) => c.value === standing?.status);
  const [reason, setReason] = useState(standing?.statusReason ?? '');

  // A standing saved elsewhere in this session (or reloaded from the server) has to win over a
  // reason box the clerk has not touched, or the next blur would push a stale sentence back over
  // what the dossier now holds.
  const serverReason = standing?.statusReason ?? '';
  useEffect(() => { setReason(serverReason); }, [serverReason]);

  const plannable = standingAllowsPlanning(standing?.status);
  const recorded = Boolean(standing);

  return (
    <div style={{
      ...cardStyle,
      borderColor: recorded ? (plannable ? 'var(--success)' : 'var(--warning)') : 'var(--border-color)',
    }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{client.name}</div>
          <div style={{ fontSize: '12px', color: recorded ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
            {chosen
              ? chosen.consequence
              : standing
                // A standing the desk cannot set from here — resigned, terminated, dormant, or a
                // rejection recorded on the vetting tab. Shown, never silently replaced.
                ? 'Recorded elsewhere on their record. Change it on their record if it is wrong.'
                : 'Nothing recorded. This client will never be offered this person.'}
          </div>
        </div>
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <Select
            value={standing?.status ?? ''}
            onChange={(v) => {
              if (v === (standing?.status ?? '')) return;
              // The reason travels only with a standing that means "not this client". Carrying it
              // across a change to Accepted would file "turned down for X" as the note explaining
              // why somebody IS on the panel, which is worse than having no note at all.
              const keepsReason = STANDING_CHOICES.some((c) => c.value === v && !c.plannable);
              void onSet(client.id, v, keepsReason ? reason : '');
            }}
            disabled={disabled}
            options={STANDING_CHOICES.map((c) => ({
              value: c.value,
              label: c.label,
              sublabel: c.consequence,
            }))}
            placeholder="Not set — choose one"
            aria-label={`Standing with ${client.name}`}
          />
        </div>
      </div>
      {chosen && !chosen.plannable && (
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => { if (reason !== serverReason) void onSet(client.id, standing!.status, reason); }}
          placeholder="Why? Whoever reads this later will only have this sentence."
          aria-label={`Why this standing with ${client.name}`}
          style={reasonStyle}
        />
      )}
    </div>
  );
};

export const ClientsStep: React.FC<{
  assayerId: string | null;
  dossier: Dossier | null;
  onChanged: () => void;
  onBusy: (busy: boolean) => void;
}> = ({ assayerId, dossier, onChanged, onBusy }) => {
  const { clients, clientsFailed } = useClients();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const standings = useMemo(() => {
    const byClient = new Map<string, DossierEmpanelment>();
    for (const e of dossier?.empanelments ?? []) byClient.set(e.clientId, e);
    return byClient;
  }, [dossier]);

  /**
   * Written the moment it is chosen, like a reference and unlike every field on the other steps.
   *
   * Those are columns on one row and travel together in the step's own save; this is a row of its
   * own against another table, and a clerk setting three banks needs to see each one land rather
   * than discover on the last page that one of the three never went.
   */
  const setStanding = async (clientId: string, status: string, reason: string) => {
    if (!assayerId || !status) return;
    onBusy(true);
    setError(null);
    try {
      await api.request(`/assayers/${assayerId}/empanelment/${clientId}`, {
        method: 'PUT',
        body: JSON.stringify({ status, statusReason: reason.trim() || undefined }),
      });
      const name = clients?.find((c) => c.id === clientId)?.name ?? 'this client';
      const choice = STANDING_CHOICES.find((c) => c.value === status);
      toast({
        type: 'success',
        title: `${name} recorded`,
        message: choice?.consequence ?? 'Their standing with this client is saved.',
      });
      onChanged();
    } catch (e) { setError(userMessage(e)); } finally { onBusy(false); }
  };

  const rows = useMemo(() => {
    const list = clients ?? [];
    const q = query.trim().toLowerCase();
    const matching = q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list;
    // Clients with a standing first: on a second visit the clerk is looking for what they already
    // set, and hunting for it down an alphabetical list of two dozen is the whole friction.
    return [...matching].sort((a, b) => {
      const rank = Number(standings.has(b.id)) - Number(standings.has(a.id));
      return rank !== 0 ? rank : a.name.localeCompare(b.name);
    });
  }, [clients, query, standings]);

  const plannableCount = useMemo(
    () => rows.filter((c) => standingAllowsPlanning(standings.get(c.id)?.status)).length,
    [rows, standings],
  );

  if (!assayerId) {
    return (
      <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
        Available once their record is saved.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {error && <AlertBanner type="error" message={error} onClose={() => setError(null)} />}
      {clientsFailed && (
        <AlertBanner
          type="error"
          message={`The list of clients could not be loaded, so no standing can be set here. ${clientsFailed}`}
        />
      )}

      <div style={{
        ...cardStyle,
        background: 'var(--bg-surface-2)',
        borderColor: plannableCount > 0 ? 'var(--success)' : 'var(--warning)',
      }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '7px' }}>
          <Building2 size={15} aria-hidden />
          {plannableCount > 0
            ? `They can be given work for ${plannableCount === 1 ? 'one client' : `${plannableCount} clients`}.`
            : 'No client will be offered this person yet.'}
        </div>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '6px' }}>
          Work is planned one client at a time, and a client is only ever offered somebody they
          have accepted. Set every bank this person has been put forward to — you can finish
          without doing it, and come back to their record later.
        </div>
      </div>

      {(clients?.length ?? 0) > 7 && (
        <div style={{ position: 'relative' }}>
          <Search
            size={14}
            aria-hidden
            style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a bank or client by name"
            aria-label="Find a bank or client by name"
            style={searchStyle}
          />
        </div>
      )}

      {clients === null ? (
        <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Loading the list of clients…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
          {query ? `No client here is called “${query}”.` : 'No clients are set up yet.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {rows.map((c) => (
            <ClientRow
              key={c.id}
              client={c}
              standing={standings.get(c.id)}
              disabled={Boolean(clientsFailed)}
              onSet={setStanding}
            />
          ))}
        </div>
      )}
    </div>
  );
};
