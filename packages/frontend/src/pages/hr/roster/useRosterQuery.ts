import { useMemo, useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { fetchWholeAssayerRoster } from '../../../services/assayer-roster';
import { queryKeys } from '../../../hooks/queryKeys';
import {
  ROSTER_FILTERS,
  EMPTY_FILTERS,
  applyRosterFilters,
  activeFilterCount,
  describeFilters,
  parseFilters,
  writeFilters,
  segmentFor,
  toServerQuery,
  withClientChoices,
  missingFields,
  type RosterFilterState,
  type RosterPerson,
} from '../roster-filters';
import { useClientOptions } from '../../../hooks/useClients';

export type SortKey =
  | 'displayName'
  | 'assayerCode'
  | 'lifecycleStatus'
  | 'state'
  | 'experienceYears'
  | 'completeness'
  | 'joiningDate';

export interface UseRosterQueryResult {
  filters: RosterFilterState;
  setFilters: (next: RosterFilterState) => void;
  clearFilters: () => void;
  searchInput: string;
  setSearchInput: (v: string) => void;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  sortBy: (key: SortKey) => void;
  filterDefs: typeof ROSTER_FILTERS;
  appliedCount: number;
  activeCriteria: string[];
  selectedSegment: ReturnType<typeof segmentFor>;
  allAssayers: RosterPerson[];
  filteredRows: RosterPerson[];
  sortedRows: RosterPerson[];
  totalCount: number;
  missingCount: number;
  truncated: boolean;
  loading: boolean;
  isError: boolean;
  error: unknown;
  refresh: () => void;
}

export function useRosterQuery(): UseRosterQueryResult {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const setFilters = useCallback(
    (next: RosterFilterState) => setSearchParams(writeFilters(searchParams, next), { replace: true }),
    [searchParams, setSearchParams],
  );

  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), [setFilters]);

  // Race-safe debounced search: UI state responds immediately, query syncs after 250ms
  const [searchInput, setSearchInput] = useState(filters.search);
  useEffect(() => {
    setSearchInput(filters.search);
  }, [filters.search]);

  useEffect(() => {
    if (searchInput === filters.search) return;
    const timer = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (searchInput.trim()) next.set('q', searchInput.trim());
          else next.delete('q');
          return next;
        },
        { replace: true },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput, filters.search, setSearchParams]);

  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'displayName',
    dir: 'asc',
  });

  const sortBy = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  const { data: clientOptions } = useClientOptions();
  const filterDefs = useMemo(
    () => withClientChoices(ROSTER_FILTERS, clientOptions ?? []),
    [clientOptions],
  );

  const serverQuery = useMemo(() => toServerQuery(filters), [filters]);

  const rosterQuery = useQuery({
    queryKey: queryKeys.hr.roster(serverQuery),
    queryFn: ({ signal }) => fetchWholeAssayerRoster<RosterPerson>({ query: serverQuery, signal }),
    placeholderData: keepPreviousData,
  });

  const allAssayers = rosterQuery.data?.people ?? [];
  const totalCount = rosterQuery.data?.total ?? 0;
  const missingCount = rosterQuery.data?.missing ?? 0;
  const truncated = missingCount > 0;
  const loading = rosterQuery.isLoading;

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.hr.rosterAll });
    queryClient.invalidateQueries({ queryKey: queryKeys.hr.workforce });
  }, [queryClient]);

  const selectedSegment = useMemo(() => segmentFor(filters.segment), [filters.segment]);

  const filteredRows = useMemo(() => applyRosterFilters(allAssayers, filters), [allAssayers, filters]);

  const sortedRows = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filteredRows].sort((x, y) => {
      let a: any, b: any;
      if (sort.key === 'completeness') {
        a = missingFields(x).length;
        b = missingFields(y).length;
      } else if (sort.key === 'joiningDate') {
        a = x.joiningDate ?? '';
        b = y.joiningDate ?? '';
      } else {
        a = (x as any)[sort.key] ?? '';
        b = (y as any)[sort.key] ?? '';
      }
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
      return String(a).localeCompare(String(b)) * dir;
    });
  }, [filteredRows, sort]);

  const appliedCount = useMemo(() => activeFilterCount(filters), [filters]);

  const activeCriteria = useMemo(() => {
    const applied = describeFilters(filters, filterDefs).map((f) => `"${f.label}"`);
    return applied.length ? applied : ['the current view'];
  }, [filters, filterDefs]);

  return {
    filters,
    setFilters,
    clearFilters,
    searchInput,
    setSearchInput,
    sort,
    sortBy,
    filterDefs,
    appliedCount,
    activeCriteria,
    selectedSegment,
    allAssayers,
    filteredRows,
    sortedRows,
    totalCount,
    missingCount,
    truncated,
    loading,
    isError: rosterQuery.isError,
    error: rosterQuery.error,
    refresh,
  };
}
