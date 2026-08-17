/**
 * FAPOMS — Global Operational Scope
 *
 * The header's scope filter. It started as a project-only dropdown; this widens it to the
 * dimensions an operator actually works in — region, zone, state, client — so someone running
 * the West can narrow the whole application to the West and stop reading other regions'
 * branches by mistake.
 *
 * ## Region is not just a filter
 *
 * The other four dimensions are conveniences: widening back to "All" shows the operator
 * nothing they were not already entitled to see. Region is an *assignment* (`users.regions`),
 * and the server enforces it in `resolveGlobalScope` regardless of what this context sends.
 * What this file does with `assignedRegions` is cosmetic — hiding regions the account cannot
 * open, so the dropdown does not offer doors that are locked. Never treat it as the control.
 *
 * ## Why the values go into query keys
 *
 * The old project filter was applied by filtering already-fetched arrays in the page. That
 * cannot work for region: the branch list is paginated server-side, so filtering the current
 * page client-side would show "3 of 500" and hide the rest. Consumers send `scopeParams` to
 * the API and put `scopeKey` in their React Query key, so changing scope refetches rather
 * than re-slicing.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Region } from '@fapoms/shared';
import { api } from '../services/api';
import { queryKeys } from '../hooks/queryKeys';

export interface ProjectOption {
  id: string;
  projectNumber: string;
  name: string;
  clientId: string;
  client?: { id: string; name: string; clientCode: string };
}

export interface ScopeOptions {
  /** Null when the account holds every region; an array when it is assigned a subset. */
  assignedRegions: Region[] | null;
  regions: { value: Region; label: string; count: number }[];
  states: { value: string; region: string | null; count: number }[];
  zones: { id: string; name: string; clientId: string | null }[];
  clients: { id: string; name: string; clientCode: string }[];
  projects: ProjectOption[];
}

/** `'ALL'` on any dimension means that dimension is not filtering. */
export interface ScopeSelection {
  projectId: string;
  clientId: string;
  region: string;
  zoneId: string;
  state: string;
}

export const EMPTY_SCOPE: ScopeSelection = {
  projectId: 'ALL',
  clientId: 'ALL',
  region: 'ALL',
  zoneId: 'ALL',
  state: 'ALL',
};

interface ScopeContextValue extends ScopeSelection {
  options: ScopeOptions;
  loading: boolean;

  setScope: (patch: Partial<ScopeSelection>) => void;
  resetScope: () => void;

  /**
   * True only on the territorial desks listed in `SCOPE_GOVERNED_ROUTES`; false on every
   * national desk (data entry, validation, HR, documents, billing, admin).
   *
   * When false, `scopeParams` is empty and `activeCount` is 0 — so a page that sends the
   * scope unconditionally still sends nothing, and the header hides the control rather than
   * offering a filter that does not apply. The operator's selection is *retained*, not
   * cleared: they get it back when they return to an operations page.
   */
  applies: boolean;

  /** Number of dimensions currently narrowing the view. Always 0 where the scope does not apply. */
  activeCount: number;
  isFiltering: boolean;

  /** Query-string params for an API call, omitting every dimension set to 'ALL'. */
  scopeParams: Record<string, string>;
  /** Append to a React Query key so a scope change refetches. */
  scopeKey: string;

  /** States that belong to the selected region — what the state dropdown should offer. */
  availableStates: ScopeOptions['states'];
  /** Zones that belong to the selected client — what the zone dropdown should offer. */
  availableZones: ScopeOptions['zones'];

  // --- Project-only accessors, kept for the pages that already use them ---
  projects: ProjectOption[];
  selectedProjectId: string;
  setSelectedProjectId: (id: string) => void;
  selectedProject: ProjectOption | null;
}

/**
 * The desks the global scope governs — and, by omission, the ones it does not.
 *
 * The business runs two kinds of desk. Field-operations desks (planning, assignment,
 * scheduling, dispatch, the coverage map, the ops dashboard) are organised by territory:
 * each operator runs a part of India, and on login they should see their part, not everyone
 * else's. Every other desk is national. Data entry and validation work whatever file arrives,
 * wherever it came from; HR manages the whole workforce; finance bills the whole book; admin
 * pages configure the system. On those desks a region filter is not merely unnecessary — a
 * visible control that does nothing reads as a broken one.
 *
 * This is therefore an ALLOWLIST of governed routes, not a blocklist of exempt ones: the
 * territorial desks are the small, well-defined set, and a new page defaults to national
 * until someone decides it is territory work. Matched as path prefixes.
 *
 * Note the account-level assignment (`users.regions`) is a separate mechanism and is NOT
 * gated by this list: the server enforces it on every region-bearing endpoint regardless of
 * which page the request came from. National-desk staff simply have no assignment, so they
 * see everything. This list only controls the header's convenience filter.
 */
const SCOPE_GOVERNED_ROUTES = [
  '/dashboard',
  '/executive-map',
  '/projects',
  '/planning',
  '/scheduling',
  '/assignments',
  '/branches',
  '/inbox',
  '/field-issues',
];

