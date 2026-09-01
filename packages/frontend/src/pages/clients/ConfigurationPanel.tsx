import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Save, ShieldCheck, SlidersHorizontal, Upload, UserCheck, UserX } from 'lucide-react';
import { ChipMultiSelect, Select, useToast } from '../../components/ui';
import { useClientDetail, useUpdateClient } from '../../hooks/useClients';
import { useWorkforceVocabulary, asOptions } from '../../hooks/useWorkforceVocabulary';
import { AssayerMultiSelect } from './AssayerMultiSelect';
import { userMessage } from '../../services/errors';

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

/**
 * The five ranking weights this panel can override, each shown with the platform default it
 * replaces and one plain sentence saying what raising it does.
 *
 * These were five boxes labelled "0.0 - 1.0" with no defaults and no explanation, handed to a
 * coordinator. Nothing said what "Cost Weight" meant, or that the boxes accepted -50 and 900
 * quite happily — a negative weight inverts the factor, so a −50 distance weight ranks the
 * furthest assayer first and reads on screen as a configured preference.
 *
 * Defaults are DEFAULT_SCORING_CONFIG.weights in platform/configuration/configuration.resolver.ts;
 * that config carries about eighteen factors and this panel overrides only these five, which is
 * why an untouched field means "leave the platform default alone" rather than "score it zero".
 * They are an expert override, so they sit behind a disclosure — every field still reachable,
 * nothing removed — and the server now refuses anything outside 0–1 whatever the client sends.
 */
const WEIGHT_FIELDS: { key: string; label: string; default: number; help: string }[] = [
  { key: 'distance', label: 'Distance', default: 0.14, help: 'Higher favours assayers closer to the branch.' },
  { key: 'clientPreference', label: 'Client preference', default: 0.05, help: "Higher favours the assayers on this client's preferred list." },
  { key: 'branchFamiliarity', label: 'Branch familiarity', default: 0.06, help: 'Higher favours assayers who have audited this branch before.' },
  { key: 'cost', label: 'Cost', default: 0.05, help: 'Higher favours the cheaper quote when candidates are otherwise similar.' },
  { key: 'performance', label: 'Performance', default: 0.07, help: 'Higher favours assayers with the better audit-quality record.' },
];

const WEIGHT_KEYS = WEIGHT_FIELDS.map((w) => w.key);

const inputStyle: React.CSSProperties = { padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', width: '100%' };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' };
const sectionTitle: React.CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 };

/** One plain sentence under a field: what it does, its range, and what empty means. */
const Hint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.35 }}>{children}</span>
);

/**
 * A skill/certification list, stored as the comma-separated string the submit path already
 * splits on so the payload and the server contract are untouched — the chips are only a way of
 * editing that string, and a value typed before this picker existed still round-trips.
 *
 * `options === null` is "still loading" and `[]` is "the HR-scoped vocabulary is not readable by
 * this role", in which case the original free-text box comes back rather than leaving no way to
 * record a requirement at all.
 */
