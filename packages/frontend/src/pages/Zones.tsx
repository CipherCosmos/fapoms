import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Map, Plus, Trash2, Edit2, X, Building2, MapPin, Info } from 'lucide-react';
import { INDIAN_STATES } from '@fapoms/shared';
import { api } from '../services/api';
import { useClientOptions } from '../hooks/useClients';
import { userMessage } from '../services/errors';
import { Modal, AlertBanner, Select, ChipMultiSelect, useConfirm } from '../components/ui';
import { useCurrentRoles, canManageZones, canDeleteZones } from '../hooks/useCurrentRoles';

interface Zone {
  id: string;
  name: string;
  description?: string | null;
  clientId?: string | null;
  states?: string[] | null;
  districts?: string[] | null;
}

/**
 * Territorial zones — the groupings the coverage planner uses to keep audits inside a
 * candidate's operating area.
 *
 * The backend has always had full CRUD for zones (POST/GET/PUT/DELETE /zones), but the web app
 * only ever *read* them, for a planning filter dropdown. So creating or reshaping a zone meant a
 * database edit by an engineer. This is the missing operations surface: an ops manager creates,
 * renames and rescopes zones themselves, which is exactly the self-service the rest of the
 * configuration screens already provide for holidays and rules.
 */
export const Zones: React.FC = () => {
  const roles = useCurrentRoles();
  const canManage = canManageZones(roles);
  const canDelete = canDeleteZones(roles);

  const [showModal, setShowModal] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [clientId, setClientId] = useState<string>('');
  const [selectedStates, setSelectedStates] = useState<string[]>([]);
  const [selectedDistricts, setSelectedDistricts] = useState<string[]>([]);
  /** Only ever shown when the reference data below cannot be read — see `districtOptions`. */
  const [districtsText, setDistrictsText] = useState('');

  /**
   * Districts were a comma-separated free-text box sitting next to a chip list of states, and
   * the coverage planner matches these strings against a branch's own district by exact value.
   * "Kolhapur " or "Ahmadnagar" quietly narrows a zone to nothing, and nothing on the screen
   * says so — the same silent-mismatch trap the states list had already been fixed for.
   *
   * The reference data has always existed: GET /geo/states gives the id for a state name, and
   * GET /geo/states/:id/districts the districts under it. The options are therefore filtered to
   * whatever states are currently selected, which is also what makes the list short enough to
   * pick from at all (India has ~780 districts).
   *
   * `null` = still loading. `[]` on `geoStates` means the endpoint is unreadable or empty, and
   * the old free-text box comes back rather than losing the ability to record a district.
   */
  const [geoStates, setGeoStates] = useState<{ id: string; name: string }[] | null>(null);
  const [districtOptions, setDistrictOptions] = useState<string[] | null>(null);

  React.useEffect(() => {
    api.request<{ id: string; name: string }[]>('/geo/states')
      .then((rows) => setGeoStates(Array.isArray(rows) ? rows : []))
      .catch(() => setGeoStates([]));   // unavailable → free-text fallback
  }, []);

  React.useEffect(() => {
    if (geoStates === null) return;
    if (geoStates.length === 0) { setDistrictOptions([]); return; }
    const ids = selectedStates
      .map((name) => geoStates.find((g) => g.name.toLowerCase() === name.toLowerCase())?.id)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) { setDistrictOptions([]); return; }
    // A state can be deselected while its request is in flight; only the newest result wins.
    let cancelled = false;
    setDistrictOptions(null);
    Promise.all(ids.map((id) =>
      api.request<{ name: string }[]>(`/geo/states/${id}/districts`).catch(() => [] as { name: string }[]),
    )).then((lists) => {
      if (cancelled) return;
      const names = Array.from(new Set(lists.flat().map((d) => d.name).filter(Boolean))).sort((a, b) => a.localeCompare(b));
      setDistrictOptions(names);
    });
    return () => { cancelled = true; };
  }, [selectedStates, geoStates]);

  /** True only when the reference data itself is missing — not when it is merely still loading. */
  const geoUnavailable = geoStates !== null && geoStates.length === 0;

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: clientsRes } = useClientOptions();
  const clients = clientsRes ?? [];

  const { data: zonesRes, isLoading, refetch } = useQuery({
    queryKey: ['zones', 'all'],
    queryFn: () => api.request<Zone[]>('/zones?limit=200'),
  });
  const zones: Zone[] = (Array.isArray(zonesRes) ? zonesRes : (zonesRes as any)?.data) || [];

  const resetForm = () => {
    setName(''); setDescription(''); setClientId(''); setSelectedStates([]); setSelectedDistricts([]); setDistrictsText('');
  };

  const handleOpenCreate = () => {
    setEditingId(null);
    resetForm();
    setShowModal(true);
  };

  const handleOpenEdit = (z: Zone) => {
    setEditingId(z.id);
    setName(z.name);
    setDescription(z.description || '');
    setClientId(z.clientId || '');
    setSelectedStates(z.states || []);
    setSelectedDistricts(z.districts || []);
    setDistrictsText((z.districts || []).join(', '));
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // The picker is the source of truth; the text box only exists when the reference data
    // could not be loaded, and only then is it what gets saved.
    const districts = geoUnavailable
      ? districtsText.split(',').map((d) => d.trim()).filter(Boolean)
      : selectedDistricts;
    // clientId is only sent on create — the update DTO does not accept it, since re-parenting a
    // zone to another client is not a routine edit.
    const base = { name, description: description || null, states: selectedStates, districts };
    setSubmitting(true);
    try {
      if (editingId) {
        await api.request(`/zones/${editingId}`, { method: 'PUT', body: JSON.stringify(base) });
        setSuccess('Zone updated.');
      } else {
        await api.request('/zones', { method: 'POST', body: JSON.stringify({ ...base, clientId: clientId || undefined }) });
        setSuccess('Zone created.');
      }
      setShowModal(false);
      refetch();
    } catch (err: any) {
      setError(`Could not save the zone. ${userMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (z: Zone) => {
    // Deleting a zone orphans every branch grouped under it, and the zone list is a long
    // table of similar names — so this asks for the zone's own name to be typed. That is
    // both un-reflexive and a check that the right row is being deleted.
    const ok = await confirm({
      title: `Delete the "${z.name}" zone?`,
      message: 'Branches grouped under it will be left without a zone.',
      confirmLabel: 'Delete zone',
      reversible: false,
      tone: 'danger',
      confirmPhrase: z.name,
    });
    if (!ok) return;
    try {
      await api.request(`/zones/${z.id}`, { method: 'DELETE' });
      setSuccess('Zone deleted.');
      refetch();
    } catch (err: any) {
      setError(`Delete failed. ${userMessage(err)}`);
    }
  };

  /**
   * Deselecting a state drops the districts that belonged to it. Leaving them behind would
   * keep a district in the zone whose state is no longer part of it — a scope nobody chose.
   * Districts the reference data does not know (older hand-typed values) are kept, since we
   * cannot tell which state they belong to and dropping them would silently narrow the zone.
   */
  const handleStatesChange = (next: string[]) => {
    setSelectedStates(next);
    if (next.length === 0) setSelectedDistricts([]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {confirmDialog}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Map style={{ color: 'var(--accent)' }} /> Territorial Zones
          </h2>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Groupings of states and districts the coverage planner keeps audits within.
          </span>
        </div>
        {canManage && (
          <button onClick={handleOpenCreate} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px' }}>
            <Plus size={14} /> Add Zone
          </button>
        )}
      </div>

      {error && <AlertBanner type="error">{error}</AlertBanner>}
      {success && <AlertBanner type="success">{success}</AlertBanner>}

      <div className="glass-card" style={{ padding: '20px' }}>
        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading zones…</div>
        ) : zones.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
            <Map size={36} style={{ margin: '0 auto 10px', opacity: 0.4 }} />
            <p>No zones defined yet.{canManage ? ' Create one to group branches for coverage planning.' : ''}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table className="table" style={{ width: '100%', minWidth: '640px', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-muted)', fontSize: '12px' }}>
                <th style={{ padding: '10px' }}>Zone</th>
                <th style={{ padding: '10px' }}>Client Scope</th>
                <th style={{ padding: '10px' }}>States</th>
                <th style={{ padding: '10px' }}>Districts</th>
                {canManage && <th style={{ padding: '10px', textAlign: 'right' }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {[...zones].sort((a, b) => a.name.localeCompare(b.name)).map((z) => {
                const matchedClient = clients.find((c: any) => c.id === z.clientId);
                return (
                  <tr key={z.id} style={{ borderBottom: '1px solid var(--border-hair)', fontSize: '13px' }}>
                    <td style={{ padding: '12px 10px' }}>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{z.name}</div>
                      {z.description && <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: 2 }}>{z.description}</div>}
                    </td>
                    <td style={{ padding: '12px 10px', fontSize: '12px' }}>
                      {!z.clientId
                        ? <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>🌐 All clients</span>
                        : <span style={{ color: 'var(--warning)', fontWeight: 600 }}><Building2 size={11} style={{ verticalAlign: '-1px' }} /> {matchedClient?.name || 'Specific client'}</span>}
                    </td>
                    <td style={{ padding: '12px 10px', color: 'var(--text-secondary)' }}>
                      {!z.states || z.states.length === 0
                        ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                        : <span><MapPin size={11} style={{ verticalAlign: '-1px' }} /> {z.states.join(', ')}</span>}
                    </td>
                    <td style={{ padding: '12px 10px', color: 'var(--text-secondary)' }}>
                      {!z.districts || z.districts.length === 0
                        ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                        : z.districts.join(', ')}
                    </td>
                    {canManage && (
                      <td style={{ padding: '12px 10px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                          <button aria-label="Edit zone" onClick={() => handleOpenEdit(z)} style={{ padding: '4px 8px', background: 'rgba(216,174,71,0.1)', border: '1px solid rgba(216,174,71,0.3)', borderRadius: '4px', color: 'var(--accent)', cursor: 'pointer' }}><Edit2 size={12} /></button>
                          {canDelete && (
                            <button aria-label="Delete zone" onClick={() => handleDelete(z)} style={{ padding: '4px 8px', background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: '4px', color: 'var(--danger)', cursor: 'pointer' }}><Trash2 size={12} /></button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', marginTop: '14px', fontSize: '11px', color: 'var(--text-muted)', alignItems: 'center' }}>
          <Info size={12} />
          <span>A zone scoped to a client applies only to that client's branches; an unscoped zone is available to all.</span>
        </div>
      </div>

      {showModal && canManage && (
        <Modal open onClose={() => setShowModal(false)} title={editingId ? 'Edit Zone' : 'Add New Zone'} width="520px" closeIcon={<X size={18} />} asForm onSubmit={handleSubmit}
          footer={
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button type="button" onClick={() => setShowModal(false)} className="btn btn-secondary" disabled={submitting}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Saving…' : 'Save Zone'}</button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Zone Name</label>
              <input type="text" required placeholder="e.g. South Maharashtra" value={name} onChange={(e) => setName(e.target.value)}
                style={{ width: '100%', padding: '9px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }} />
            </div>

            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Description (Optional)</label>
              <input type="text" placeholder="What this zone covers" value={description} onChange={(e) => setDescription(e.target.value)}
                style={{ width: '100%', padding: '9px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }} />
            </div>

            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                Client Scope (Optional){editingId ? ' — set at creation, not editable here' : ''}
              </label>
              <Select
                value={clientId}
                onChange={setClientId}
                disabled={!!editingId}
                options={[{ value: '', label: '🌐 All Clients' }, ...clients.map((c: any) => ({ value: c.id, label: `🏦 ${c.name || c.code}` }))]}
                style={{ width: '100%' }}
              />
            </div>

            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '6px' }}>States in this zone</label>
              <ChipMultiSelect
                aria-label="States in this zone"
                options={INDIAN_STATES}
                value={selectedStates}
                onChange={handleStatesChange}
                searchPlaceholder="Search states…"
                maxHeight={140}
              />
            </div>

            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                Districts (Optional){geoUnavailable ? <span style={{ fontWeight: 400 }}> — comma separated</span> : null}
              </label>
              {geoUnavailable ? (
                <input type="text" placeholder="e.g. Kolhapur, Sangli, Satara" value={districtsText} onChange={(e) => setDistrictsText(e.target.value)}
                  style={{ width: '100%', padding: '9px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }} />
              ) : selectedStates.length === 0 ? (
                <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', padding: '9px', border: '1px dashed var(--border-color)', borderRadius: '6px' }}>
                  Choose a state first — districts are listed per state.
                </div>
              ) : districtOptions === null ? (
                <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', padding: '9px' }}>Loading districts…</div>
              ) : (
                <>
                  <ChipMultiSelect
                    aria-label="Districts in this zone"
                    options={districtOptions.map((d) => ({ value: d, label: d }))}
                    value={selectedDistricts}
                    onChange={setSelectedDistricts}
                    searchPlaceholder="Search districts…"
                    emptyText="No districts on record for the selected state(s)."
                    maxHeight={140}
                  />
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    {selectedDistricts.length === 0
                      ? 'Leave empty to cover every district in the selected states.'
                      : `${selectedDistricts.length} selected.`}
                  </div>
                </>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default Zones;
