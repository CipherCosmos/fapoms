import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Search, ArrowRight, Command } from 'lucide-react';
import { useGlobalSearch } from '../hooks/useGlobalSearch';

export const SearchOverlay: React.FC = () => {
  const { query, setQuery, results, loading, navigateTo, totalCount } = useGlobalSearch();
  const [open, setOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const flatItems = useCallback(() => {
    if (!results) return [];
    const items: { type: string; id: string; label: string; sub: string }[] = [];
    results.branches.forEach(i => items.push({ type: 'branches', id: i.id, label: i.name, sub: `${i.city}, ${i.state}` }));
    results.assayers.forEach(i => items.push({ type: 'assayers', id: i.id, label: i.name, sub: i.code }));
    results.projects.forEach(i => items.push({ type: 'projects', id: i.id, label: i.name, sub: i.projectNumber }));
    results.clients.forEach(i => items.push({ type: 'clients', id: i.id, label: i.name, sub: i.code }));
    results.assignments.forEach(i => items.push({ type: 'assignments', id: i.id, label: i.assignmentNumber, sub: `${i.branchName} → ${i.assayerName}` }));
    return items;
  }, [results]);

  const openSearch = useCallback(() => {
    setOpen(true);
    setQuery('');
    setSelectedIdx(-1);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [setQuery]);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSelectedIdx(-1);
  }, [setQuery]);

  const handleSelect = useCallback((type: string, id: string) => {
    closeSearch();
    navigateTo(type, id);
  }, [closeSearch, navigateTo]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (open) closeSearch();
        else openSearch();
      }
      if (e.key === 'Escape' && open) closeSearch();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, openSearch, closeSearch]);

  useEffect(() => {
    if (query) setSelectedIdx(-1);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, flatItems().length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
      if (e.key === 'Enter' && selectedIdx >= 0) {
        const items = flatItems();
        if (items[selectedIdx]) handleSelect(items[selectedIdx].type, items[selectedIdx].id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, selectedIdx, flatItems, handleSelect]);

  useEffect(() => {
    if (selectedIdx >= 0 && listRef.current) {
      const el = listRef.current.children[selectedIdx] as HTMLElement;
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx]);

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Search" style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      paddingTop: '12vh',
    }}>
      <div onClick={closeSearch} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }} />

      <div style={{
        position: 'relative', width: '100%', maxWidth: '620px',
        background: 'var(--bg-surface)', backdropFilter: 'blur(20px)',
        border: '1px solid var(--border-hair)',
        borderRadius: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px var(--border-hair)',
        overflow: 'hidden',
        animation: 'none',
      }}>
        {/* Search Input */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border-hair)' }}>
          <Search size={18} style={{ color: 'var(--text-muted)', flexShrink: 0, marginRight: '12px' }} />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={!!query}
            aria-controls="global-search-listbox"
            aria-autocomplete="list"
            aria-activedescendant={selectedIdx >= 0 ? `global-search-option-${selectedIdx}` : undefined}
            placeholder="Search branches, assayers, projects, clients, assignments..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              flex: 1, background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: '16px',
              outline: 'none', fontWeight: 400,
            }}
          />
          {loading && <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginRight: '8px' }}>searching...</span>}
          <kbd style={{
            padding: '2px 8px', background: 'var(--bg-surface-2)', borderRadius: '6px',
            color: 'var(--text-muted)', fontSize: '11px', fontWeight: 600, fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: '4px', border: '1px solid var(--border-hair)',
          }}>
            <Command size={12} />K
          </kbd>
        </div>

        {/* Results */}
        {query && (
          <div ref={listRef} id="global-search-listbox" role="listbox" aria-label="Search results" style={{ maxHeight: '420px', overflowY: 'auto', padding: '4px 0' }}>
            {!results ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                <div style={{ fontSize: '28px', marginBottom: '8px', opacity: 0.3 }}>🔍</div>
                Searching...
              </div>
            ) : totalCount === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                <div style={{ fontSize: '28px', marginBottom: '8px', opacity: 0.3 }}>📭</div>
                No results for "<b style={{ color: 'var(--text-primary)' }}>{query}</b>"
              </div>
            ) : (
              <>
                <div style={{ padding: '8px 20px 4px', fontSize: '11px', color: 'var(--text-muted)' }}>
                  {totalCount} result{totalCount !== 1 ? 's' : ''}
                </div>
                {renderGroup('Branches', 'branches', results.branches, (i) => i.name, (i) => `${i.city}, ${i.state}`, selectedIdx, flatItems, handleSelect)}
                {renderGroup('Assayers', 'assayers', results.assayers, (i) => i.name, (i) => i.code, selectedIdx, flatItems, handleSelect)}
                {renderGroup('Projects', 'projects', results.projects, (i) => i.name, (i) => i.projectNumber, selectedIdx, flatItems, handleSelect)}
                {renderGroup('Clients', 'clients', results.clients, (i) => i.name, (i) => i.code, selectedIdx, flatItems, handleSelect)}
                {renderAssignments(results.assignments, selectedIdx, flatItems, handleSelect)}

                <div style={{ padding: '8px 20px', borderTop: '1px solid var(--border-hair)', display: 'flex', gap: '16px', fontSize: '11px', color: 'var(--text-muted)' }}>
                  <span><kbd style={kbdStyle}>↑↓</kbd> navigate</span>
                  <span><kbd style={kbdStyle}>↵</kbd> open</span>
                  <span><kbd style={kbdStyle}>esc</kbd> close</span>
                </div>
              </>
            )}
          </div>
        )}

        {!query && (
          <div style={{ padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center' }}>
              Type to search across all entities
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {['Branches', 'Assayers', 'Projects', 'Clients', 'Assignments'].map(s => (
                <span key={s} style={{ fontSize: '11px', padding: '3px 10px', background: 'var(--bg-surface-2)', borderRadius: '6px', color: 'var(--text-muted)' }}>{s}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const kbdStyle: React.CSSProperties = {
  padding: '1px 5px', background: 'var(--bg-surface-2)', borderRadius: '4px',
  fontSize: '10px', fontWeight: 600, fontFamily: 'inherit', color: 'var(--text-muted)',
  border: '1px solid var(--border-hair)',
};

function renderGroup(
  title: string, type: string, items: any[],
  primary: (i: any) => string, secondary: (i: any) => string,
  selectedIdx: number, flatItems: () => { type: string; id: string }[],
  onSelect: (type: string, id: string) => void,
) {
  if (!items.length) return null;
  const startIdx = flatItems().findIndex(i => i.type === type && i.id === items[0]?.id);
  return (
    <div key={type}>
      <div style={{ padding: '6px 20px', fontSize: '10px', fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
        {title} <span style={{ color: 'rgba(216,174,71,0.5)', fontWeight: 400 }}>({items.length})</span>
      </div>
      {items.map((item: any, i: number) => {
        const idx = startIdx + i;
        const isSelected = idx === selectedIdx;
        return (
          <div key={item.id} id={`global-search-option-${idx}`} role="option" aria-selected={isSelected}
            onClick={() => onSelect(type, item.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 20px', cursor: 'pointer',
              background: isSelected ? 'var(--status-pending-bg)' : 'transparent',
              borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
              transition: 'all 0.1s',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>{primary(item)}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{secondary(item)}</div>
            </div>
            <ArrowRight size={14} style={{ color: isSelected ? 'var(--accent)' : 'transparent', flexShrink: 0 }} />
          </div>
        );
      })}
    </div>
  );
}

function renderAssignments(
  items: any[], selectedIdx: number,
  flatItems: () => { type: string; id: string }[],
  onSelect: (type: string, id: string) => void,
) {
  if (!items.length) return null;
  const startIdx = flatItems().findIndex(i => i.type === 'assignments' && i.id === items[0]?.id);
  return (
    <div key="assignments">
      <div style={{ padding: '6px 20px', fontSize: '10px', fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
        Assignments <span style={{ color: 'rgba(216,174,71,0.5)', fontWeight: 400 }}>({items.length})</span>
      </div>
      {items.map((item: any, i: number) => {
        const idx = startIdx + i;
        const isSelected = idx === selectedIdx;
        return (
          <div key={item.id} id={`global-search-option-${idx}`} role="option" aria-selected={isSelected}
            onClick={() => onSelect('assignments', item.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 20px', cursor: 'pointer',
              background: isSelected ? 'var(--status-pending-bg)' : 'transparent',
              borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
              transition: 'all 0.1s',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>{item.assignmentNumber}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{item.branchName} → {item.assayerName}</div>
            </div>
            <ArrowRight size={14} style={{ color: isSelected ? 'var(--accent)' : 'transparent', flexShrink: 0 }} />
          </div>
        );
      })}
    </div>
  );
}
