import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Plus, Calendar, FileText } from 'lucide-react';

interface Assayer {
  id: string;
  assayerCode: string;
  displayName: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  state: string;
  district: string;
  city: string;
  status: string;
}

interface CommercialProfile {
  id: string;
  baseFee: number;
  hourlyRate: number;
  dailyRate: number;
  travelReimbursement: number;
  accommodationAllowance: number;
  mealAllowance: number;
  currency: string;
  effectiveStartDate: string;
  effectiveEndDate: string | null;
}

export const Assayers: React.FC = () => {
  const [assayers, setAssayers] = useState<Assayer[]>([]);
  const [selectedAssayer, setSelectedAssayer] = useState<Assayer | null>(null);
  const [commercials, setCommercials] = useState<CommercialProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);

  // Form states for profile creation/edit
  const [baseFee, setBaseFee] = useState(0);
  const [hourlyRate, setHourlyRate] = useState(0);
  const [dailyRate, setDailyRate] = useState(0);
  const [travelReimbursement, setTravelReimbursement] = useState(0);
  const [accommodationAllowance, setAccommodationAllowance] = useState(0);
  const [mealAllowance, setMealAllowance] = useState(0);
  const [currency] = useState('INR');
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    fetchAssayers();
  }, []);

  const fetchAssayers = async () => {
    setLoading(true);
    try {
      const data = await api.request<Assayer[]>('/assayers');
      setAssayers(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const selectAssayer = async (assayer: Assayer) => {
    setSelectedAssayer(assayer);
    try {
      const data = await api.request<CommercialProfile[]>(`/assayers/${assayer.id}/commercial`);
      setCommercials(data);
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAssayer) return;
    setSubmitting(true);

    try {
      await api.request(`/assayers/${selectedAssayer.id}/commercial`, {
        method: 'POST',
        body: JSON.stringify({
          baseFee,
          hourlyRate,
          dailyRate,
          travelReimbursement,
          accommodationAllowance,
          mealAllowance,
          currency,
          effectiveStartDate: new Date(startDate).toISOString(),
          effectiveEndDate: endDate ? new Date(endDate).toISOString() : null,
        }),
      });
      setShowProfileModal(false);
      selectAssayer(selectedAssayer); // Reload commercial rates
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save commercial profile');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '350px 1fr', gap: '24px', height: 'calc(100vh - 120px)' }}>
      {/* Assayers list */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '20px', borderBottom: '1px solid var(--border-color)' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>Assayers Workforce</h2>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '20px' }}>Loading assayers...</div>
          ) : assayers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>No assayers registered.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {assayers.map((a) => (
                <div
                  key={a.id}
                  onClick={() => selectAssayer(a)}
                  style={{
                    padding: '12px 16px',
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    background: selectedAssayer?.id === a.id ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                    border: selectedAssayer?.id === a.id ? '1px solid var(--accent-primary)' : '1px solid transparent',
                    transition: 'all 0.2s',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: '14px' }}>{a.displayName}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{a.assayerCode} • {a.city}, {a.state}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Commercial profiles viewer / editor */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '24px', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {selectedAssayer ? (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <div>
                <h2 style={{ fontSize: '22px', fontWeight: 700, margin: 0 }}>{selectedAssayer.displayName}</h2>
                <div style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
                  Commercial & Billing Configuration
                </div>
              </div>
              <button
                onClick={() => setShowProfileModal(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'var(--gradient-neon)',
                  border: 'none',
                  color: '#fff',
                  padding: '10px 18px',
                  borderRadius: 'var(--radius-md)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: 'var(--shadow-neon)',
                }}
              >
                <Plus size={16} /> Add Commercial Rate
              </button>
            </div>

            <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px' }}>Commercial Profile History</h3>
            {commercials.length === 0 ? (
              <div style={{ padding: '30px', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border-color)', color: 'var(--text-muted)' }}>
                No commercial profile configured. Add a commercial rate profile to calculate recommendation costings.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {commercials.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      background: 'rgba(255,255,255,0.01)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-md)',
                      padding: '20px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', marginBottom: '12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                        <Calendar size={16} className="text-indigo" />
                        <span>
                          Effective: {new Date(c.effectiveStartDate).toLocaleDateString()} -{' '}
                          {c.effectiveEndDate ? new Date(c.effectiveEndDate).toLocaleDateString() : 'Present'}
                        </span>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Currency: {c.currency}</div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
                      <div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Base Fee</div>
                        <div style={{ fontWeight: 600, fontSize: '16px' }}>₹{c.baseFee}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Hourly Rate</div>
                        <div style={{ fontWeight: 600, fontSize: '16px' }}>₹{c.hourlyRate}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Daily Rate</div>
                        <div style={{ fontWeight: 600, fontSize: '16px' }}>₹{c.dailyRate}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Travel Reimbursement / km</div>
                        <div style={{ fontWeight: 600, fontSize: '16px' }}>₹{c.travelReimbursement}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Accommodation Allowance</div>
                        <div style={{ fontWeight: 600, fontSize: '16px' }}>₹{c.accommodationAllowance}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Meal Allowance</div>
                        <div style={{ fontWeight: 600, fontSize: '16px' }}>₹{c.mealAllowance}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
            <FileText size={48} style={{ marginBottom: '16px' }} />
            Select an assayer from the workforce panel to manage commercial profiles
          </div>
        )}
      </div>

      {/* Add Profile Modal */}
      {showProfileModal && selectedAssayer && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', width: '550px', padding: '24px', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px' }}>Configure Assayer Rates</h3>
            <form onSubmit={handleSaveProfile}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Base Fee (₹)</label>
                  <input type="number" className="form-input" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={baseFee} onChange={(e) => setBaseFee(Number(e.target.value))} required />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Hourly Rate (₹)</label>
                  <input type="number" className="form-input" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={hourlyRate} onChange={(e) => setHourlyRate(Number(e.target.value))} required />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Daily Rate (₹)</label>
                  <input type="number" className="form-input" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={dailyRate} onChange={(e) => setDailyRate(Number(e.target.value))} required />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Travel Reimbursement Rate (₹/km)</label>
                  <input type="number" className="form-input" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={travelReimbursement} onChange={(e) => setTravelReimbursement(Number(e.target.value))} required />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Accommodation Allowance (₹)</label>
                  <input type="number" className="form-input" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={accommodationAllowance} onChange={(e) => setAccommodationAllowance(Number(e.target.value))} required />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Meal Allowance (₹)</label>
                  <input type="number" className="form-input" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={mealAllowance} onChange={(e) => setMealAllowance(Number(e.target.value))} required />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Effective Start Date</label>
                  <input type="date" className="form-input" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Effective End Date (Optional)</label>
                  <input type="date" className="form-input" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                <button type="button" onClick={() => setShowProfileModal(false)} style={{ background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-muted)', padding: '8px 16px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                <button type="submit" disabled={submitting} style={{ background: 'var(--gradient-neon)', border: 'none', color: '#fff', padding: '8px 16px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer', boxShadow: 'var(--shadow-neon)' }}>{submitting ? 'Saving...' : 'Save Profile'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