const CompetencyField: React.FC<{
  label: string;
  hint: string;
  options: string[] | null;
  csv: string;
  onCsvChange: (next: string) => void;
  placeholder: string;
  searchPlaceholder: string;
}> = ({ label, hint, options, csv, onCsvChange, placeholder, searchPlaceholder }) => {
  const values = csv.split(',').map((x) => x.trim()).filter(Boolean);
  return (
    <label style={labelStyle}>
      {label}
      {options === null || options.length === 0 ? (
        <input style={inputStyle} value={csv} onChange={(e) => onCsvChange(e.target.value)} placeholder={placeholder} />
      ) : (
        <ChipMultiSelect
          aria-label={label}
          options={asOptions(options)}
          value={values}
          onChange={(next) => onCsvChange(next.join(', '))}
          searchPlaceholder={searchPlaceholder}
          maxHeight={120}
        />
      )}
      <Hint>{hint}</Hint>
    </label>
  );
};

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
  /** Weights are an expert override; a client that has never set one opens with them collapsed. */
  const [showWeights, setShowWeights] = useState(false);

  /**
   * The roster's own skill and certification vocabulary. These four fields feed the planning
   * scorer by exact string match, so a comma-separated box let "Gold Valuar" through as a
   * requirement no assayer holds — the client then matched nobody on every branch, with an
   * empty candidate list and no hint that a typo caused it.
   */
  const { skills: skillOptions, certifications: certOptions } = useWorkforceVocabulary();

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
    // Open the section when this client already carries weights, so a value in force is never
    // hidden from the person changing the rest of the configuration.
    setShowWeights(WEIGHT_KEYS.some((k) => w[k] != null));
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
      toast({ type: 'error', title: 'Failed to save configuration', message: userMessage(err) });
    }
  };

  if (isLoading) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>;

  // Shown on the collapsed disclosure so an override in force is never invisible.
  const weightsSet = WEIGHT_KEYS.filter((k) => (weights[k] ?? '').trim() !== '').length;

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h4 style={sectionTitle}><ShieldCheck size={14} /> Service &amp; SLA</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <label style={labelStyle}>
            Service Level
            <Select
              value={serviceLevel}
              onChange={setServiceLevel}
              options={SERVICE_LEVELS.map((s) => ({ value: s, label: s }))}
              placeholder="None"
              style={{ width: '100%' }}
            />
          </label>
          {/* Every numeric field below now states its unit, its range and what happens when it is
              left empty. The browser's min/max is a courtesy — the same bounds are enforced in
              ClientService, because the API is also called by the mobile app and by imports. */}
          <label style={labelStyle}>
            Max Response Time (hours)
            <input style={inputStyle} type="number" min={1} max={8760} step={1} value={maxResponseTimeHours} onChange={(e) => setMaxResponseTimeHours(e.target.value)} />
            <Hint>How long the client allows for a first response. 1–8760 hours (a year). Empty means no agreed limit.</Hint>
          </label>
          <label style={labelStyle}>
            Max Audits per Month
            <input style={inputStyle} type="number" min={1} max={100000} step={1} value={maxAuditsPerMonth} onChange={(e) => setMaxAuditsPerMonth(e.target.value)} />
            <Hint>Ceiling on audits raised for this client in a calendar month. Empty means uncapped.</Hint>
          </label>
          <label style={labelStyle}>
            Scheduling Window (days)
            <input style={inputStyle} type="number" min={1} max={365} step={1} value={schedulingWindowDays} onChange={(e) => setSchedulingWindowDays(e.target.value)} />
            <Hint>How far ahead an audit may be booked. 1–365 days. Empty leaves the platform default.</Hint>
          </label>
          <label style={labelStyle}>
            Penalty Rate (%)
            <input style={inputStyle} type="number" min={0} max={100} step={0.5} value={penaltyRate} onChange={(e) => setPenaltyRate(e.target.value)} />
            <Hint>Share of the fee withheld when the SLA is missed. 0–100%. Empty means no penalty.</Hint>
          </label>
          <label style={labelStyle}>
            Default Search Radius (km)
            <input style={inputStyle} type="number" min={1} max={2000} step={1} value={defaultRadius} onChange={(e) => setDefaultRadius(e.target.value)} />
            <Hint>How far from a branch candidates are looked for. 1–2000 km; the platform default is 50.</Hint>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <label style={labelStyle}>
            Minimum Distance (km)
            <input style={inputStyle} type="number" min={0} max={2000} step={1} value={minDistanceKm} onChange={(e) => setMinDistanceKm(e.target.value)} />
            <Hint>Candidates nearer than this are skipped. 0–2000 km; usually left empty.</Hint>
          </label>
          <label style={labelStyle}>
            Maximum Distance (km)
            <input style={inputStyle} type="number" min={0} max={2000} step={1} value={maxDistanceKm} onChange={(e) => setMaxDistanceKm(e.target.value)} />
            <Hint>Candidates further than this are skipped. Must not be below the minimum.</Hint>
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <CompetencyField
            label="Required Skills"
            hint="A candidate without every one of these is excluded."
            options={skillOptions}
            csv={requiredSkills}
            onCsvChange={setRequiredSkills}
            placeholder="Gold Valuation, ..."
            searchPlaceholder="Search skills…"
          />
          <CompetencyField
            label="Preferred Skills"
            hint="Not required — a candidate who has these simply ranks higher."
            options={skillOptions}
            csv={preferredSkills}
            onCsvChange={setPreferredSkills}
            placeholder="Financial Auditing, ..."
            searchPlaceholder="Search skills…"
          />
          <CompetencyField
            label="Required Certifications"
            hint="Must be held and unexpired on the audit date, or the candidate is excluded."
            options={certOptions}
            csv={requiredCerts}
            onCsvChange={setRequiredCerts}
            placeholder="Certified Gold Assayer, ..."
            searchPlaceholder="Search certifications…"
          />
          <CompetencyField
            label="Preferred Certifications"
            hint="Not required — a candidate who holds these ranks higher."
            options={certOptions}
            csv={preferredCerts}
            onCsvChange={setPreferredCerts}
            placeholder="Gold Valuation Specialist, ..."
            searchPlaceholder="Search certifications…"
          />
        </div>
        <div>
          <button
            type="button"
            onClick={() => setShowWeights((v) => !v)}
            aria-expanded={showWeights}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600 }}
          >
            {showWeights ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Advanced — ranking weights
            {!showWeights && weightsSet > 0 && (
              <span style={{ fontWeight: 500, color: 'var(--accent-primary)' }}>({weightsSet} overridden)</span>
            )}
          </button>
          {showWeights && (
            <div style={{ marginTop: 10 }}>
              <p style={{ margin: '0 0 10px 0', fontSize: 12, color: 'var(--text-muted)' }}>
                These change how candidates are ranked for this client only. Leave a box empty to keep the
                platform default shown beside it — an empty box is not a zero. Each value is a share
                between 0 and 1; raising one makes that factor count for more than the others.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
                {WEIGHT_FIELDS.map((f) => (
                  <label key={f.key} style={labelStyle}>
                    {f.label} weight
                    <input
                      style={inputStyle}
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      value={weights[f.key] ?? ''}
                      onChange={(e) => setWeights((w) => ({ ...w, [f.key]: e.target.value }))}
                      placeholder={`Default ${f.default}`}
                    />
                    <Hint>{f.help}</Hint>
                  </label>
                ))}
              </div>
            </div>
          )}
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
        {/*
          * Only fill in a row where this client's file differs. Every field already falls back
          * to the heading shown below it, so a file using the standard headings imports without
          * anything typed here — which the importer used to refuse until all ten were filled.
          */}
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Leave these blank unless this client's branch file uses different column headings.
          Each field already reads the heading shown in its box; fill one in only to override it.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {IMPORT_FIELDS.map((f) => (
            <label key={f.key} style={labelStyle}>
              {f.label} column
              <input
                style={inputStyle}
                value={importMapping[f.key] ?? ''}
                onChange={(e) => setImportMapping((m) => ({ ...m, [f.key]: e.target.value }))}
                // The placeholder is the heading the importer actually falls back to, so an
                // empty box shows what will be read rather than an invented example.
                placeholder={f.label}
              />
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
