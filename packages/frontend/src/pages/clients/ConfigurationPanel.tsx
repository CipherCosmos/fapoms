import React, { useEffect, useState } from 'react';
import { Save, ShieldCheck, SlidersHorizontal, Upload, UserCheck, UserX } from 'lucide-react';
import { useToast } from '../../components/ui';
import { useClientDetail, useUpdateClient } from '../../hooks/useClients';
import { AssayerMultiSelect } from './AssayerMultiSelect';

const WORKING_DAY_OPTIONS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

const SERVICE_LEVELS = ['PREMIUM', 'STANDARD', 'BASIC'];

// Fields available for Excel import, each mapped to a source column header.
const IMPORT_FIELDS: { key: string; label: string }[] = [
  { key: 'branchCode', label: 'Branch Code' },
  { key: 'solId', label: 'SOL ID' },
  { key: 'name', label: 'Branch Name' },
  { key: 'address', label: 'Address' },
  { key: 'state', label: 'State' },
  { key: 'district', label: 'District' },
  { key: 'city', label: 'City' },
  { key: 'pincode', label: 'Pincode' },
  { key: 'latitude', label: 'Latitude' },
  { key: 'longitude', label: 'Longitude' },
];

const WEIGHT_KEYS = ['distance', 'clientPreference', 'branchFamiliarity', 'cost', 'performance'];

