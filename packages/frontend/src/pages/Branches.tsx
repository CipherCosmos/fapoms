import React, { useState, useEffect } from 'react';
import { Search, Filter, Upload, AlertCircle, CheckCircle, MapPin } from 'lucide-react';
import { api } from '../services/api';

interface ClientOption {
  id: string;
  clientCode: string;
  name: string;
}

interface Branch {
  id: string;
  branchCode: string;
  solId: string | null;
  name: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
}

export const Branches: React.FC = () => {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Load clients and initial branches
  useEffect(() => {
    loadClients();
    loadBranches();
  }, []);

  // Reload branches when selected client changes
  useEffect(() => {
    loadBranches(selectedClientId);
  }, [selectedClientId]);

  const loadClients = async () => {
    try {
      const response = await api.request<ClientOption[]>('/clients', { method: 'GET' }, [
        { id: '1', clientCode: 'SBI', name: 'State Bank of India' },
        { id: '2', clientCode: 'HDFC', name: 'HDFC Bank Limited' }
      ]);
      setClients(response);
      if (response.length > 0) {
        setSelectedClientId(response[0].id);
      }
    } catch (err) {
      console.error('Failed to load clients list');
    }
  };

  const loadBranches = async (clientId?: string) => {
    setIsLoading(true);
    try {
      const url = clientId ? `/branches?clientId=${clientId}&limit=100` : '/branches?limit=100';
      const fallbackData = [
        { id: '1', branchCode: 'BR-0010', solId: '1029', name: 'Pune Main Branch', address: '123 Pune Road', city: 'Pune City', state: 'Maharashtra', district: 'Pune', pincode: '411001', latitude: 18.5204, longitude: 73.8567 },
        { id: '2', branchCode: 'BR-0011', solId: '1043', name: 'Pimpri Branch', address: '456 Pimpri Road', city: 'Pimpri-Chinchwad', state: 'Maharashtra', district: 'Pune', pincode: '411018', latitude: 18.6298, longitude: 73.7997 },
        { id: '3', branchCode: 'BR-0012', solId: '1105', name: 'Mumbai Fort Branch', address: '789 Fort Street', city: 'Mumbai City', state: 'Maharashtra', district: 'Mumbai', pincode: '400001', latitude: 18.9696, longitude: 72.8240 },
        { id: '4', branchCode: 'BR-0020', solId: '2055', name: 'Ahmedabad Navrangpura', address: '101 Navrang Road', city: 'Ahmedabad City', state: 'Gujarat', district: 'Ahmedabad', pincode: '380001', latitude: 23.0225, longitude: 72.5714 },
        { id: '5', branchCode: 'BR-0030', solId: '3049', name: 'Bangalore MG Road', address: '202 MG Road', city: 'Bangalore', state: 'Karnataka', district: 'Bangalore Urban', pincode: '560001', latitude: 12.9716, longitude: 77.5946 },
      ];
      const response = await api.request<Branch[]>(url, { method: 'GET' }, fallbackData);
      setBranches(response);
    } catch (err) {
      console.error('Failed to load branches');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedClientId) return;

    setIsUploading(true);
    setMessage(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`/api/v1/branches/import/${selectedClientId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}`
        },
        body: formData
      });

      const resData = await response.json();

      if (response.ok && resData.success) {
        const { importedCount, errors } = resData.data;
        let msg = `Successfully imported ${importedCount} branches.`;
        if (errors && errors.length > 0) {
          msg += ` Excluded ${errors.length} rows due to validation errors. Check console for details.`;
          console.warn('Import warnings:', errors);
        }
        setMessage({ type: 'success', text: msg });
        loadBranches(selectedClientId);
      } else {
        setMessage({ type: 'error', text: resData.message || 'Import failed.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Network connection error during file upload.' });
    } finally {
      setIsUploading(false);
      e.target.value = ''; // clear input
    }
  };

  const filteredBranches = branches.filter(b => {
    const matchesSearch = b.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          b.branchCode.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          (b.solId && b.solId.includes(searchTerm));
    const matchesState = stateFilter === 'ALL' || b.state === stateFilter;
    return matchesSearch && matchesState;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h3 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>Branch Directory</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
            View and manage corporate branches. Geocoding coordinates are resolved via PostGIS referencing.
          </p>
        </div>

        {/* Dynamic Excel Importer */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>SELECT INSTITUTION</label>
            <select
              value={selectedClientId}
              onChange={(e) => setSelectedClientId(e.target.value)}
              style={{
                padding: '8px 12px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text-primary)',
                fontSize: '13px',
                outline: 'none',
                minWidth: '180px'
              }}
            >
              {clients.map(c => (
                <option key={c.id} value={c.id}>{c.name} ({c.clientCode})</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>EXCEL BRANCH LIST</span>
            <label className="btn btn-primary" style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 16px',
              cursor: isUploading ? 'not-allowed' : 'pointer',
              fontSize: '13px',
              opacity: isUploading ? 0.7 : 1
            }}>
              <Upload size={14} />
              {isUploading ? 'Uploading...' : 'Import Excel'}
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileUpload}
                disabled={isUploading}
                style={{ display: 'none' }}
              />
            </label>
          </div>
        </div>
      </div>

      {/* Notifications Alert */}
      {message && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '12px 16px',
          borderRadius: 'var(--radius-md)',
          fontSize: '13px',
          border: '1px solid',
          background: message.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          borderColor: message.type === 'success' ? 'var(--accent-secondary)' : 'rgba(239,68,68,0.4)',
          color: message.type === 'success' ? 'var(--accent-secondary)' : '#f87171'
        }}>
          {message.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
          <span>{message.text}</span>
        </div>
      )}

      {/* Filter Header */}
      <div className="glass-card" style={{ padding: '16px', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        
        {/* Search */}
        <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input 
            type="text"
            placeholder="Search by name, code or SOL ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px 10px 36px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-primary)',
              outline: 'none',
              fontSize: '14px'
            }}
          />
        </div>

        {/* State Filter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Filter size={16} style={{ color: 'var(--text-muted)' }} />
          <select 
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            style={{
              padding: '10px 16px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-primary)',
              outline: 'none',
              fontSize: '14px'
            }}
          >
            <option value="ALL">All States</option>
            <option value="Maharashtra">Maharashtra</option>
            <option value="Gujarat">Gujarat</option>
            <option value="Karnataka">Karnataka</option>
          </select>
        </div>

      </div>

      {/* Branches Table */}
      <div className="table-container">
        {isLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
            Loading branch master repository...
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Branch Code</th>
                <th>SOL ID</th>
                <th>Branch Name</th>
                <th>District</th>
                <th>City</th>
                <th>State</th>
                <th>Pincode</th>
                <th>Coordinates</th>
              </tr>
            </thead>
            <tbody>
              {filteredBranches.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}>
                    No branches found. Import an Excel list to get started.
                  </td>
                </tr>
              ) : (
                filteredBranches.map((b) => (
                  <tr key={b.id || b.branchCode}>
                    <td style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{b.branchCode}</td>
                    <td style={{ fontSize: '13px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{b.solId || '-'}</td>
                    <td style={{ fontWeight: 600 }}>{b.name}</td>
                    <td>{b.district}</td>
                    <td>{b.city}</td>
                    <td>{b.state}</td>
                    <td>{b.pincode || '-'}</td>
                    <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {b.latitude && b.longitude ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <MapPin size={12} style={{ color: 'var(--accent-secondary)' }} />
                          {b.latitude.toFixed(4)}, {b.longitude.toFixed(4)}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>Not geocoded</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
};
