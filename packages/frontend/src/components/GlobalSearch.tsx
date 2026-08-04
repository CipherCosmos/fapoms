import React, { useState, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';
import { useGlobalSearch } from '../hooks/useGlobalSearch';

export const GlobalSearch: React.FC = () => {
  const { query, setQuery, results, loading, navigateTo, totalCount } = useGlobalSearch();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  const handleSelect = (type: string, id: string) => {
    setOpen(false);
    navigateTo(type, id);
  };

  const section = (title: string, type: string, items: any[], render: (item: any) => string) => {
    if (!items.length) return null;
    return (
      <div key={type}>
        <div style={{ padding: '6px 12px', fontSize: '10px', fontWeight: 700, color: 'var(--accent-primary)', textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid var(--border-hair)' }}>
          {title} ({items.length})
        </div>
        {items.map((item: any) => (
          <button type="button" key={item.id} onClick={() => handleSelect(type, item.id)}
            aria-label={`${title}: ${render(item)}`}
            style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', padding: '8px 12px', cursor: 'pointer', fontSize: '12px', borderBottom: '1px solid var(--border-hair)', display: 'flex', alignItems: 'center', gap: '8px', color: 'inherit' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--status-pending-bg)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ color: 'var(--text-primary)', fontWeight: 500, flex: 1 }}>{render(item)}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{item.code || ''}</span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <div style={{ position: 'relative' }}>
        <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input
          type="text"
          placeholder="Search... (⌘K)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { if (results) setOpen(true); }}
          style={{
            width: '100%', padding: '8px 12px 8px 32px', fontSize: '12px',
            background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', outline: 'none',
          }}
        />
        {loading && <span style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '10px', color: 'var(--text-muted)' }}>...</span>}
      </div>

      {open && query && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, marginTop: '4px', zIndex: 9999,
          background: 'var(--bg-surface-2)', backdropFilter: 'blur(12px)',
          border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)', maxHeight: '440px', overflowY: 'auto',
        }}>
          {!results ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>Type to search...</div>
          ) : totalCount === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>No results found for "{query}"</div>
          ) : (
            <>
              <div style={{ padding: '6px 12px', fontSize: '10px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-hair)' }}>
                {totalCount} result{totalCount !== 1 ? 's' : ''} for "{query}"
              </div>
              {section('Branches', 'branches', results.branches, (i) => `${i.name} (${i.city}, ${i.state})`)}
              {section('Assayers', 'assayers', results.assayers, (i) => i.name)}
              {section('Projects', 'projects', results.projects, (i) => `${i.name} (${i.projectNumber})`)}
              {section('Clients', 'clients', results.clients, (i) => i.name)}
              {section('Assignments', 'assignments', results.assignments, (i) => `${i.assignmentNumber} — ${i.branchName} → ${i.assayerName}`)}
            </>
          )}
        </div>
      )}
    </div>
  );
};
