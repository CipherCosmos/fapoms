import React, { useState } from 'react';
import { User, MapPin, Briefcase, Award, CreditCard, Clock, Phone, X, CheckCircle, Edit2, AlertTriangle } from 'lucide-react';
import { INDIAN_STATES, todayDateKey } from '@fapoms/shared';
import { api } from '../../services/api';
import { Modal, useToast } from '../../components/ui';
import { Autocomplete } from '../../components/ui/Autocomplete';
import type { Assayer } from './assayer-shared';
import { STATUS_COLORS } from './assayer-shared';
import { userMessage } from '../../services/errors';

/**
 * Assayer create/edit forms.
 *
 * Split out of the old Assayers page so the redesigned roster can reuse the exact
 * same field definitions and validation instead of growing a second, drifting copy
 * of the workforce form.
 */

const labelStyle = { display: 'block', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' };
const formFieldStyle = { padding: '10px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' as const, outline: 'none', fontSize: '13px' };
const formSelectStyle = { padding: '10px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' as const, outline: 'none', cursor: 'pointer', fontSize: '13px' };

const FIELD_TEXTAREA = new Set(['address', 'notes']);
const FIELD_MONO = new Set(['assayerCode', 'employeeCode', 'employeeId', 'panNumber', 'bankAccountNumber', 'ifscCode']);
const FIELD_TEL = new Set(['phone', 'alternatePhone', 'emergencyContactPhone']);
const FIELD_NUM = new Set(['experienceYears', 'maxDailyWorkload', 'maxWeeklyWorkload']);
const FIELD_TIME = new Set(['workingHoursStart', 'workingHoursEnd']);



const EMPLOYMENT_TYPES: { value: string; label: string }[] = [
  { value: 'FULL_TIME', label: 'Full Time' }, { value: 'PART_TIME', label: 'Part Time' },
  { value: 'CONTRACT', label: 'Contract' }, { value: 'INTERN', label: 'Intern' },
  { value: 'CONSULTANT', label: 'Consultant' }, { value: 'FREELANCE', label: 'Freelance' },
];

const DEPARTMENTS: { value: string; label: string }[] = [
  { value: 'Operations', label: 'Operations' }, { value: 'Gold Testing', label: 'Gold Testing' },
  { value: 'Diamond Testing', label: 'Diamond Testing' }, { value: 'KYC Verification', label: 'KYC Verification' },
  { value: 'Cash Management', label: 'Cash Management' }, { value: 'Logistics', label: 'Logistics' },
  { value: 'Quality Assurance', label: 'Quality Assurance' }, { value: 'Administration', label: 'Administration' },
  { value: 'Finance', label: 'Finance' }, { value: 'Human Resources', label: 'Human Resources' },
  { value: 'Information Technology', label: 'Information Technology' },
];

const EMERGENCY_CONTACT_RELATIONS: { value: string; label: string }[] = [
  { value: 'Spouse', label: 'Spouse' }, { value: 'Parent', label: 'Parent' },
  { value: 'Sibling', label: 'Sibling' }, { value: 'Child', label: 'Child' },
  { value: 'Friend', label: 'Friend' }, { value: 'Colleague', label: 'Colleague' },
  { value: 'Other', label: 'Other' },
];

const PERFORMANCE_RATINGS: { value: string; label: string }[] = [
  { value: '1', label: '1 - Poor' }, { value: '2', label: '2 - Below Average' },
  { value: '3', label: '3 - Average' }, { value: '4', label: '4 - Good' },
  { value: '5', label: '5 - Excellent' },
];

interface FieldDef { key: string; label: string; required?: boolean; type?: string; full?: boolean; placeholder?: string; options?: { value: string; label: string }[] }

const CREATE_FIELDS: FieldDef[] = [
  { key: 'assayerCode', label: 'Assayer Code', required: true },
  { key: 'firstName', label: 'First Name', required: true },
  { key: 'lastName', label: 'Last Name', required: true },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', required: true },
  { key: 'alternatePhone', label: 'Alternate Phone' },
  { key: 'address', label: 'Address', required: true, full: true },
  { key: 'state', label: 'State', required: true, options: INDIAN_STATES },
  { key: 'district', label: 'District', required: true },
  { key: 'city', label: 'City', required: true },
  { key: 'pincode', label: 'Pincode' },
  { key: 'region', label: 'Region' },
  { key: 'employeeId', label: 'Employee ID' },
  { key: 'employeeCode', label: 'Employee Code' },
  { key: 'employmentType', label: 'Employment Type', options: EMPLOYMENT_TYPES },
  { key: 'department', label: 'Department', options: DEPARTMENTS },
  { key: 'joiningDate', label: 'Joining Date', type: 'date' },
  { key: 'panNumber', label: 'PAN Number' },
  { key: 'bankAccountNumber', label: 'Bank Account' },
  { key: 'ifscCode', label: 'IFSC Code' },
  { key: 'experienceYears', label: 'Experience (years)', type: 'number' },
  { key: 'notes', label: 'Notes', full: true },
  { key: 'baseFee', label: 'Base Fee (₹/audit)', type: 'number' },
  { key: 'hourlyRate', label: 'Hourly Rate (₹)', type: 'number' },
  { key: 'dailyRate', label: 'Daily Rate (₹)', type: 'number' },
];

const CREATE_FIELD_GROUPS: FieldGroup[] = [
  { title: 'Personal', icon: <User size={13} />, fields: ['assayerCode', 'firstName', 'lastName', 'email', 'phone', 'alternatePhone'] },
  { title: 'Address', icon: <MapPin size={13} />, fields: ['address', 'city', 'district', 'state', 'pincode', 'region'] },
  { title: 'Employment', icon: <Briefcase size={13} />, fields: ['employeeId', 'employeeCode', 'employmentType', 'department', 'joiningDate'] },
  { title: 'Financial', icon: <CreditCard size={13} />, fields: ['panNumber', 'bankAccountNumber', 'ifscCode'] },
  { title: 'Pay', icon: <CreditCard size={13} />, fields: ['baseFee', 'hourlyRate', 'dailyRate'] },
  { title: 'Skills', icon: <Award size={13} />, fields: ['experienceYears'] },
  { title: 'Other', icon: <Clock size={13} />, fields: ['notes'] },
];

const EDIT_FIELDS: FieldDef[] = [
  { key: 'firstName', label: 'First Name', required: true },
  { key: 'lastName', label: 'Last Name', required: true },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', required: true },
  { key: 'alternatePhone', label: 'Alternate Phone' },
  { key: 'address', label: 'Address', full: true },
  { key: 'state', label: 'State', options: INDIAN_STATES },
  { key: 'district', label: 'District' },
  { key: 'city', label: 'City' },
  { key: 'pincode', label: 'Pincode' },
  { key: 'region', label: 'Region' },
  { key: 'employeeId', label: 'Employee ID' },
  { key: 'employeeCode', label: 'Employee Code' },
  { key: 'employmentType', label: 'Employment Type', options: EMPLOYMENT_TYPES },
  { key: 'department', label: 'Department', options: DEPARTMENTS },
  { key: 'joiningDate', label: 'Joining Date', type: 'date' },
  { key: 'exitDate', label: 'Exit Date', type: 'date' },
  { key: 'terminationDate', label: 'Termination Date', type: 'date' },
  { key: 'managerId', label: 'Manager ID' },
  { key: 'panNumber', label: 'PAN Number' },
  { key: 'bankAccountNumber', label: 'Bank Account' },
  { key: 'ifscCode', label: 'IFSC Code' },
  { key: 'experienceYears', label: 'Experience (years)', type: 'number' },
  { key: 'performanceRating', label: 'Performance Rating', type: 'number', options: PERFORMANCE_RATINGS },
  { key: 'maxDailyWorkload', label: 'Max Daily Workload', type: 'number' },
  { key: 'maxWeeklyWorkload', label: 'Max Weekly Workload', type: 'number' },
  { key: 'emergencyContactName', label: 'Emergency Contact Name' },
  { key: 'emergencyContactPhone', label: 'Emergency Contact Phone' },
  { key: 'emergencyContactRelation', label: 'Emergency Contact Relation', options: EMERGENCY_CONTACT_RELATIONS },
  { key: 'workingHoursStart', label: 'Working Hours Start', placeholder: '09:00' },
  { key: 'workingHoursEnd', label: 'Working Hours End', placeholder: '18:00' },
  { key: 'notes', label: 'Notes', full: true },
];

const GEO_AUTO_FIELDS = new Set(['district', 'city', 'pincode']);

/** Apply a selected real place to the whole address group so state/district/city/pincode stay consistent. */
const applyPlace = (fieldKey: string, place: { label: string; state: string; district: string; pincode: string }, form: Record<string, string>, setForm: (v: Record<string, string>) => void) => {
  const primary = (place.label || '').split(',')[0].trim();
  const next = { ...form };
  if (fieldKey === 'city' || fieldKey === 'pincode') {
    if (place.district) next.district = place.district;
    if (place.state) next.state = place.state;
  }
  if (fieldKey === 'city') next.city = primary;
  if (fieldKey === 'district') {
    next.district = place.district || primary;
    if (place.state) next.state = place.state;
    if (!next.city) next.city = primary;
  }
  if (fieldKey === 'pincode') {
    if (place.pincode) next.pincode = place.pincode;
    next.district = place.district || next.district;
    next.state = place.state || next.state;
    if (!next.city) next.city = primary;
  }
  setForm(next);
};

const renderFormField = (field: FieldDef, form: Record<string, string>, setForm: (v: Record<string, string>) => void) => {
  const val = form[field.key] || '';
  const isTextarea = FIELD_TEXTAREA.has(field.key);
  const isMono = FIELD_MONO.has(field.key);
  const isTel = FIELD_TEL.has(field.key);
  const isNum = FIELD_NUM.has(field.key);
  const isTime = FIELD_TIME.has(field.key);

  const handleChange = (v: string) => {
    if (field.key === 'panNumber' || field.key === 'ifscCode') {
      setForm({ ...form, [field.key]: v.toUpperCase() });
    } else {
      setForm({ ...form, [field.key]: v });
    }
  };

  return (
    <div key={field.key} style={field.full ? { gridColumn: '1 / -1' } : {}}>
      <label style={labelStyle}>
        {field.label}{field.required && <span style={{ color: 'var(--danger)', marginLeft: '2px' }}>*</span>}
      </label>
      {field.options ? (
        <select value={val} onChange={(e) => setForm({ ...form, [field.key]: e.target.value })} required={field.required} style={formSelectStyle}>
          <option value="">-- Select {field.label.replace(' *', '')} --</option>
          {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : GEO_AUTO_FIELDS.has(field.key) ? (
        <Autocomplete
          value={val}
          onChange={(v) => handleChange(v)}
          onSelect={(place) => applyPlace(field.key, place, form, setForm)}
          placeholder={field.placeholder || (field.key === 'pincode' ? 'Search pincode…' : `Type to search ${field.label.toLowerCase()}…`)}
          filterType={(r) => field.key === 'pincode' ? !!r.pincode : true}
        />
      ) : isTextarea ? (
        <textarea value={val} onChange={(e) => handleChange(e.target.value)} placeholder={field.placeholder || `Enter ${field.label.toLowerCase().replace(' *', '')}`}
          rows={3} style={{ ...formFieldStyle, resize: 'vertical', minHeight: '60px', fontFamily: 'inherit' }} />
      ) : (
        <div style={{ position: 'relative' }}>
          {isTel && <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '12px', pointerEvents: 'none' }}>+91</span>}
          <input
            type={isTime ? 'time' : isTel ? 'tel' : isNum ? 'number' : field.type || 'text'}
            value={val}
            onChange={(e) => handleChange(e.target.value)}
            required={field.required}
            placeholder={
              field.placeholder ||
              (isTel ? '9876543210' : field.key === 'pincode' ? '6-digit pincode' : field.key === 'email' ? 'name@example.com' : field.key === 'panNumber' ? 'ABCDE1234F' : field.key === 'ifscCode' ? 'HDFC0001234' : field.key === 'bankAccountNumber' ? 'Account number' : field.key === 'managerId' ? 'Manager UUID' : `Enter ${field.label.toLowerCase().replace(' *', '')}`)
            }
            inputMode={isNum || field.key === 'pincode' || isTel ? 'numeric' : field.key === 'email' ? 'email' : 'text'}
            maxLength={field.key === 'pincode' ? 6 : field.key === 'panNumber' ? 10 : field.key === 'ifscCode' ? 11 : undefined}
            min={isNum ? 0 : undefined}
            step={isNum ? '1' : undefined}
            autoComplete="off"
            style={{
              ...formFieldStyle,
              fontFamily: isMono ? 'monospace' : 'inherit',
              textTransform: (field.key === 'panNumber' || field.key === 'ifscCode') ? 'uppercase' : 'none',
              letterSpacing: isMono ? '0.5px' : 'normal',
              ...(isTel ? { paddingLeft: '42px' } : {}),
            }} />
        </div>
      )}
    </div>
  );
};

export const CreateAssayerModal: React.FC<{ onClose: () => void; onCreated: () => void; existingAssayersCount?: number }> = ({ onClose, onCreated, existingAssayersCount = 10 }) => {
  const { toast } = useToast();
  const [mode, setMode] = useState<'express' | 'advanced'>('express');
  const [form, setForm] = useState<Record<string, string>>(() => {
    const autoCode = `AS-${String(existingAssayersCount + 1).padStart(2, '0')}`;
    return {
      assayerCode: autoCode,
      employmentType: 'FULL_TIME',
      department: 'Gold Testing',
      experienceYears: '5',
      state: 'Delhi',
      district: 'Central Delhi',
      city: 'New Delhi',
      joiningDate: todayDateKey(),
    };
  });
  const [activeTab, setActiveTab] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const [addrError, setAddrError] = useState<string | null>(null);

  const checkAddressConsistency = async (pincode: string, state: string, district: string) => {
    setAddrError(null);
    if (!/^\d{6}$/.test(pincode || '')) return;
    try {
      const res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`);
      const data = await res.json();
      const ok = data?.[0];
      if (ok && ok.Status === 'Success' && ok.PostOffice?.[0]) {
        const po = ok.PostOffice[0];
        if (state && po.State && state.trim().toLowerCase() !== po.State.trim().toLowerCase()) {
          setAddrError(`Pincode ${pincode} is in ${po.State}, but you selected state "${state}". State, district, city, address and pincode must match.`);
          return;
        }
        if (district && po.District && district.trim().toLowerCase() !== po.District.trim().toLowerCase()) {
          setAddrError(`Pincode ${pincode} is in ${po.District} district (${po.State}), but you entered district "${district}".`);
        }
      }
    } catch { /* can't verify client-side; backend enforces */ }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await checkAddressConsistency(form.pincode || '', form.state || '', form.district || '');
      if (addrError) {
        setSubmitting(false);
        toast({ type: 'error', title: 'Address looks inconsistent', message: addrError });
        return;
      }
      const firstName = form.firstName?.trim() || '';
      const lastName = form.lastName?.trim() || '';
      const autoCode = form.assayerCode?.trim() || `AS-${String(Math.floor(10 + Math.random() * 89))}`;

      const rawPhone = form.phone?.replace(/\D/g, '') || '';
      const formattedPhone = rawPhone ? (rawPhone.startsWith('91') ? `+${rawPhone}` : `+91${rawPhone}`) : '';

      const body: any = {
        assayerCode: autoCode,
        firstName: firstName,
        lastName: lastName,
        phone: formattedPhone,
        email: form.email?.trim() || (firstName && lastName ? `${firstName.toLowerCase()}.${lastName.toLowerCase()}@fapoms.com` : null),
        address: form.address?.trim() || '',
        city: form.city?.trim() || '',
        district: form.district?.trim() || form.city?.trim() || '',
        state: form.state?.trim() || '',
        pincode: form.pincode?.trim() || null,
        employmentType: form.employmentType || 'FULL_TIME',
        department: form.department || 'Operations',
        experienceYears: form.experienceYears ? Number(form.experienceYears) : 0,
        joiningDate: form.joiningDate ? new Date(form.joiningDate).toISOString() : new Date().toISOString(),
        alternatePhone: form.alternatePhone?.trim() || null,
        region: form.region?.trim() || null,
        employeeId: form.employeeId?.trim() || null,
        employeeCode: form.employeeCode?.trim() || null,
        panNumber: form.panNumber?.trim() || null,
        bankAccountNumber: form.bankAccountNumber?.trim() || null,
        ifscCode: form.ifscCode?.trim() || null,
        notes: form.notes?.trim() || null,
      };

      const created = await api.request<any>('/assayers', { method: 'POST', body: JSON.stringify(body) });
      const createdId = created?.id ?? (created?.data as any)?.id;
      const baseFee = Number(form.baseFee) || 0;
      const hourlyRate = Number(form.hourlyRate) || 0;
      const dailyRate = Number(form.dailyRate) || 0;
      if (createdId && (baseFee > 0 || hourlyRate > 0 || dailyRate > 0)) {
        await api.request(`/assayers/${createdId}/commercial`, {
          method: 'POST',
          body: JSON.stringify({
            baseFee, hourlyRate, dailyRate,
            travelReimbursement: Number(form.travelReimbursement) || 0,
            accommodationAllowance: Number(form.accommodationAllowance) || 0,
            mealAllowance: Number(form.mealAllowance) || 0,
            currency: 'INR',
            effectiveStartDate: new Date().toISOString(),
          }),
        });
      }
      onCreated();
    } catch (err) {
      toast({ type: 'error', title: 'Could not create assayer', message: userMessage(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const fieldsMap = new Map(CREATE_FIELDS.map(f => [f.key, f]));
  const currentGroup = CREATE_FIELD_GROUPS[activeTab];

  return (
    <Modal
      open
      onClose={onClose}
      width="720px"
      height="min(680px, 85vh)"
      closeIcon={<X size={18} />}
      asForm
      onSubmit={handleSubmit}
      title={<><User size={18} style={{ color: 'var(--accent-primary)' }} /> Enroll New Assayer</>}
      footer={
        mode === 'express' ? (
          <>
            <button type="button" onClick={onClose} className="btn btn-secondary" style={{ padding: '9px 18px', fontSize: '13px' }}>Cancel</button>
            <button type="submit" disabled={submitting} className="btn btn-primary" style={{ padding: '9px 22px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--gradient-neon)', color: 'var(--on-gradient)' }}>
              {submitting ? 'Enrolling...' : <><CheckCircle size={16} /> Enroll Assayer Instantly ⚡</>}
            </button>
          </>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              {activeTab > 0 && (
                <button type="button" onClick={() => setActiveTab(activeTab - 1)} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  ← Previous
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" onClick={onClose} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px' }}>Cancel</button>
              {activeTab < CREATE_FIELD_GROUPS.length - 1 ? (
                <button type="button" onClick={() => setActiveTab(activeTab + 1)} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  Next →
                </button>
              ) : (
                <button type="submit" disabled={submitting} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {submitting ? 'Saving...' : <><CheckCircle size={14} /> Create Assayer</>}
                </button>
              )}
            </div>
          </div>
        )
      }
    >
      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
        Fast 1-click onboarding with auto-generated code and pincode geocoding.
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <div style={{ background: 'rgba(255,255,255,0.06)', padding: '3px', borderRadius: '8px', display: 'flex', gap: '2px', border: '1px solid var(--border-color)' }}>
          <button
            type="button"
            onClick={() => setMode('express')}
            style={{
              padding: '5px 12px',
              fontSize: '11px',
              fontWeight: 700,
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              background: mode === 'express' ? 'var(--accent-primary)' : 'transparent',
              color: mode === 'express' ? 'var(--on-accent)' : 'var(--text-muted)',
            }}
          >
            ⚡ Express Mode
          </button>
          <button
            type="button"
            onClick={() => setMode('advanced')}
            style={{
              padding: '5px 12px',
              fontSize: '11px',
              fontWeight: 700,
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              background: mode === 'advanced' ? 'var(--accent-primary)' : 'transparent',
              color: mode === 'advanced' ? 'var(--on-accent)' : 'var(--text-muted)',
            }}
          >
            📋 Advanced (6 Tabs)
          </button>
        </div>
      </div>

      {mode === 'express' ? (
        <>
          <div style={{ background: 'var(--status-pending-bg)', border: '1px solid rgba(216,174,71,0.25)', padding: '12px 16px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>Auto-Generated Assayer Code</span>
              <span style={{ fontSize: '15px', fontWeight: 800, fontFamily: 'monospace', color: 'var(--accent-primary)' }}>{form.assayerCode}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>Default Department</span>
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--success)' }}>Gold Testing & Assay</span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '14px' }}>
            <div>
              <label style={labelStyle}>First Name <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input
                type="text"
                required
                placeholder="e.g. Deepak"
                className="form-input"
                style={formFieldStyle}
                value={form.firstName || ''}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              />
            </div>

            <div>
              <label style={labelStyle}>Last Name <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input
                type="text"
                required
                placeholder="e.g. Verma"
                className="form-input"
                style={formFieldStyle}
                value={form.lastName || ''}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              />
            </div>

            <div>
              <label style={labelStyle}>Mobile Phone Number <span style={{ color: 'var(--danger)' }}>*</span></label>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '12px', pointerEvents: 'none' }}>+91</span>
                <input
                  type="tel"
                  required
                  placeholder="9876543217"
                  maxLength={10}
                  style={{ ...formFieldStyle, paddingLeft: '42px' }}
                  value={form.phone || ''}
                  onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '') })}
                />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Email Address (Optional)</label>
              <input
                type="email"
                placeholder="deepak.verma@fapoms.com"
                className="form-input"
                style={formFieldStyle}
                value={form.email || ''}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Base Street Address <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input
                type="text"
                required
                placeholder="e.g. Connaught Place, Radial Road 1, Central Delhi"
                className="form-input"
                style={formFieldStyle}
                value={form.address || ''}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </div>

            <div>
              <label style={labelStyle}>Pincode (Auto-Fills City & State) <span style={{ color: 'var(--danger)' }}>*</span></label>
              <Autocomplete
                value={form.pincode || ''}
                onChange={(v) => setForm({ ...form, pincode: v })}
                onSelect={(place) => {
                  const next: Record<string, string> = { ...form, pincode: place.pincode || form.pincode || '' };
                  if (place.district) { next.district = place.district; }
                  if (place.state) { next.state = place.state; }
                  if (!next.city) next.city = (place.label || '').split(',')[0].trim();
                  setForm(next);
                }}
                placeholder="Search pincode, e.g. 110001"
                filterType={(r) => !!r.pincode}
              />
            </div>

            <div>
              <label style={labelStyle}>City / Base District <span style={{ color: 'var(--danger)' }}>*</span></label>
              <Autocomplete
                value={form.city || ''}
                onChange={(v) => setForm({ ...form, city: v, district: v })}
                onSelect={(place) => {
                  const next: Record<string, string> = { ...form, city: (place.label || '').split(',')[0].trim() };
                  if (place.district) next.district = place.district;
                  if (place.state) next.state = place.state;
                  setForm(next);
                }}
                placeholder="Type to search city / district…"
              />
            </div>

            <div>
              <label style={labelStyle}>State <span style={{ color: 'var(--danger)' }}>*</span></label>
              <select
                value={form.state || 'Delhi'}
                onChange={(e) => { setForm({ ...form, state: e.target.value }); checkAddressConsistency(form.pincode || '', e.target.value, form.district); }}
                style={formSelectStyle}
              >
                {INDIAN_STATES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>

            {addrError && (
              <div style={{ gridColumn: '1 / -1', padding: '9px 12px', borderRadius: '8px', fontSize: '12.5px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)', display: 'flex', gap: '7px', alignItems: 'center' }}>
                <AlertTriangle size={14} /> {addrError}
              </div>
            )}

            <div>
              <label style={labelStyle}>Employment Type</label>
              <select
                value={form.employmentType || 'FULL_TIME'}
                onChange={(e) => setForm({ ...form, employmentType: e.target.value })}
                style={formSelectStyle}
              >
                {EMPLOYMENT_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid var(--border-color)', overflowX: 'auto' }}>
            {CREATE_FIELD_GROUPS.map((group, i) => (
              <button key={group.title} type="button" onClick={() => setActiveTab(i)}
                style={{
                  padding: '8px 14px', background: 'transparent', border: 'none',
                  borderBottom: activeTab === i ? '2px solid var(--accent-primary)' : '2px solid transparent',
                  color: activeTab === i ? 'var(--accent-primary)' : 'var(--text-muted)',
                  fontWeight: activeTab === i ? 700 : 500, fontSize: '12px', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap',
                  transition: 'all 0.15s', opacity: activeTab === i ? 1 : 0.6,
                }}>
                {group.icon} {group.title}
              </button>
            ))}
          </div>
          <div key={activeTab} className="tab-pane" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>{currentGroup.title}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
              {currentGroup.fields.map(key => {
                const field = fieldsMap.get(key);
                return field ? renderFormField(field, form, setForm) : null;
              })}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
};

interface FieldGroup {
  title: string;
  icon: React.ReactNode;
  fields: string[];
}

const EDIT_FIELD_GROUPS: FieldGroup[] = [
  { title: 'Personal', icon: <User size={13} />, fields: ['firstName', 'lastName', 'email', 'phone', 'alternatePhone'] },
  { title: 'Address', icon: <MapPin size={13} />, fields: ['address', 'city', 'district', 'state', 'pincode', 'region'] },
  { title: 'Employment', icon: <Briefcase size={13} />, fields: ['employeeId', 'employeeCode', 'employmentType', 'department', 'joiningDate', 'exitDate', 'terminationDate', 'managerId'] },
  { title: 'Financial', icon: <CreditCard size={13} />, fields: ['panNumber', 'bankAccountNumber', 'ifscCode'] },
  { title: 'Skills', icon: <Award size={13} />, fields: ['experienceYears', 'performanceRating', 'maxDailyWorkload', 'maxWeeklyWorkload'] },
  { title: 'Emergency', icon: <Phone size={13} />, fields: ['emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation'] },
  { title: 'Other', icon: <Clock size={13} />, fields: ['workingHoursStart', 'workingHoursEnd', 'notes'] },
];

export const EditAssayerModal: React.FC<{ assayer: Assayer; onClose: () => void; onUpdated: () => void }> = ({ assayer, onClose, onUpdated }) => {
  const { toast } = useToast();
  const [form, setForm] = useState<Record<string, string>>(() => {
    const f: Record<string, string> = {};
    EDIT_FIELDS.forEach(field => {
      let val = (assayer as any)[field.key];
      if (field.key === 'workingHoursStart') val = assayer.workingHours?.start || '';
      else if (field.key === 'workingHoursEnd') val = assayer.workingHours?.end || '';
      else if (field.key === 'latitude' || field.key === 'longitude') val = val !== null && val !== undefined ? String(val) : '';
      else if (field.key === 'joiningDate' || field.key === 'exitDate' || field.key === 'terminationDate') val = val ? new Date(val).toISOString().split('T')[0] : '';
      else val = val !== null && val !== undefined ? String(val) : '';
      f[field.key] = val;
    });
    return f;
  });
  const [activeEditTab, setActiveEditTab] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    try {
      const body: any = {};
      EDIT_FIELDS.forEach(field => {
        const val = form[field.key];
        if (val !== undefined && val !== '') {
          if (field.key === 'workingHoursStart' || field.key === 'workingHoursEnd') {
            body.workingHours = { ...(assayer.workingHours || {}), [field.key === 'workingHoursStart' ? 'start' : 'end']: val };
          } else if (field.type === 'number') body[field.key] = Number(val);
          else if (field.type === 'date') body[field.key] = new Date(val).toISOString();
          else body[field.key] = val;
        }
      });
      await api.request(`/assayers/${assayer.id}`, { method: 'PUT', body: JSON.stringify(body) });
      onUpdated();
    } catch (err) { toast({ type: 'error', title: 'Could not save changes', message: userMessage(err) }); }
    finally { setSubmitting(false); }
  };

  const statusColor = STATUS_COLORS[assayer.lifecycleStatus || assayer.status] || 'var(--text-muted)';

  const fieldsMap = new Map(EDIT_FIELDS.map(f => [f.key, f]));
  const currentGroup = EDIT_FIELD_GROUPS[activeEditTab];

  return (
    <Modal
      open
      onClose={onClose}
      width="720px"
      height="min(680px, 85vh)"
      closeIcon={<X size={18} />}
      asForm
      onSubmit={handleSubmit}
      title={<><Edit2 size={18} style={{ color: 'var(--accent-primary)' }} /> Edit Assayer</>}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            {activeEditTab > 0 && (
              <button type="button" onClick={() => setActiveEditTab(activeEditTab - 1)} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                ← Previous
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" onClick={onClose} className="btn btn-secondary" style={{ padding: '8px 16px', fontSize: '12px' }}>Cancel</button>
            {activeEditTab < EDIT_FIELD_GROUPS.length - 1 ? (
              <button type="button" onClick={() => setActiveEditTab(activeEditTab + 1)} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                Next →
              </button>
            ) : (
              <button type="submit" disabled={submitting} className="btn btn-primary" style={{ padding: '8px 16px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                {submitting ? 'Saving...' : <><CheckCircle size={14} /> Save Changes</>}
              </button>
            )}
          </div>
        </div>
      }
    >
      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontFamily: 'monospace' }}>{assayer.assayerCode}</span>
        <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: statusColor }} />
          {assayer.lifecycleStatus || assayer.status}
        </span>
        <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
        <span>{assayer.displayName}</span>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '0', borderBottom: '1px solid var(--border-color)', overflowX: 'auto' }}>
        {EDIT_FIELD_GROUPS.map((group, i) => (
          <button key={group.title} type="button" onClick={() => setActiveEditTab(i)}
            style={{
              padding: '8px 14px', background: 'transparent', border: 'none',
              borderBottom: activeEditTab === i ? '2px solid var(--accent-primary)' : '2px solid transparent',
              color: activeEditTab === i ? 'var(--accent-primary)' : 'var(--text-muted)',
              fontWeight: activeEditTab === i ? 700 : 500, fontSize: '12px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap',
              transition: 'all 0.15s', opacity: activeEditTab === i ? 1 : 0.6,
            }}>
            {group.icon} {group.title}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div key={activeEditTab} className="tab-pane" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>{currentGroup.title}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
          {currentGroup.fields.map(key => {
            const field = fieldsMap.get(key);
            return field ? renderFormField(field, form, setForm) : null;
          })}
        </div>
      </div>
    </Modal>
  );
};