// Structured, human-editable form. JSON blobs in the entity are surfaced as
// individual fields so a non-technical operator never touches raw JSON.
export const ConfigurationPanel: React.FC<{ clientId: string }> = ({ clientId }) => {
  const { data: client, isLoading } = useClientDetail(clientId);
  const update = useUpdateClient();
  const { toast } = useToast();

  // ---- SLA & service (dedicated columns) ----
  const [serviceLevel, setServiceLevel] = useState('');
  const [maxResponseTimeHours, setMaxResponseTimeHours] = useState('');
  const [penaltyRate, setPenaltyRate] = useState('');
  const [defaultRadius, setDefaultRadius] = useState('');
  const [workingDays, setWorkingDays] = useState<number[]>([]);
  const [maxAuditsPerMonth, setMaxAuditsPerMonth] = useState('');
  const [schedulingWindowDays, setSchedulingWindowDays] = useState('');

  // ---- Import mapping ----
  const [importMapping, setImportMapping] = useState<Record<string, string>>({});

  // ---- Planning & recommendation ----
  const [minDistanceKm, setMinDistanceKm] = useState('');
  const [maxDistanceKm, setMaxDistanceKm] = useState('');
  const [requiredSkills, setRequiredSkills] = useState('');
  const [preferredSkills, setPreferredSkills] = useState('');
  const [requiredCerts, setRequiredCerts] = useState('');
  const [preferredCerts, setPreferredCerts] = useState('');
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [preferredAssayers, setPreferredAssayers] = useState<string[]>([]);
  const [restrictedAssayers, setRestrictedAssayers] = useState<string[]>([]);

  useEffect(() => {
    if (!client) return;
    const c = client.configuration;
    setServiceLevel(c?.serviceLevel ?? '');
    setMaxResponseTimeHours(c?.maxResponseTimeHours != null ? String(c.maxResponseTimeHours) : '');
    setPenaltyRate(c?.penaltyRate != null ? String(c.penaltyRate) : '');
    setDefaultRadius(c?.defaultRadius != null ? String(c.defaultRadius) : '');
    setWorkingDays(c?.workingDays ?? []);
    setImportMapping((c?.importMapping as Record<string, string>) ?? {});

    const sla = (c?.slaRules as Record<string, unknown>) ?? {};
    setMaxAuditsPerMonth(sla.maxAuditsPerMonth != null ? String(sla.maxAuditsPerMonth) : '');
    setSchedulingWindowDays(sla.schedulingWindowDays != null ? String(sla.schedulingWindowDays) : '');

    const p = client.planningPreferences as Record<string, unknown> | undefined;
    setMinDistanceKm(p?.minDistanceKm != null ? String(p.minDistanceKm) : '');
    setMaxDistanceKm(p?.maxDistanceKm != null ? String(p.maxDistanceKm) : '');
    setRequiredSkills((p?.requiredSkills as string[])?.join(', ') ?? '');
    setPreferredSkills((p?.preferredSkills as string[])?.join(', ') ?? '');
    setRequiredCerts((p?.requiredCertifications as string[])?.join(', ') ?? '');
    setPreferredCerts((p?.preferredCertifications as string[])?.join(', ') ?? '');
    const w = (p?.weights as Record<string, unknown>) ?? {};
    setWeights(Object.fromEntries(WEIGHT_KEYS.filter((k) => w[k] != null).map((k) => [k, String(w[k])])));
    setPreferredAssayers(client.preferredAssayers ?? []);
    setRestrictedAssayers(client.restrictedAssayers ?? []);
  }, [client]);

  const listFromCSV = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const slaRules: Record<string, unknown> = {};
    if (maxAuditsPerMonth) slaRules.maxAuditsPerMonth = Number(maxAuditsPerMonth);
    if (schedulingWindowDays) slaRules.schedulingWindowDays = Number(schedulingWindowDays);
    if (serviceLevel) slaRules.serviceLevel = serviceLevel;
    if (maxResponseTimeHours) slaRules.maxResponseTimeHours = Number(maxResponseTimeHours);

    const planning: Record<string, unknown> = {};
    if (minDistanceKm) planning.minDistanceKm = Number(minDistanceKm);
    if (maxDistanceKm) planning.maxDistanceKm = Number(maxDistanceKm);
    if (requiredSkills.trim()) planning.requiredSkills = listFromCSV(requiredSkills);
    if (preferredSkills.trim()) planning.preferredSkills = listFromCSV(preferredSkills);
    if (requiredCerts.trim()) planning.requiredCertifications = listFromCSV(requiredCerts);
    if (preferredCerts.trim()) planning.preferredCertifications = listFromCSV(preferredCerts);
    const cleanWeights = Object.fromEntries(Object.entries(weights).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Number(v)]));
    if (Object.keys(cleanWeights).length) planning.weights = cleanWeights;

    try {
      await update.mutateAsync({
        id: clientId,
        payload: {
          preferredAssayers,
          restrictedAssayers,
          planningPreferences: Object.keys(planning).length ? planning : undefined,
          configuration: {
            serviceLevel: serviceLevel || undefined,
            maxResponseTimeHours: maxResponseTimeHours ? Number(maxResponseTimeHours) : undefined,
            penaltyRate: penaltyRate ? Number(penaltyRate) : undefined,
            defaultRadius: defaultRadius ? Number(defaultRadius) : undefined,
            workingDays,
            slaRules: Object.keys(slaRules).length ? slaRules : undefined,
            importMapping: Object.keys(importMapping).length ? importMapping : undefined,
          },
        },
      });
      toast('success', 'Configuration saved');
    } catch (err: any) {
      toast('error', err?.message || 'Failed to save configuration');
    }
  };

  if (isLoading) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>;

  const inputStyle: React.CSSProperties = { padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', width: '100%' };
  const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' };
  const sectionTitle: React.CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h4 style={sectionTitle}><ShieldCheck size={14} /> Service &amp; SLA</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <label style={labelStyle}>
            Service Level
            <select style={inputStyle} value={serviceLevel} onChange={(e) => setServiceLevel(e.target.value)}>
              <option value="">None</option>
              {SERVICE_LEVELS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label style={labelStyle}>
            Max Response Time (hours)
            <input style={inputStyle} type="number" value={maxResponseTimeHours} onChange={(e) => setMaxResponseTimeHours(e.target.value)} />
          </label>
          <label style={labelStyle}>
            Max Audits per Month
            <input style={inputStyle} type="number" value={maxAuditsPerMonth} onChange={(e) => setMaxAuditsPerMonth(e.target.value)} />
          </label>
          <label style={labelStyle}>
            Scheduling Window (days)
            <input style={inputStyle} type="number" value={schedulingWindowDays} onChange={(e) => setSchedulingWindowDays(e.target.value)} />
          </label>
          <label style={labelStyle}>
            Penalty Rate (%)
            <input style={inputStyle} type="number" value={penaltyRate} onChange={(e) => setPenaltyRate(e.target.value)} />
          </label>
          <label style={labelStyle}>
            Default Search Radius (km)
            <input style={inputStyle} type="number" value={defaultRadius} onChange={(e) => setDefaultRadius(e.target.value)} />
          </label>
        </div>
        <label style={labelStyle}>
          Working Days
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {WORKING_DAY_OPTIONS.map((d) => {
              const on = workingDays.includes(d.value);
              return (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => setWorkingDays((wd) => on ? wd.filter((x) => x !== d.value) : [...wd, d.value].sort())}
                  style={{ padding: '6px 10px', fontSize: 12, borderRadius: 'var(--radius-sm)', border: on ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)', background: on ? 'var(--status-pending-bg)' : 'var(--bg-primary)', color: on ? 'var(--accent-primary)' : 'var(--text-secondary)', cursor: 'pointer' }}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </label>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h4 style={sectionTitle}><SlidersHorizontal size={14} /> Planning &amp; Recommendations</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={labelStyle}>
            Minimum Distance (km)
            <input style={inputStyle} type="number" value={minDistanceKm} onChange={(e) => setMinDistanceKm(e.target.value)} />
          </label>
          <label style={labelStyle}>
            Maximum Distance (km)
            <input style={inputStyle} type="number" value={maxDistanceKm} onChange={(e) => setMaxDistanceKm(e.target.value)} />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={labelStyle}>
            Required Skills
            <input style={inputStyle} value={requiredSkills} onChange={(e) => setRequiredSkills(e.target.value)} placeholder="Gold Valuation, ..." />
          </label>
          <label style={labelStyle}>
            Preferred Skills
            <input style={inputStyle} value={preferredSkills} onChange={(e) => setPreferredSkills(e.target.value)} placeholder="Financial Auditing, ..." />
          </label>
          <label style={labelStyle}>
            Required Certifications
            <input style={inputStyle} value={requiredCerts} onChange={(e) => setRequiredCerts(e.target.value)} placeholder="Certified Gold Assayer, ..." />
          </label>
          <label style={labelStyle}>
            Preferred Certifications
            <input style={inputStyle} value={preferredCerts} onChange={(e) => setPreferredCerts(e.target.value)} placeholder="Gold Valuation Specialist, ..." />
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
          {WEIGHT_KEYS.map((k) => (
            <label key={k} style={labelStyle}>
              {k.replace(/^\w/, (c) => c.toUpperCase())} Weight
              <input style={inputStyle} type="number" step="0.01" min="0" max="1" value={weights[k] ?? ''} onChange={(e) => setWeights((w) => ({ ...w, [k]: e.target.value }))} placeholder="0.0 - 1.0" />
            </label>
          ))}
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h4 style={sectionTitle}><UserCheck size={14} /> Assayer Preferences</h4>
        <AssayerMultiSelect
          label={<span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><UserCheck size={12} /> Preferred Assayers</span>}
          value={preferredAssayers}
          onChange={setPreferredAssayers}
          exclude={restrictedAssayers}
        />
        <AssayerMultiSelect
          label={<span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><UserX size={12} /> Restricted Assayers</span>}
          value={restrictedAssayers}
          onChange={setRestrictedAssayers}
          exclude={preferredAssayers}
        />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h4 style={sectionTitle}><Upload size={14} /> Branch Import Mapping</h4>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
          For each field below, enter the exact column heading used in the client's branch Excel/CSV file. This maps imported columns to the system fields.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {IMPORT_FIELDS.map((f) => (
            <label key={f.key} style={labelStyle}>
              {f.label} column
              <input style={inputStyle} value={importMapping[f.key] ?? ''} onChange={(e) => setImportMapping((m) => ({ ...m, [f.key]: e.target.value }))} placeholder={`e.g. ${f.label.replace(/\s+/g, '')}`} />
            </label>
          ))}
        </div>
      </section>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" disabled={update.isPending} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Save size={14} /> {update.isPending ? 'Saving...' : 'Save Configuration'}
        </button>
      </div>
    </form>
  );
};