function isScopeExempt(pathname: string): boolean {
  return !SCOPE_GOVERNED_ROUTES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const ScopeContext = createContext<ScopeContextValue | undefined>(undefined);

const STORAGE_KEY = 'fapoms_global_scope';
/** The project-only key this replaces. Read once, so an operator's project survives the upgrade. */
const LEGACY_PROJECT_KEY = 'fapoms_selected_project';

const EMPTY_OPTIONS: ScopeOptions = {
  assignedRegions: null,
  regions: [],
  states: [],
  zones: [],
  clients: [],
  projects: [],
};

function readStoredScope(): ScopeSelection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...EMPTY_SCOPE, ...JSON.parse(raw) };
  } catch {
    // A corrupt entry is not worth failing the app over — fall through to the default.
  }
  const legacyProject = localStorage.getItem(LEGACY_PROJECT_KEY);
  return legacyProject ? { ...EMPTY_SCOPE, projectId: legacyProject } : EMPTY_SCOPE;
}

export const ScopeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [scope, setScopeState] = useState<ScopeSelection>(readStoredScope);
  const { pathname } = useLocation();
  const applies = !isScopeExempt(pathname);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.scope.options,
    queryFn: () =>
      api.request<{ data: ScopeOptions }>('/scope/options', { method: 'GET', withMeta: true }),
    // Gated on a token. This provider mounts above the router, so without the gate it fires on
    // the login page and 401s on every cold visit; the request re-enables on the re-render that
    // follows a successful sign-in.
    enabled: Boolean(localStorage.getItem('fapoms_token')),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const options: ScopeOptions = useMemo(() => {
    const payload = (data as any)?.data ?? data;
    return payload ? { ...EMPTY_OPTIONS, ...payload } : EMPTY_OPTIONS;
  }, [data]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scope));
  }, [scope]);

  const setScope = useCallback((patch: Partial<ScopeSelection>) => {
    setScopeState((current) => {
      const next = { ...current, ...patch };
      // Changing region invalidates a state that sits outside it, and changing client
      // invalidates a zone that belongs to another client. Clearing the dependent dimension
      // is the only honest option — leaving it set yields an empty screen with two filters
      // lit up and no indication which one is the culprit.
      if (patch.region !== undefined && patch.state === undefined) next.state = 'ALL';
      if (patch.clientId !== undefined && patch.zoneId === undefined) next.zoneId = 'ALL';
      return next;
    });
  }, []);

  const resetScope = useCallback(() => setScopeState(EMPTY_SCOPE), []);

  // Drop selections that no longer exist — a deleted project or a region the account lost
  // access to must not leave the app silently filtered to nothing.
  useEffect(() => {
    if (isLoading) return;
    const patch: Partial<ScopeSelection> = {};
    if (scope.projectId !== 'ALL' && options.projects.length && !options.projects.some((p) => p.id === scope.projectId)) patch.projectId = 'ALL';
    if (scope.clientId !== 'ALL' && options.clients.length && !options.clients.some((c) => c.id === scope.clientId)) patch.clientId = 'ALL';
    if (scope.region !== 'ALL' && options.regions.length && !options.regions.some((r) => r.value === scope.region)) patch.region = 'ALL';
    if (scope.zoneId !== 'ALL' && options.zones.length && !options.zones.some((z) => z.id === scope.zoneId)) patch.zoneId = 'ALL';
    if (scope.state !== 'ALL' && options.states.length && !options.states.some((s) => s.value === scope.state)) patch.state = 'ALL';
    if (Object.keys(patch).length) setScopeState((current) => ({ ...current, ...patch }));
  }, [options, isLoading, scope]);

  const availableStates = useMemo(
    () => (scope.region === 'ALL' ? options.states : options.states.filter((s) => s.region === scope.region)),
    [options.states, scope.region],
  );

  const availableZones = useMemo(
    () => (scope.clientId === 'ALL' ? options.zones : options.zones.filter((z) => !z.clientId || z.clientId === scope.clientId)),
    [options.zones, scope.clientId],
  );

  const scopeParams = useMemo(() => {
    // Emptied wholesale off the governed desks. Doing it here rather than at each call site
    // means a page cannot leak the scope into another desk's queue by forgetting to check.
    if (!applies) return {};
    const params: Record<string, string> = {};
    if (scope.projectId !== 'ALL') params.projectId = scope.projectId;
    if (scope.clientId !== 'ALL') params.clientId = scope.clientId;
    if (scope.region !== 'ALL') params.region = scope.region;
    if (scope.zoneId !== 'ALL') params.zoneId = scope.zoneId;
    if (scope.state !== 'ALL') params.state = scope.state;
    return params;
  }, [scope, applies]);

  const activeCount = Object.keys(scopeParams).length;

  const value = useMemo<ScopeContextValue>(() => ({
    ...scope,
    options,
    loading: isLoading,
    setScope,
    resetScope,
    applies,
    activeCount,
    isFiltering: activeCount > 0,
    scopeParams,
    scopeKey: new URLSearchParams(scopeParams).toString() || 'ALL',
    availableStates,
    availableZones,
    projects: options.projects,
    selectedProjectId: scope.projectId,
    setSelectedProjectId: (id: string) => setScope({ projectId: id }),
    selectedProject: options.projects.find((p) => p.id === scope.projectId) ?? null,
  }), [scope, options, isLoading, setScope, resetScope, applies, activeCount, scopeParams, availableStates, availableZones]);

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
};

export const useScope = (): ScopeContextValue => {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error('useScope must be used within a ScopeProvider');
  return ctx;
};

export { SCOPE_DIMENSIONS, withScope, scopeConflict } from './scope-merge';
export type { ScopeDimension, ScopeConflict } from './scope-merge';
