import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';

export interface SearchResult {
  branches: { id: string; name: string; code: string; city: string; state: string }[];
  assayers: { id: string; name: string; code: string; phone: string }[];
  projects: { id: string; name: string; projectNumber: string }[];
  clients: { id: string; name: string; code: string }[];
  assignments: { id: string; assignmentNumber: string; branchName: string; assayerName: string }[];
}

export const SEARCH_NAV_PATHS: Record<string, string> = {
  branches: '/branches?id=',
  assayers: '/assayers/',
  projects: '/projects?id=',
  clients: '/clients?id=',
  assignments: '/assignments?id=',
};

/**
 * Shared debounced global search logic. Previously both the sidebar dropdown
 * (GlobalSearch) and the ⌘K modal (SearchOverlay) each inlined an identical
 * debounce + `/search` fetch + navigate implementation; this is the single
 * source of truth for that behaviour so the two never drift apart.
 */
export function useGlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const doSearch = useCallback(async (q: string) => {
    if (!q || q.length < 1) { setResults(null); return; }
    setLoading(true);
    try {
      const data = await api.request<SearchResult>(`/search?q=${encodeURIComponent(q)}`);
      setResults(data);
    } catch { /* keep previous results on failure */ }
    setLoading(false);
  }, []);

  // Debounce on query change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query) {
      debounceRef.current = setTimeout(() => doSearch(query), 200);
    } else {
      setResults(null);
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, doSearch]);

  const clear = useCallback(() => {
    setQuery('');
    setResults(null);
  }, []);

  const navigateTo = useCallback((type: string, id: string) => {
    clear();
    navigate(`${SEARCH_NAV_PATHS[type] ?? '/'}${id}`);
  }, [navigate, clear]);

  const totalCount = results
    ? results.branches.length + results.assayers.length + results.projects.length +
      results.clients.length + results.assignments.length
    : 0;

  return { query, setQuery, results, loading, navigateTo, clear, totalCount };
}
