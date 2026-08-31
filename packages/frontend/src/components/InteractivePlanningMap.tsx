import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { useQuery } from '@tanstack/react-query';
import { calculateHaversineDistance } from '@fapoms/shared';
import { Maximize2, Minimize2 } from 'lucide-react';
import { api } from '../services/api';
import { queryKeys } from '../hooks/queryKeys';
import { useScope, withScope } from '../context/ScopeContext';
import { MapLayerControls } from './MapLayerControls';
import { branchStatusColor, BRANCH_STATUS_LEGEND } from '../utils/statusLabels';
import {
  buildSpotlightColorScale, SPOTLIGHT_COLOR, OTHER_BANK_COLOR,
  isQualifyingStanding, lifecycleBucketOf, LIFECYCLE_BUCKET_TINT,
  ASSAYER_LIFECYCLE_BUCKETS, LIFECYCLE_RING_COLORS, MapEmpanelment,
} from '../utils/clientColors';

/** Stable empty roster, so "not loaded yet" is not a new array on every render. */
const NO_ASSAYERS: any[] = [];

interface MapBranch {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  status: string;
  city?: string;
  riskScore?: number;
  /** Which bank this branch belongs to — what the colour-by-client mode paints with. */
  clientId?: string | null;
  clientName?: string | null;
}

/** One assayer as `/assayers/map-roster` serves them — pin facts only, never the full record. */
interface MapRosterAssayer {
  id: string;
  assayerCode: string;
  displayName: string;
  phone?: string | null;
  status?: string;
  lifecycleStatus?: string;
  latitude: number | null;
  longitude: number | null;
  /** True while the position is a district/state average awaiting the precision sweep. */
  approxLocation?: boolean;
  state?: string | null;
  district?: string | null;
  empanelments: MapEmpanelment[];
  assignedToday: boolean;
  openAssignments: number;
}

/**
 * A pin as the draw effect *describes* it — plain data, no Leaflet object yet.
 *
 * Every field is compared against the previous pass to decide what work a pin actually needs, so
 * every field has to be cheap to compare and stable when nothing changed. That is why the icon is
 * carried as its html string rather than as an `L.DivIcon`: two `L.divIcon(...)` calls with
 * identical arguments produce two different objects, so comparing icon instances would report a
 * change on every run and defeat the whole exercise.
 */
interface MarkerSpec {
  lat: number;
  lng: number;
  iconHtml: string;
  iconClassName: string;
  iconSize: [number, number];
  iconAnchor: [number, number];
  /** `null` for a pin with no popup — assayer pins have one, branch pins do not. */
  popupHtml: string | null;
  /**
   * What a click on this pin should do *now*.
   *
   * Never handed to Leaflet directly. A pin now survives across effect runs, so a listener that
   * closed over one run's handler would keep routing to the branch that was selected, and the
   * distance that was measured, at the moment the pin was drawn. `reconcileMarkers` installs one
   * listener for the life of the pin that looks this up fresh on each click instead.
   */
  onClick: (() => void) | null;
}

/** A pin on the map, together with the description it was last drawn from. */
interface DrawnMarker {
  marker: L.Marker;
  spec: MarkerSpec;
}

/** The one place a description turns into a real Leaflet icon — called only when it has to be. */
const buildDivIcon = (spec: MarkerSpec) => L.divIcon({
  html: spec.iconHtml,
  className: spec.iconClassName,
  iconSize: spec.iconSize,
  iconAnchor: spec.iconAnchor,
});

/** Would these two descriptions produce the same DOM node? If so, `setIcon` is pure waste. */
const sameIcon = (a: MarkerSpec, b: MarkerSpec) =>
  a.iconHtml === b.iconHtml &&
  a.iconClassName === b.iconClassName &&
  a.iconSize[0] === b.iconSize[0] && a.iconSize[1] === b.iconSize[1] &&
  a.iconAnchor[0] === b.iconAnchor[0] && a.iconAnchor[1] === b.iconAnchor[1];

/**
 * Bring the pins on `map` in line with `desired`, touching as little as possible.
 *
 * The draw effect used to `.remove()` every marker and rebuild the lot with fresh `L.marker` /
 * `L.divIcon` calls each time it ran. On a 5,000-branch project, selecting a single branch meant
 * destroying 5,000 DOM nodes and creating 5,000 more to recolour one pin — and, because the pin
 * carrying an open popup was destroyed with the rest, closing that popup under whoever was
 * reading it.
 *
 * Three cases, and only the first two cost any DOM work:
 *  - a key in `desired` that is not on the map yet — create the marker;
 *  - a key on the map that `desired` no longer lists (filtered out, its layer switched off, or
 *    now outside the search radius) — remove it;
 *  - a key in both — compare the two descriptions and apply only the difference: `setLatLng`
 *    when a branch has been re-geocoded, `setIcon` when the colour or rank badge changed,
 *    `setPopupContent` when the text changed. `setPopupContent` earns its place on its own:
 *    rebinding the popup, or replacing the marker, shuts a popup that is currently open.
 *
 * `drawn` is the caller's ref map and is mutated in place — the click listener installed below
 * reads back through it by key, so it must stay the same object for the life of the component.
 */
const reconcileMarkers = (
  map: L.Map,
  drawn: Map<string, DrawnMarker>,
  desired: Map<string, MarkerSpec>,
) => {
  // Gone. Deleting the entry currently being visited is safe during `Map.forEach`.
  drawn.forEach((entry, key) => {
    if (desired.has(key)) return;
    entry.marker.remove();
    drawn.delete(key);
  });

  desired.forEach((spec, key) => {
    const existing = drawn.get(key);

    if (!existing) {
      const marker = L.marker([spec.lat, spec.lng], { icon: buildDivIcon(spec) });
      // One listener for the life of the pin, dispatching through `drawn` so it always runs the
      // handler from the most recent pass rather than the one this pin was born with.
      marker.on('click', () => drawn.get(key)?.spec.onClick?.());
      if (spec.popupHtml !== null) marker.bindPopup(spec.popupHtml);
      marker.addTo(map);
      drawn.set(key, { marker, spec });
      return;
    }

    const { marker, spec: prev } = existing;

    if (prev.lat !== spec.lat || prev.lng !== spec.lng) {
      marker.setLatLng([spec.lat, spec.lng]);
    }
    if (!sameIcon(prev, spec)) {
      // For a divIcon this does not even replace the element: Leaflet's `DivIcon.createIcon`
      // hands back the existing `<div>` and rewrites its `innerHTML`, so the node stays put and
      // the marker's listeners and bound popup come through untouched. Recolouring the selected
      // branch costs an innerHTML write on two pins, not a node anywhere.
      marker.setIcon(buildDivIcon(spec));
    }
    if (prev.popupHtml !== spec.popupHtml) {
      if (spec.popupHtml === null) marker.unbindPopup();
      else if (prev.popupHtml === null) marker.bindPopup(spec.popupHtml);
      else marker.setPopupContent(spec.popupHtml);
    }

    // Recorded last, so the click dispatcher only starts using the new handler once the pin it
    // describes has actually been brought up to date.
    existing.spec = spec;
  });
};

interface InteractivePlanningMapProps {
  branches: MapBranch[];
  selectedBranchId: string | null;
  onSelectBranch: (id: string) => void;
  routePoints?: { latitude: number; longitude: number }[];
  fillContainer?: boolean;
  selectedAssayerFromParent?: any | null;
  slaEnabled?: boolean;
  slaRadius?: number;
  /**
   * Recommendation results for the selected branch. The map previously coloured every assayer
   * purely by straight-line distance, so the engine's top pick and an assayer blocked by a
   * regulation looked identical — the operator had to cross-reference the list by hand.
   */
  rankedCandidates?: { id: string; score?: number; scoreBreakdown?: Record<string, number> }[];
  excludedCandidates?: { assayerId: string; reason: string; detail?: string }[];
  /**
   * The client's contracted travel rates, from /pricing/rates. The map used to price travel as
   * `distance x 8` with no free-commute allowance, so the figure an operator read here was not
   * the figure the assignment would be billed at.
   */
  travelRates?: { travelFeePerKm: number; freeTravelAllowanceKm: number } | null;
  /**
   * The search radius, owned by the parent so one number governs the whole screen.
   *
   * It used to live only in here, as private state persisted to localStorage. That made the
   * map's own slider the only thing it affected: the recommendation engine searched a fixed
   * 200 km regardless, so setting 350 km drew pins for assayers the engine had already
   * discarded — an empty candidate list beside a map full of markers, with nothing linking the
   * two. Lifting it lets the same value bound the engine's search and draw the circle.
   *
   * Optional so the map still works standalone (Executive Map has no candidate list to sync
   * with); absent, it falls back to its own persisted state exactly as before.
   */
  searchRadiusKm?: number;
  onSearchRadiusChange?: (km: number) => void;
}

export const InteractivePlanningMap: React.FC<InteractivePlanningMapProps> = React.memo(({
  branches,
  selectedBranchId,
  onSelectBranch,
  routePoints,
  fillContainer,
  selectedAssayerFromParent,
  slaEnabled: slaEnabledProp = false,
  slaRadius: slaRadiusProp = 50,
  rankedCandidates,
  excludedCandidates,
  travelRates,
  searchRadiusKm: searchRadiusProp,
  onSearchRadiusChange,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  /**
   * Every marker currently on the map, keyed by a namespaced stable id — `branch-<id>` and
   * `assayer-<id>`, namespaced so a branch and an assayer that happen to share a uuid can never
   * collide on one entry.
   *
   * The draw effect describes the pins it wants and hands them to `reconcileMarkers`, which
   * diffs them against this map; see the comment there for what that replaced. The `Map` object
   * itself is created once and never reassigned, because the click listener on every pin holds a
   * reference to it.
   */
  const markersRef = useRef<Map<string, DrawnMarker>>(new Map());
  const circlesRef = useRef<L.Circle[]>([]);
  const polylineRef = useRef<L.Polyline | null>(null);
  const activeRoutePolylineRef = useRef<L.Polyline | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  /**
   * The last set of inputs the view was auto-framed for. The draw effect re-runs on every pan and
   * zoom now (to cull pins to the viewport), and it used to call `fitBounds` unconditionally at the
   * end — which fired `moveend`, updated `renderBounds`, re-ran the draw effect, and fit again, in a
   * tight infinite loop that pinned the main thread. Auto-framing must happen only when the reason
   * to frame actually changes (a branch selected, a route drawn, the radius adjusted), never on a
   * redraw the user's own pan/zoom triggered — otherwise the map fights the person moving it.
   */
  const lastFrameKeyRef = useRef<string | null>(null);
  /**
   * The parent's click handler, read through a ref.
   *
   * Pins now outlive the effect run that drew them, and `onSelectBranch` is deliberately not in
   * that effect's dependency list — redrawing the map because a parent re-rendered with a new
   * inline arrow is exactly what the memoisation work was undoing. Without this ref those two
   * facts combine badly: a pin would go on calling whichever `onSelectBranch` the parent happened
   * to pass on the render that drew it, so clicking a branch would select it against a version of
   * the parent's state that no longer exists. Reading `.current` at click time costs nothing and
   * removes the whole class of bug.
   */
  const onSelectBranchRef = useRef(onSelectBranch);
  onSelectBranchRef.current = onSelectBranch;

  /**
   * Creates the Leaflet map the first time anything needs it.
   *
   * Two effects now want the map — the basemap effect and the draw effect — and neither can
   * assume the other has run first, so whichever gets there first builds it. Kept as a function
   * rather than a mount effect so a container ref that is not yet attached simply defers the
   * work to the next run, which is how the single combined effect behaved before the split.
   */
  const ensureMap = useCallback((): L.Map | null => {
    if (mapInstanceRef.current) return mapInstanceRef.current;
    if (!mapContainerRef.current) return null;
    // Centred on India.
    mapInstanceRef.current = L.map(mapContainerRef.current, { preferCanvas: true }).setView([20.5937, 78.9629], 5);
    return mapInstanceRef.current;
  }, []);

  /**
   * Only what is on screen is drawn. A national roster is thousands of branches and assayers,
   * and building a DOM pin for every one — most of them far outside the current view — is what
   * froze the map: 7,000 markers is 7,000 nodes rebuilt on every pan. `renderBounds` is the map's
   * current view, updated when it settles after a pan or zoom; the draw effect below culls to it
   * (with a margin) so the pin count tracks what a person can actually see, not the whole country.
   */
  const [renderBounds, setRenderBounds] = useState<L.LatLngBounds | null>(null);
  useEffect(() => {
    const map = ensureMap();
    if (!map) return;
    const update = () => setRenderBounds(map.getBounds());
    update();
    map.on('moveend zoomend', update);
    return () => { map.off('moveend zoomend', update); };
  }, [ensureMap]);

  // GIP Layer state configuration (persisted in localStorage)
  const [showBranches, setShowBranches] = useState(() => localStorage.getItem('map_showBranches') !== 'false');
  const [showRoutes, setShowRoutes] = useState(() => localStorage.getItem('map_showRoutes') !== 'false');
  const [showAssayers, setShowAssayers] = useState(() => localStorage.getItem('map_showAssayers') !== 'false');

  useEffect(() => localStorage.setItem('map_showBranches', String(showBranches)), [showBranches]);
  useEffect(() => localStorage.setItem('map_showRoutes', String(showRoutes)), [showRoutes]);
  useEffect(() => localStorage.setItem('map_showAssayers', String(showAssayers)), [showAssayers]);

  // Phase 4 Analytics Layers states (persisted in localStorage)
  const [showSlaRisk, setShowSlaRisk] = useState(() => localStorage.getItem('map_showSlaRisk') === 'true');
  const [slaRadiusKm, setSlaRadiusKm] = useState(() => Number(localStorage.getItem('map_slaRadiusKm')) || 50);
  const effectiveSlaRadius = slaEnabledProp ? slaRadiusProp : slaRadiusKm;
  const effectiveSlaEnabled = slaEnabledProp || showSlaRisk;
  const [showWorkforceDensity, setShowWorkforceDensity] = useState(() => localStorage.getItem('map_showWorkforceDensity') === 'true');
  const [showRevenueDensity, setShowRevenueDensity] = useState(() => localStorage.getItem('map_showRevenueDensity') === 'true');

  useEffect(() => localStorage.setItem('map_showSlaRisk', String(showSlaRisk)), [showSlaRisk]);
  useEffect(() => localStorage.setItem('map_slaRadiusKm', String(slaRadiusKm)), [slaRadiusKm]);
  useEffect(() => localStorage.setItem('map_showWorkforceDensity', String(showWorkforceDensity)), [showWorkforceDensity]);
  useEffect(() => localStorage.setItem('map_showRevenueDensity', String(showRevenueDensity)), [showRevenueDensity]);

  // Basemap selection state (persisted in localStorage).
  // 'auto' tracks the app theme: dark/glass-dark/custom-dark -> Dark, else -> Light.
  const [mapStyle, setMapStyle] = useState<'auto' | 'voyager' | 'dark' | 'satellite'>(() => {
    const saved = localStorage.getItem('map_style');
    return (saved === 'voyager' || saved === 'dark' || saved === 'satellite' || saved === 'auto') ? saved : 'auto';
  });
  const [appTheme, setAppTheme] = useState(() =>
    typeof document !== 'undefined' ? (document.documentElement.dataset.theme || '') : ''
  );
  const [showLegend, setShowLegend] = useState(false);

  useEffect(() => localStorage.setItem('map_style', mapStyle), [mapStyle]);

  // Keep the map basemap in sync with the app theme (listens for data-theme changes).
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setAppTheme(root.dataset.theme || ''));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const DARK_THEMES = ['noir', 'black-gold', 'black-white', 'slate', 'midnight', 'glass-dark'];
  const effectiveMapStyle: 'voyager' | 'dark' | 'satellite' =
    mapStyle === 'auto'
      ? DARK_THEMES.includes(appTheme) ? 'dark' : 'voyager'
      : mapStyle;

  /**
   * Radius search filter. The parent's value wins when it supplies one — see `searchRadiusKm`.
   *
   * The local state remains for standalone use (Executive Map), so behaviour there is
   * unchanged. When a parent is controlling it, writes go up rather than staying here, which is
   * what keeps the map's circle and the engine's search area from drifting apart.
   */
  const [ownRadiusKm, setOwnRadiusKm] = useState<number>(() => {
    const saved = localStorage.getItem('map_radiusKm');
    return saved ? Number(saved) : 300;
  });
  const isRadiusControlled = searchRadiusProp != null;
  const radiusKm = isRadiusControlled ? searchRadiusProp : ownRadiusKm;
  const setRadiusKm = (km: number) => {
    if (onSearchRadiusChange) onSearchRadiusChange(km);
    if (!isRadiusControlled) setOwnRadiusKm(km);
  };

  // Persisted either way, so the operator's choice survives a reload on both screens.
  useEffect(() => localStorage.setItem('map_radiusKm', String(radiusKm)), [radiusKm]);

  // Filter states (persisted)
  const [searchQuery, setSearchQuery] = useState(() => localStorage.getItem('map_searchQuery') || '');
  const [cityFilter, setCityFilter] = useState(() => localStorage.getItem('map_cityFilter') || '');
  const [branchStatusFilter, setBranchStatusFilter] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('map_branchStatusFilter') || '[]'); } catch { return []; }
  });

  useEffect(() => localStorage.setItem('map_searchQuery', searchQuery), [searchQuery]);
  useEffect(() => localStorage.setItem('map_cityFilter', cityFilter), [cityFilter]);
  useEffect(() => localStorage.setItem('map_branchStatusFilter', JSON.stringify(branchStatusFilter)), [branchStatusFilter]);

  /**
   * The control-center additions: what the pins are coloured BY (workflow status, or one
   * colour per bank so a mixed-lender map reads at a glance), and the assayer-layer filters —
   * by bank, by lifecycle bucket, by whether they are already committed today. Persisted like
   * every other map preference. Engine-ranked and engine-excluded candidates BYPASS these
   * filters (see `filteredAssayers`): a "Free today" left on from the executive map must never
   * silently hide the recommendation list's pins on the planning desk.
   */
  // Keyed 'map_colorMode2': the first build wrote its then-default ('status') into every
  // visitor's storage, and a stored value beats any later default — so the bank-colour
  // default never reached anyone who had opened the map once. Fresh key, fresh default;
  // choosing Status from now on still persists.
  const [colorMode, setColorMode] = useState<'status' | 'client'>(() =>
    localStorage.getItem('map_colorMode2') === 'status' ? 'status' : 'client');
  const [assayerClientFilter, setAssayerClientFilter] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('map_assayerClientFilter') || '[]'); } catch { return []; }
  });
  const [assayerLifecycleFilter, setAssayerLifecycleFilter] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('map_assayerLifecycleFilter') || '[]'); } catch { return []; }
  });
  const [assayerAvailability, setAssayerAvailability] = useState<'ALL' | 'ASSIGNED' | 'FREE'>(() => {
    const saved = localStorage.getItem('map_assayerAvailability');
    return saved === 'ASSIGNED' || saved === 'FREE' ? saved : 'ALL';
  });
  useEffect(() => localStorage.setItem('map_colorMode2', colorMode), [colorMode]);
  useEffect(() => localStorage.setItem('map_assayerClientFilter', JSON.stringify(assayerClientFilter)), [assayerClientFilter]);
  useEffect(() => localStorage.setItem('map_assayerLifecycleFilter', JSON.stringify(assayerLifecycleFilter)), [assayerLifecycleFilter]);
  useEffect(() => localStorage.setItem('map_assayerAvailability', assayerAvailability), [assayerAvailability]);

  /**
   * The bigger view. Not persisted — a reload comes back windowed. `position: fixed` lifts the
   * whole card (legend, controls and routing panel are its absolute children, so they come
   * along) above the sidebar (z 990-1000) at the modal layer; Leaflet needs an
   * `invalidateSize` nudge after the container's size jumps, and Esc gets you out.
   */
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => mapInstanceRef.current?.invalidateSize(), 100);
    if (!isFullscreen) return () => clearTimeout(timer);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false); };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', onKey); };
  }, [isFullscreen]);

  /**
   * Memoised, because this array is a dependency of the effect that draws the map.
   *
   * As a bare `.filter()` it produced a new array on every single render of this component — and
   * of its parent, which owns some sixty pieces of state. The draw effect listed it in its deps,
   * so moving an unrelated slider removed and re-added every marker on the map and re-attached the
   * tile layer, refetching tiles from the CDN each time.
   */
  const filteredBranches = useMemo(() => branches.filter(b => {
    if (searchQuery && !b.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (cityFilter && !(b.city || '').toLowerCase().includes(cityFilter.toLowerCase())) return false;
    if (branchStatusFilter.length > 0 && !branchStatusFilter.includes(b.status)) return false;
    return true;
  }), [branches, searchQuery, cityFilter, branchStatusFilter]);

  // Real-time routing overlay states
  const [selectedAssayerForRouting, setSelectedAssayerForRouting] = useState<any | null>(null);
  const [travelMode, setTravelMode] = useState<'driving' | 'two-wheeler' | 'walking'>('driving');
  const [roadDistanceKm, setRoadDistanceKm] = useState<number | null>(null);
  const [roadDurationMinutes, setRoadDurationMinutes] = useState<number | null>(null);
  const [roadGeometry, setRoadGeometry] = useState<L.LatLngExpression[]>([]);

  /**
   * The assayer roster, as a shared query rather than this component's own `useEffect` + state.
   *
   * The planning workspace has five layouts and each one renders its own `<InteractivePlanningMap>`
   * element, so switching layout unmounted one map and mounted another — and re-downloaded the
   * whole roster every time. One key means one fetch, shared by every map on the page and reused
   * across mounts, and React Query's `signal` cancels it if the map goes away mid-flight.
   */
  // The global scope, read here rather than plumbed through props: both pages that render this
  // map are scope-governed routes, and the assayer layer ignoring the header's scope while the
  // branch layer honoured it was the reported "map ignores my filters" bug.
  const { scopeParams, scopeKey } = useScope();
  const { data: realAssayers = NO_ASSAYERS } = useQuery({
    queryKey: queryKeys.assayers.mapRoster(scopeKey),
    // The whole (scoped) roster, as pin facts only — `/assayers/map-roster` serves eleven
    // fields plus bank standings and committed-today, not the 78-column record the old
    // `/assayers?limit=5000` fetch dragged along for a layer that renders dots.
    queryFn: ({ signal }) => {
      const qs = withScope(scopeParams);
      return api.request<MapRosterAssayer[]>(`/assayers/map-roster${qs ? `?${qs}` : ''}`, { signal });
    },
    staleTime: 5 * 60_000,
  });

  /**
   * Engine results are exempt from the assayer-layer filters below. These sets identify them;
   * hiding a ranked candidate because of a leftover map preference would make the map disagree
   * with the recommendation list beside it.
   */
  const rankedOrExcludedIds = useMemo(() => new Set([
    ...(rankedCandidates ?? []).map((c) => c.id),
    ...(excludedCandidates ?? []).map((e) => e.assayerId),
  ]), [rankedCandidates, excludedCandidates]);

  /** Memoised for the same reason as `filteredBranches` above. */
  const filteredAssayers = useMemo(() => realAssayers.filter((a: MapRosterAssayer) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const nameMatch = (a.displayName || '').toLowerCase().includes(q);
      const codeMatch = (a.assayerCode || '').toLowerCase().includes(q);
      if (!nameMatch && !codeMatch) return false;
    }
    if (rankedOrExcludedIds.has(a.id)) return true;
    // Capability, not history: "show me this bank's assayers" means the people it can be
    // STAFFED with (Active/Recommended) — not everyone it ever rejected. The popup still
    // lists the full history on each pin.
    if (assayerClientFilter.length > 0
      && !(a.empanelments ?? []).some((e) => assayerClientFilter.includes(e.clientId) && isQualifyingStanding(e.status))) return false;
    if (assayerLifecycleFilter.length > 0) {
      const allowed = ASSAYER_LIFECYCLE_BUCKETS
        .filter((b) => assayerLifecycleFilter.includes(b.key))
        .flatMap((b) => b.statuses);
      if (!allowed.includes(a.lifecycleStatus ?? '')) return false;
    }
    if (assayerAvailability === 'ASSIGNED' && !a.assignedToday) return false;
    if (assayerAvailability === 'FREE' && a.assignedToday) return false;
    return true;
  }), [realAssayers, searchQuery, rankedOrExcludedIds, assayerClientFilter, assayerLifecycleFilter, assayerAvailability]);

  /**
   * Every client visible to this map — from assayer empanelments and branch pins alike — with
   * a stable colour each. One scale for both pin families is what makes "same bank, same
   * colour" hold between a branch and the people empanelled with it.
   */
  const clientOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const a of realAssayers as MapRosterAssayer[]) {
      for (const e of a.empanelments ?? []) if (!names.has(e.clientId)) names.set(e.clientId, e.clientName);
    }
    for (const b of branches) {
      if (b.clientId && !names.has(b.clientId)) names.set(b.clientId, b.clientName || b.clientId);
    }
    return [...names.entries()].map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name));
  }, [realAssayers, branches]);
  // The map spotlights ONE bank — ICICI — colouring its pins rose while every other bank shares
  // one blue, so the eye goes straight to ICICI. ICICI is found by name (so it tracks whichever
  // client is "ICICI" / "ICICI Bank Ltd", not a fixed id); change the test to spotlight another.
  const spotlightClientId = useMemo(
    () => clientOptions.find((c) => /icici/i.test(c.name))?.id ?? null,
    [clientOptions],
  );
  const clientColorOf = useMemo(() => buildSpotlightColorScale(spotlightClientId), [spotlightClientId]);

  /**
   * Live counts for the control panel, so every filter says what it will yield BEFORE it is
   * clicked — "AXIS (176)", "Out of workforce (329)" — and the header can say how many of the
   * roster the current filters actually show. A control centre that filters blind is guesswork;
   * these turn it into a readout. Computed over the whole roster (bank counts are capability —
   * Active/Recommended only, matching the filter semantics).
   */
  const assayerCounts = useMemo(() => {
    const byClient: Record<string, number> = {};
    const byLifecycle: Record<string, number> = {};
    let assignedToday = 0;
    let freeToday = 0;
    for (const a of realAssayers as MapRosterAssayer[]) {
      const bucket = lifecycleBucketOf(a.lifecycleStatus).key;
      byLifecycle[bucket] = (byLifecycle[bucket] ?? 0) + 1;
      if (a.assignedToday) assignedToday += 1; else freeToday += 1;
      const seen = new Set<string>();
      for (const e of a.empanelments ?? []) {
        if (isQualifyingStanding(e.status) && !seen.has(e.clientId)) {
          seen.add(e.clientId);
          byClient[e.clientId] = (byClient[e.clientId] ?? 0) + 1;
        }
      }
    }
    return { total: realAssayers.length, byClient, byLifecycle, assignedToday, freeToday };
  }, [realAssayers]);

  // Synchronize parent selected assayer to map routing state
  useEffect(() => {
    if (selectedAssayerFromParent && selectedBranchId) {
      const selectedBranch = branches.find(b => b.id === selectedBranchId);
      if (selectedBranch && selectedBranch.latitude !== null && selectedBranch.longitude !== null) {
        setSelectedAssayerForRouting({
          ...selectedAssayerFromParent,
          // The straight line, computed as one. This used to reuse the parent's `distanceKm`,
          // which was a straight line back when the server estimated every distance — it is
          // now usually a ROAD figure (`distanceSource === 'OSRM'`), and showing a road figure
          // under the "Straight-line:" label would be exactly the mislabel this panel must not
          // make. The server's road figure is kept separately as the fallback for a failed
          // browser-side route below, and labelled as road only when it really is one.
          straightDistance: calculateHaversineDistance(
            Number(selectedAssayerFromParent.latitude), Number(selectedAssayerFromParent.longitude),
            Number(selectedBranch.latitude), Number(selectedBranch.longitude)
          ),
          serverRoad: selectedAssayerFromParent.distanceSource === 'OSRM' && selectedAssayerFromParent.distanceKm != null
            ? {
                distanceKm: Number(selectedAssayerFromParent.distanceKm),
                durationMinutes: selectedAssayerFromParent.durationMinutes != null ? Number(selectedAssayerFromParent.durationMinutes) : null,
              }
            : null,
          aLat: Number(selectedAssayerFromParent.latitude),
          aLng: Number(selectedAssayerFromParent.longitude),
          bLat: Number(selectedBranch.latitude),
          bLng: Number(selectedBranch.longitude),
          branchName: selectedBranch.name
        });
      }
    } else {
      setSelectedAssayerForRouting(null);
    }
  }, [selectedAssayerFromParent, selectedBranchId, branches]);

  // Fetch real-time OSRM route for road geometry display
  useEffect(() => {
    if (!selectedAssayerForRouting) {
      setRoadDistanceKm(null);
      setRoadDurationMinutes(null);
      setRoadGeometry([]);
      return;
    }

    const { aLat, aLng, bLat, bLng, serverRoad } = selectedAssayerForRouting;

    // Map travel mode to OSRM profile
    const osrmProfile = travelMode === 'walking' ? 'foot' : travelMode === 'two-wheeler' ? 'cycling' : 'driving';
    const modeSpeeds: Record<string, number> = { driving: 40, 'two-wheeler': 30, walking: 5 };
    const modeSpeed = modeSpeeds[travelMode] || 40;

    const url = `https://router.project-osrm.org/route/v1/${osrmProfile}/${aLng},${aLat};${bLng},${bLat}?overview=full&geometries=geojson`;

    /**
     * No road figure from the browser. This used to copy the straight line into
     * `roadDistanceKm`, so the panel then said "Road Distance: 164 km" and "Road distance from
     * OSRM" over a straight-line number — the router being down turned an estimate into a
     * road figure on screen. Now: the server's own routed figure (it batched this pair by
     * road when it ranked the candidate, and cached it) stands in for a car journey when there
     * is one; otherwise the road fields stay null and the panel's existing "Straight-line:" /
     * "Estimate based on straight-line distance" labels take over. Nothing is ever promoted.
     */
    const fallBackHonestly = () => {
      if (travelMode === 'driving' && serverRoad) {
        setRoadDistanceKm(serverRoad.distanceKm);
        setRoadDurationMinutes(serverRoad.durationMinutes ?? (serverRoad.distanceKm / modeSpeed) * 60);
      } else {
        setRoadDistanceKm(null);
        setRoadDurationMinutes(null);
      }
      setRoadGeometry([[aLat, aLng], [bLat, bLng]]);
    };

    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (data.code === 'Ok' && data.routes?.[0]) {
          const route = data.routes[0];
          const roadKm = route.distance / 1000;
          const roadMin = route.duration / 60;
          // Validate OSRM result against mode: if avg speed > 2x mode speed, result is unrealistic (OSRM fallback)
          const avgSpeed = roadKm / (roadMin / 60);
          if (avgSpeed > modeSpeed * 2) {
            fallBackHonestly();
          } else {
            setRoadDistanceKm(roadKm);
            setRoadDurationMinutes(roadMin);
          }
          if (route.geometry?.coordinates) {
            const coords = route.geometry.coordinates.map((pt: any) => [pt[1], pt[0]] as L.LatLngExpression);
            setRoadGeometry(coords);
          }
        } else {
          fallBackHonestly();
        }
      })
      .catch(err => {
        console.error("OSRM Route fetch error", err);
        fallBackHonestly();
      });
  }, [selectedAssayerForRouting, travelMode]);

  // Resize Leaflet container whenever map visibility or container layout changes
  useEffect(() => {
    const timer = setTimeout(() => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.invalidateSize();
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [branches, selectedBranchId, routePoints, selectedAssayerFromParent]);

  /**
   * The basemap, in an effect of its own.
   *
   * This used to sit at the top of the draw effect, which meant every reason to touch a pin — a
   * keystroke in the search box, a selection change, an OSRM route arriving — also removed the
   * tile layer and added a fresh one, and the browser re-requested every visible tile from the
   * CDN. Which pins are shown has nothing to do with which basemap is under them, so the two are
   * no longer tied together.
   *
   * Watching `effectiveMapStyle` rather than `mapStyle`/`appTheme` also stops a swap when the
   * operator moves between two dark themes, where 'auto' resolves to the same tiles either way.
   *
   * Tiles live in Leaflet's `tilePane` and markers in `markerPane`, so re-adding the layer after
   * markers already exist cannot cover them up — the two effects are free to run in either order.
   */
  useEffect(() => {
    const map = ensureMap();
    if (!map) return;

    if (tileLayerRef.current) {
      tileLayerRef.current.remove();
    }

    /**
     * Fully free, no-key basemaps — nothing to sign up for, no account, no API key.
     *
     * The old street tiles came from CARTO, which started returning "API KEY REQUIRED" tiles,
     * and satellite came from an unofficial Google endpoint (keyless but against Google's terms
     * and liable to break). Both are replaced with sources that ask for nothing: OpenStreetMap
     * for the street map and Esri's public World Imagery for satellite.
     */
    const isSatellite = effectiveMapStyle === 'satellite';
    const tileUrl = isSatellite
      ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
      : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

    tileLayerRef.current = L.tileLayer(tileUrl, {
      subdomains: ['a', 'b', 'c'], // ignored by the Esri URL (it has no {s})
      maxZoom: 19,
      attribution: isSatellite
        ? '&copy; Esri, Maxar, Earthstar Geographics'
        : '&copy; OpenStreetMap contributors',
    }).addTo(map);

    /**
     * No keyless DARK raster provider survives, so the dark style is OpenStreetMap inverted at the
     * tile-pane level. Markers and shapes live in their own panes, so only the basemap darkens.
     */
    const tilePane = map.getPane('tilePane');
    if (tilePane) {
      tilePane.style.filter = effectiveMapStyle === 'dark'
        ? 'invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.9)'
        : '';
    }
  }, [effectiveMapStyle, ensureMap]);

  useEffect(() => {
    const map = ensureMap();
    if (!map) return;

    /**
     * What the map should show once this pass is done, keyed the same way `markersRef` is.
     *
     * Nothing is added to or removed from Leaflet while this is being filled in: the layer
     * passes below only *describe* pins, and the single `reconcileMarkers` call at the end works
     * out the difference against what is already on the map. Circles and polylines below are
     * still torn down and rebuilt — they are bounded by the selected branch and the analytics
     * toggles rather than by the project's branch count, so they were never the expensive half.
     */
    const desiredMarkers = new Map<string, MarkerSpec>();

    /**
     * The current view, padded so a pin just off the edge is ready before it scrolls in, is the
     * only region drawn. `inView` culls each layer to it; `MAX_PER_LAYER` is a backstop for the
     * zoomed-out case, where the whole country is "in view" and thousands of pins would pile onto a
     * few pixels anyway — past the cap they are indistinguishable, so drawing them is pure cost.
     *
     * The cap scales with zoom because building a DOM pin is not free: ~2,000 of them at once still
     * blocked the main thread for roughly a second when a whole country landed in view. At country
     * zoom the pins overlap into a single mass that conveys density, not individual sites, so a few
     * hundred tell the same story with no stall; each zoom step in reveals proportionally more,
     * and by street level `inView` alone already holds the count down. Ranked candidates and the
     * selected branch bypass the cap entirely (below), so the thing an operator is working on is
     * never the pin that gets dropped.
     */
    const viewBounds = (renderBounds ?? map.getBounds()).pad(0.35);
    const inView = (lat: number, lng: number) => viewBounds.contains([lat, lng]);
    const zoom = map.getZoom();
    // The cap only needs to bite at country view, where the whole roster is "in view" at once and
    // the pins overlap into one mass anyway. The moment you zoom in, `inView` above already holds
    // the count to what fits the screen, so the cap becomes a high backstop that real data never
    // reaches — you see every branch in the area you zoomed to. A too-low cap here was hiding
    // in-view branches at region/state zoom, which read as "the map is missing branches".
    const MAX_PER_LAYER = zoom <= 5 ? 900 : zoom <= 6 ? 2500 : 15000;

    // Clear old circles
    circlesRef.current.forEach((circle) => circle.remove());
    circlesRef.current = [];

    // Clear old polylines
    if (polylineRef.current) {
      polylineRef.current.remove();
      polylineRef.current = null;
    }
    if (activeRoutePolylineRef.current) {
      activeRoutePolylineRef.current.remove();
      activeRoutePolylineRef.current = null;
    }

    const bounds: L.LatLngTuple[] = [];

    // Find selected branch latlng coordinates
    const selectedBranch = branches.find(b => b.id === selectedBranchId);
    let selectedBranchLatLng: [number, number] | null = null;
    if (selectedBranch && selectedBranch.latitude !== null && selectedBranch.longitude !== null) {
      selectedBranchLatLng = [Number(selectedBranch.latitude), Number(selectedBranch.longitude)];
    }

    // Layer 1: Branches
    if (showBranches) {
      let branchesDrawn = 0;
      filteredBranches.forEach((b) => {
        if (b.latitude !== null && b.longitude !== null) {
          const lat = Number(b.latitude);
          const lng = Number(b.longitude);

          // Off screen, or past the zoomed-out cap? Skip — the selected branch is always kept so
          // its detail panel and route never blank out when it scrolls to the edge.
          if (b.id !== selectedBranchId && (!inView(lat, lng) || branchesDrawn >= MAX_PER_LAYER)) return;
          branchesDrawn++;

          const isSelected = b.id === selectedBranchId;
          // Bank mode paints ownership; status mode is untouched. Selection always wins.
          const color = isSelected
            ? '#6366f1'
            : colorMode === 'client'
            ? clientColorOf(b.clientId)
            : branchStatusColor(b.status);

          const markerSvg = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}" width="28px" height="28px" style="filter: drop-shadow(0 2px 5px rgba(0,0,0,0.4));">
              <!-- A Classical Bank / Office Icon -->
              <path d="M12 2L2 7v2h20V7L12 2zm-7 8v8h3v-8H5zm5 0v8h4v-8h-4zm7 0v8h3v-8h-3zM2 20v2h20v-2H2z"/>
            </svg>
          `;

          desiredMarkers.set(`branch-${b.id}`, {
            lat,
            lng,
            iconHtml: markerSvg,
            iconClassName: 'custom-leaflet-marker',
            iconSize: [28, 28],
            iconAnchor: [14, 28],
            popupHtml: null,
            // `markerSvg` above is the only thing selection changes, so selecting a branch is now
            // two `setIcon` calls — the pin losing the highlight and the pin gaining it — instead
            // of a full rebuild of the layer.
            onClick: () => onSelectBranchRef.current(b.id),
          });
          bounds.push([lat, lng]);

          // GIP Phase 4 Analytics Layer: Targeted SLA Risk Overlay
          // Target selected branch or high risk score branches (riskScore >= 7 or overdue) to prevent map clutter
          const isSelectedForSla = selectedBranchId ? b.id === selectedBranchId : false;
          const isHighRiskSla = (b.riskScore && Number(b.riskScore) >= 7) || (b.status === 'PLANNING' && (!selectedBranchId || isSelectedForSla));

          if (effectiveSlaEnabled && (isSelectedForSla || (isHighRiskSla && !selectedBranchId))) {
            const slaColor = slaEnabledProp ? '#f97316' : '#ef4444';
            const slaLabel = slaEnabledProp
              ? `🛡️ Minimum distance met: more than ${effectiveSlaRadius} km away\nCurrent branch: ${b.name}`
              : `⚠️ Too close to branch — inside the ${effectiveSlaRadius} km minimum distance: ${b.name}`;
            const riskCircle = L.circle([lat, lng], {
              radius: effectiveSlaRadius * 1000,
              color: slaColor,
              fillColor: slaColor,
              fillOpacity: slaEnabledProp ? 0.03 : 0.12,
              weight: slaEnabledProp ? 3 : 2,
              dashArray: slaEnabledProp ? '10, 8' : '6, 6'
            }).addTo(map);
            riskCircle.bindTooltip(slaLabel, { permanent: false, direction: 'top' });
            circlesRef.current.push(riskCircle);

            if (slaEnabledProp) {
              const innerCircle = L.circle([lat, lng], {
                radius: effectiveSlaRadius * 1000,
                color: '#ef4444',
                fillColor: '#ef4444',
                fillOpacity: 0.06,
                weight: 1,
                dashArray: '3, 6'
              }).addTo(map);
              innerCircle.bindTooltip(`🚫 Restricted Zone (within ${effectiveSlaRadius}km)`, { permanent: false, direction: 'bottom' });
              circlesRef.current.push(innerCircle);
            }
          }

          // GIP Phase 4 Analytics Layer: Revenue Density Heat
          if (showRevenueDensity && (b.status === 'CLOSED' || b.status === 'AUDIT_COMPLETED')) {
            const revenueCircle = L.circle([lat, lng], {
              radius: 35000,
              color: '#f59e0b',
              fillColor: '#f59e0b',
              fillOpacity: 0.2,
              weight: 1
            }).addTo(map);
            circlesRef.current.push(revenueCircle);
          }
        }
      });
    }

    // Branch Proximity Search Radius Circle and Assayer Markers
    // 1. Draw search radius circle if branch is selected
    if (selectedBranchLatLng) {
      const searchCircle = L.circle(selectedBranchLatLng, {
        radius: radiusKm * 1000,
        color: '#8b5cf6',
        fillColor: '#8b5cf6',
        fillOpacity: 0.05,
        weight: 1,
        dashArray: '4, 6'
      }).addTo(map);
      circlesRef.current.push(searchCircle);
    }

    // 2. Render Assayers
    if (showAssayers) {
      // Rank/exclusion lookups so each pin can show where the engine placed that assayer.
      const rankById = new Map<string, { rank: number; score?: number }>();
      (rankedCandidates || []).forEach((c, i) => rankById.set(c.id, { rank: i + 1, score: c.score }));
      const blockedById = new Map<string, { reason: string; detail?: string }>();
      (excludedCandidates || []).forEach((e) => blockedById.set(e.assayerId, { reason: e.reason, detail: e.detail }));

      let assayersDrawn = 0;
      filteredAssayers.forEach((assayer) => {
      if (assayer.latitude !== null && assayer.longitude !== null) {
        const aLat = Number(assayer.latitude);
        const aLng = Number(assayer.longitude);

        let shouldRender = false;
        let straightDist = 0;

        if (selectedBranchLatLng) {
          straightDist = calculateHaversineDistance(selectedBranchLatLng[0], selectedBranchLatLng[1], aLat, aLng);
          if (straightDist <= radiusKm) {
            shouldRender = true;
          }
        } else {
          // National coverage: everyone — but only the ones actually on screen, so a 1,000-person
          // roster does not build 1,000 pins for a view showing one city's worth of them.
          shouldRender = true;
        }

        // Cull to the current view and cap the zoomed-out flood. An engine-ranked candidate is
        // always kept: a recommendation must never vanish because it sits off the map edge.
        if (shouldRender && !rankById.has(assayer.id)
          && (!inView(aLat, aLng) || assayersDrawn >= MAX_PER_LAYER)) {
          shouldRender = false;
        }
        if (shouldRender) assayersDrawn++;

        if (shouldRender) {
          // Uses the same *effective* radius/enabled the "Restricted Zone" circle above is
          // drawn with (effectiveSlaEnabled/effectiveSlaRadius), not the raw slaEnabledProp/
          // slaRadiusProp. Those two used to diverge: the map has its own independent "Show
          // SLA Risk" layer toggle (showSlaRisk/slaRadiusKm) that draws the restricted-zone
          // circle on its own, separate from the Planning page's min-radius filter — so an
          // assayer standing inside a visibly-drawn red restricted zone could still be
          // coloured green/gold as "recommended", directly contradicting the circle drawn
          // around them.
          const slaCompliant = effectiveSlaEnabled && selectedBranchLatLng
            ? straightDist >= effectiveSlaRadius
            : null;
          const ranking = rankById.get(assayer.id);
          const blocked = blockedById.get(assayer.id);
          // An assayer inside the restricted radius must never read as recommended, even if
          // they're still present in rankedCandidates (e.g. the Planning page's own min-radius
          // filter is off but the map's local "Show SLA Risk" toggle is on) — so this is
          // checked ahead of ranking, not folded into the same priority level as it.
          const inBreach = slaCompliant === false;

          // Ranking wins over raw distance: what matters operationally is who the engine
          // recommends, not merely who is nearest. Blocked assayers are greyed so they read as
          // "cannot be assigned" at a glance instead of looking like an ordinary option.
          // In bank mode the pin takes its best empanelment's colour (ACTIVE beats
          // RECOMMENDED beats the rest; no bank = grey) — but a blocked or in-breach verdict
          // still overrides it: compliance reads louder than ownership. Status mode keeps the
          // engine-verdict chain untouched. When a bank filter is on, the colour comes from
          // the FILTERED bank's standing: "show me RBL's people" paints them RBL even when
          // they also hold three other banks.
          const lifecycleKey = lifecycleBucketOf(assayer.lifecycleStatus).key;

          // Is this person ICICI? — i.e. do they hold a qualifying (Active/Recommended) standing
          // with the spotlit bank, whatever OTHER banks they also work for. `bestEmpanelment`
          // returns the first qualifying bank, so an ICICI appraiser who also works AXIS would
          // otherwise be painted AXIS and lost from the spotlight; 29 of the 34 ICICI-capable
          // hold a second bank, which is why nearly all of them were slipping through.
          const isSpotlit = spotlightClientId != null
            && (assayer.empanelments ?? []).some(
              (e: MapEmpanelment) => e.clientId === spotlightClientId && isQualifyingStanding(e.status),
            );

          /**
           * TWO independent facts, TWO independent channels. "Which bank" and "what lifecycle
           * state" are orthogonal — a person can be ICICI + active, ICICI + terminated, no-bank
           * + active, no-bank + terminated — so encoding both in one fill colour was doomed:
           * a terminated ICICI appraiser looked identical to a working one, and an available
           * unbanked appraiser looked identical to a resigned one.
           *
           *   FILL  = the bank (its colour when the person holds an Active/Recommended
           *           standing; a neutral light disc when they hold none).
           *   RING  = the lifecycle (white active · sky onboarding · amber paused ·
           *           red out-of-workforce).
           *
           * So a red-ringed ICICI-blue disc now reads exactly as what it is: "empanelled with
           * ICICI on paper, but this person has left" — a data mismatch ops should see and fix,
           * not one the map should hide. In status/planning mode the engine verdict still owns
           * the fill; the lifecycle ring rides along on top of it.
           */
          /**
           * Bank (client) mode is deliberately FLAT: one bank — ICICI — is spotlit, and every
           * other pin is identical, whatever bank they hold, whatever their lifecycle. No grey
           * for no-bank, no lifecycle ring, no dimming: the only question this view answers is
           * "ICICI, or not". Status/planning mode keeps the two-channel scheme below (engine
           * verdict in the fill, lifecycle in the ring), which is a different question.
           */
          const clientMode = colorMode === 'client';
          const markerColor = blocked
            ? '#64748b'
            : inBreach
            ? '#ef4444'
            : clientMode
            ? (isSpotlit ? SPOTLIGHT_COLOR : OTHER_BANK_COLOR)
            : ranking?.rank === 1
            ? '#f59e0b'
            : ranking
            ? '#10b981'
            : slaCompliant === null
            ? '#a855f7'
            : '#10b981';

          // Every fill is saturated now (the light no-bank disc is gone), so the glyph is white.
          const glyphFill = '#ffffff';

          // RING = lifecycle — but ONLY in status/planning mode. In the flat bank view every pin
          // wears the same hairline ring, so paused/exited/onboarding no longer read apart.
          const ringColor = clientMode
            ? 'rgba(255,255,255,0.9)'
            : (blocked || inBreach)
            ? 'rgba(255,255,255,0.85)'
            : (LIFECYCLE_RING_COLORS[lifecycleKey] ?? 'rgba(255,255,255,0.9)');
          const ringWidth = !clientMode && (lifecycleKey === 'exited' || lifecycleKey === 'paused') ? 2.6 : 1.5;
          // No dimming in the flat bank view — every assayer is drawn at full presence.
          const dimExited = false;

          const assayerSvg = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18px" height="18px" style="filter: drop-shadow(0 1px 3px rgba(0,0,0,0.5));">
              <circle cx="12" cy="12" r="${11 - (ringWidth - 1.5) / 2}" fill="${markerColor}" stroke="${ringColor}" stroke-width="${ringWidth}"/>
              <path fill="${glyphFill}" d="M12 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V18h14v-1.5c0-2.33-4.67-3.5-7-3.5z"/>
            </svg>
          `;

          // A small rank badge on the top three, so the best options are findable on the map
          // without reading the list. Suppressed when in breach — a "#1 recommended" badge on
          // a marker that's simultaneously coloured red as a restricted-zone breach is a direct
          // visual contradiction.
          const rankBadge = ranking && ranking.rank <= 3 && !inBreach
            ? `<div style="position:absolute;top:-5px;right:-5px;background:${markerColor};color:#fff;font-size:8px;font-weight:800;width:12px;height:12px;line-height:12px;border-radius:50%;text-align:center;border:1px solid rgba(255,255,255,0.9);">${ranking.rank}</div>`
            : '';
          const blockedMark = blocked
            ? `<div style="position:absolute;top:-4px;right:-4px;color:#f87171;font-size:10px;font-weight:800;">✕</div>`
            : '';

          const assayerIconHtml = `<div style="position:relative;width:18px;height:18px;opacity:${blocked ? 0.55 : dimExited ? 0.72 : 1};">${assayerSvg}${rankBadge}${blockedMark}</div>`;

          // What every assayer popup now says regardless of branch selection: who they are in
          // the lifecycle, whether they are already committed today, and which banks they hold
          // a standing with — the control-center facts, on the pin itself.
          const bucket = lifecycleBucketOf(assayer.lifecycleStatus);
          const tint = LIFECYCLE_BUCKET_TINT[bucket.key] ?? { bg: '#e2e8f0', fg: '#334155' };
          const lifecycleChip = `<span style="display:inline-block;padding:1px 6px;border-radius:8px;background:${tint.bg};color:${tint.fg};font-size:10px;font-weight:700;">${assayer.lifecycleStatus ?? '—'}</span>`;
          const availabilityLine = assayer.assignedToday
            ? `<div style="margin-top:3px;color:#b45309;font-weight:600;">📌 Assigned today${assayer.openAssignments > 1 ? ` · ${assayer.openAssignments} open` : ''}</div>`
            : `<div style="margin-top:3px;color:#047857;font-weight:600;">✅ Free today${assayer.openAssignments > 0 ? ` · ${assayer.openAssignments} open elsewhere` : ''}</div>`;
          const approxLine = assayer.approxLocation
            ? `<div style="margin-top:3px;font-size:10px;color:#92400e;">📍 Approximate area — the exact address is still being located</div>`
            : '';
          const emps: MapEmpanelment[] = assayer.empanelments ?? [];
          const bankRows = emps.slice(0, 4).map((e) =>
            `<div style="display:flex;align-items:center;gap:5px;font-size:11px;">`
            + `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${clientColorOf(e.clientId)};"></span>`
            + `<span>${e.clientName}</span><span style="color:#666;">— ${e.status}</span></div>`,
          ).join('');
          const banksBlock = emps.length
            ? `<div style="margin-top:4px;border-top:1px solid #e2e8f0;padding-top:3px;">${bankRows}`
              + (emps.length > 4 ? `<div style="font-size:10px;color:#666;">+${emps.length - 4} more</div>` : '')
              + `</div>`
            : `<div style="margin-top:4px;font-size:10px;color:#94a3b8;">No bank empanelments</div>`;

          // Filled in by whichever of the two branches below applies, then handed to the
          // reconciler together with the icon. Assayer pins away from a selected branch carry a
          // popup but no click behaviour — there is nothing to route to.
          let assayerPopupHtml: string;
          let assayerOnClick: (() => void) | null = null;

          if (selectedBranchLatLng) {
            // Copied to a const so the routing handler below closes over a target that cannot be
            // reassigned out from under it while the pin waits for a click.
            const routeTarget = selectedBranchLatLng;
            const routeBranchName = selectedBranch?.name || 'Target Branch';
            const slaStatus = slaCompliant === null ? '' : slaCompliant
              ? `<div style="color:#10b981;font-weight:600;margin-top:2px;">✅ More than ${effectiveSlaRadius} km away — minimum distance met</div>`
              : `<div style="color:#ef4444;font-weight:600;margin-top:2px;">❌ Too close to branch — within ${effectiveSlaRadius} km</div>`;
            // Surface the engine's verdict on the pin itself — rank and score when eligible,
            // the blocking reason when not. A breach always wins over a stale ranking: an
            // assayer can be in `rankedCandidates` (unfiltered by radius, e.g. when only the
            // map's own SLA-risk layer is on) while still standing inside the restricted zone.
            const verdict = blocked
              ? `<div style="margin-top:3px;color:#b45309;font-weight:600;">🚫 Not assignable — ${blocked.reason}</div>` +
                (blocked.detail ? `<div style="font-size:10px;color:#92400e;">└─ ${blocked.detail}</div>` : '')
              : inBreach
              ? `<div style="margin-top:3px;color:#b45309;font-weight:600;">🚫 Not assignable — within the ${effectiveSlaRadius}km restricted zone</div>`
              : ranking
              ? `<div style="margin-top:3px;color:#047857;font-weight:600;">#${ranking.rank} recommended · score ${ranking.score ?? '—'}</div>`
              : '';
            assayerPopupHtml = `
              <div style="color:#000;font-family:sans-serif;font-size:12px;min-width:180px;">
                <b style="color:${markerColor};display:block;margin-bottom:2px;">${assayer.displayName} ${lifecycleChip}</b>
                <div>Code: <b>${assayer.assayerCode}</b></div>
                <div>Distance: <b>~${straightDist.toFixed(1)} km</b> <span style="color:#666;">straight line</span></div>
                ${verdict}
                ${slaStatus}
                ${availabilityLine}
                ${approxLine}
                ${banksBlock}
                ${blocked || inBreach ? '' : '<div style="margin-top:4px;font-size:10px;color:#666;">Click to show route</div>'}
              </div>
            `;
            assayerOnClick = () => {
              setSelectedAssayerForRouting({
                ...assayer,
                straightDistance: straightDist,
                aLat,
                aLng,
                bLat: routeTarget[0],
                bLng: routeTarget[1],
                branchName: routeBranchName
              });
            };
          } else {
            assayerPopupHtml = `
              <div style="color:#000; font-family:sans-serif; font-size:12px; min-width: 170px;">
                <b style="color:${markerColor}; display:block; margin-bottom: 4px;">${assayer.displayName} ${lifecycleChip}</b>
                <div>Code: <b>${assayer.assayerCode}</b></div>
                ${availabilityLine}
                ${approxLine}
                ${banksBlock}
              </div>
            `;
          }

          desiredMarkers.set(`assayer-${assayer.id}`, {
            lat: aLat,
            lng: aLng,
            iconHtml: assayerIconHtml,
            iconClassName: 'custom-assayer-marker',
            iconSize: [18, 18],
            // Centre anchor: a disc marks its point at its middle, unlike the branch pin's tip.
            iconAnchor: [9, 9],
            popupHtml: assayerPopupHtml,
            onClick: assayerOnClick,
          });
        }
      }
    });
    }

    // Both layers have now described what they want, so settle up in one pass. Branch and
    // assayer pins are reconciled together rather than layer by layer, because that is what lets
    // switching a layer off be "these keys are gone" instead of a special case.
    //
    // Insertion order is not load-bearing: Leaflet stacks markers by latitude (`zIndexOffset`
    // aside), not by the order they were added, so pins that survive a pass keep the same
    // stacking they would have had after a rebuild.
    reconcileMarkers(map, markersRef.current, desiredMarkers);

    // 3. Render Audit Density Heat Overlay
    if (showWorkforceDensity && filteredBranches.length > 0) {
      const cityCounts: Record<string, { lat: number; lng: number; count: number }> = {};
      filteredBranches.forEach((b) => {
        if (b.latitude !== null && b.longitude !== null && b.city) {
          const lat = Number(b.latitude);
          const lng = Number(b.longitude);
          if (!cityCounts[b.city]) {
            cityCounts[b.city] = { lat, lng, count: 0 };
          }
          cityCounts[b.city].count += 1;
        }
      });

      Object.entries(cityCounts).forEach(([city, data]) => {
        const isHigh = data.count >= 2;
        const color = isHigh ? '#ef4444' : '#10b981';
        const densityCircle = L.circle([data.lat, data.lng], {
          radius: Math.min(120000, data.count * 25000),
          color: color,
          fillColor: color,
          fillOpacity: 0.12,
          weight: 1.5,
          dashArray: isHigh ? 'none' : '4, 6'
        }).addTo(map);

        densityCircle.bindPopup(`
          <div style="color:#000; font-size:11px; font-family:sans-serif; min-width: 120px;">
            <b style="display:block; margin-bottom: 4px;">${city} Audit Density</b>
            <div>Audit sites: <b>${data.count}</b></div>
            <div style="margin-top: 4px; font-weight:600; color:${color}">${isHigh ? '🔥 High Volume' : 'Standard Volume'}</div>
          </div>
        `);
        circlesRef.current.push(densityCircle);
      });
    }

    // Active Assayer Route Line Overlay (Draw actual OSRM road geometry)
    if (selectedAssayerForRouting && roadGeometry.length > 0) {
      const modeColors = {
        driving: '#3b82f6',
        'two-wheeler': '#a855f7',
        transit: '#f97316',
        walking: '#10b981'
      };

      activeRoutePolylineRef.current = L.polyline(
        roadGeometry,
        {
          color: modeColors[travelMode],
          weight: 6,
          opacity: 0.9,
          dashArray: travelMode === 'walking' ? '3, 6' : '0'
        }
      ).addTo(map);

      // Fit map to show the entire road route
      map.fitBounds(activeRoutePolylineRef.current.getBounds(), { padding: [40, 40] });
    }

    // Layer 2: Routes
    if (showRoutes && routePoints && routePoints.length > 1) {
      const latLngs = routePoints.map((p) => [p.latitude, p.longitude] as L.LatLngTuple);
      polylineRef.current = L.polyline(latLngs, {
        color: '#6366f1',
        weight: 4,
        opacity: 0.8,
        dashArray: '5, 10',
      }).addTo(map);

      if (bounds.length === 0) {
        latLngs.forEach((coord) => bounds.push(coord));
      }
    }

    // Auto-frame the view — but only when the *reason* to frame has changed, never on a redraw the
    // user's own pan or zoom triggered. Framing on every draw fought the person moving the map and,
    // now that a viewport change re-runs this effect, looped (fitBounds -> moveend -> renderBounds ->
    // draw -> fitBounds ...). The frame key captures every input the framing below reads.
    const frameKey = [
      selectedBranchId ?? '',
      selectedAssayerForRouting ? 'routing' : '',
      routePoints?.length ?? 0,
      radiusKm,
      effectiveSlaEnabled ? effectiveSlaRadius : '',
    ].join('|');
    if (bounds.length > 0 && !selectedAssayerForRouting && frameKey !== lastFrameKeyRef.current) {
      lastFrameKeyRef.current = frameKey;
      if (selectedBranchId && selectedBranchLatLng) {
        const zoomRadius = effectiveSlaEnabled ? effectiveSlaRadius : radiusKm;
        const radiusMeters = zoomRadius * 1000;
        const circleBounds = L.latLng(selectedBranchLatLng).toBounds(radiusMeters);
        map.fitBounds(circleBounds, { padding: [40, 40] });
      } else {
        map.fitBounds(bounds, { padding: [30, 30] });
      }
    }
    // `mapStyle`/`appTheme` are deliberately absent: the basemap moved to its own effect above,
    // and a theme change is no longer a reason to walk every pin on the map.
  }, [ensureMap, branches, selectedBranchId, routePoints, showBranches, showAssayers, showRoutes, showSlaRisk, slaRadiusKm, showWorkforceDensity, showRevenueDensity, realAssayers, filteredBranches, filteredAssayers, radiusKm, selectedAssayerForRouting, roadGeometry, travelMode, searchQuery, cityFilter, branchStatusFilter, slaEnabledProp, slaRadiusProp, rankedCandidates, excludedCandidates, colorMode, clientColorOf, assayerClientFilter, spotlightClientId, renderBounds]);

  // Travel math calculations based on mode-aware estimates
  const modeSpeeds: Record<string, number> = { driving: 40, 'two-wheeler': 30, walking: 5 };
  const speed = modeSpeeds[travelMode] || 40;
  const straightDist = selectedAssayerForRouting?.straightDistance || 0;

  // Use OSRM road data for driving, PostGIS mode-aware estimate for walking/cycling
  const actualDistance = roadDistanceKm !== null ? roadDistanceKm : straightDist;
  const durationVal = roadDurationMinutes !== null 
    ? Math.round(roadDurationMinutes) 
    : Math.round((straightDist / speed) * 60);

  /**
   * Travel allowance, calculated the way FeePolicyService calculates it: the free commute
   * allowance is deducted first, then the contracted per-km rate applies. This used to be
   * `distance x 8` flat, which both ignored the allowance and hardcoded a rate that no longer
   * matched the client's contract, so the operator was shown a number nothing would ever pay.
   *
   * Only driving is a billable allowance. The two-wheeler and walking figures are fuel
   * estimates for comparing how the assayer might travel, and are labelled as such.
   */
  // No literal fallback. A hardcoded ₹8 here was a third answer to "what does travel cost",
  // beside the client rate card and the platform default — and it silently disagreed with both
  // the moment either was changed. When the server has not answered, say so instead of guessing.
  const perKmRate = travelRates?.travelFeePerKm ?? null;
  const freeAllowanceKm = travelRates?.freeTravelAllowanceKm ?? 0;
  const chargeableKm = Math.max(0, actualDistance - freeAllowanceKm);
  // null when the server has not answered — rendered as "rate unavailable" rather than a
  // number nothing would actually charge.
  const estCost: number | null = travelMode === 'walking'
    ? 0
    : travelMode === 'two-wheeler'
      ? Math.round(actualDistance * 3)
      : perKmRate == null ? null : Math.round(chargeableKm * perKmRate);

  return (
    <div className="glass-card" style={{
      padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', boxSizing: 'border-box',
      // Fullscreen lifts the whole card to the modal layer (1100 — above the sidebar's 1000);
      // windowed keeps the exact flex behaviour every existing layout depends on.
      ...(isFullscreen
        ? { position: 'fixed' as const, inset: 0, zIndex: 1100, borderRadius: 0, minHeight: 0 }
        : { position: 'relative' as const, flex: fillContainer ? '1' : undefined, minHeight: fillContainer ? 0 : '380px' }),
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <h4 style={{ fontSize: '15px', fontWeight: 600 }}>Geographic Workspace Map</h4>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button type="button" onClick={() => setIsFullscreen(f => !f)}
            aria-label={isFullscreen ? 'Exit the bigger view' : 'Open the bigger view'}
            title={isFullscreen ? 'Exit the bigger view (Esc)' : 'Bigger view'}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', padding: '6px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', fontSize: '12px', font: 'inherit' }}>
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            <span>{isFullscreen ? 'Exit' : 'Bigger view'}</span>
          </button>
          <MapLayerControls
            showBranches={showBranches} setShowBranches={setShowBranches}
            showAssayers={showAssayers} setShowAssayers={setShowAssayers}
            showRoutes={showRoutes} setShowRoutes={setShowRoutes}
            showSlaRisk={showSlaRisk} setShowSlaRisk={setShowSlaRisk}
            slaRadiusKm={slaRadiusKm} setSlaRadiusKm={setSlaRadiusKm}
            showWorkforceDensity={showWorkforceDensity} setShowWorkforceDensity={setShowWorkforceDensity}
            showRevenueDensity={showRevenueDensity} setShowRevenueDensity={setShowRevenueDensity}
            mapStyle={mapStyle} setMapStyle={setMapStyle}
            radiusKm={radiusKm} setRadiusKm={setRadiusKm}
            searchQuery={searchQuery} setSearchQuery={setSearchQuery}
            cityFilter={cityFilter} setCityFilter={setCityFilter}
            branchStatusFilter={branchStatusFilter} setBranchStatusFilter={setBranchStatusFilter}
            colorMode={colorMode} setColorMode={setColorMode}
            assayerClientFilter={assayerClientFilter} setAssayerClientFilter={setAssayerClientFilter}
            assayerLifecycleFilter={assayerLifecycleFilter} setAssayerLifecycleFilter={setAssayerLifecycleFilter}
            assayerAvailability={assayerAvailability} setAssayerAvailability={setAssayerAvailability}
            clientOptions={clientOptions}
            counts={assayerCounts}
            visibleAssayerCount={filteredAssayers.length}
            showAssayerLayer={showAssayers}
            inline
          />
        </div>
      </div>
      
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <div 
          ref={mapContainerRef} 
          style={{ 
            height: '100%',
            width: '100%', 
            borderRadius: 'var(--radius-md)', 
            border: '1px solid var(--border-color)',
            background: 'var(--bg-primary)',
            zIndex: 1
          }} 
        />

        {/* Collapsible Map Legend */}
        {showLegend ? (
          <div style={{
            position: 'absolute',
            bottom: '20px',
            left: '20px',
            zIndex: 1000,
            background: 'var(--bg-surface-2)',
            backdropFilter: 'blur(8px)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 14px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            fontSize: '11px',
            color: 'var(--text-primary)',
            minWidth: '160px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px', borderBottom: '1px solid var(--border-hair)', paddingBottom: '4px' }}>
              <span style={{ fontWeight: 600, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--accent-primary)' }}>Map Legend</span>
              <button type="button" aria-label="Close legend" onClick={() => setShowLegend(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px', padding: '0 2px', lineHeight: 1 }}>&times;</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#6366f1' }} />
              <span>Selected Target</span>
            </div>
            {colorMode === 'client' ? (
              <>
                {/* The flat bank view: ICICI apart, everyone else identical. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: SPOTLIGHT_COLOR }} />
                  <span>{clientOptions.find((c) => /icici/i.test(c.name))?.name ?? 'ICICI'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: OTHER_BANK_COLOR }} />
                  <span>Every other assayer</span>
                </div>
              </>
            ) : (
              <>
                {/* Branch pin colours, generated from the same buckets that draw them. */}
                {BRANCH_STATUS_LEGEND.map((entry) => (
                  <div key={entry.bucket} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: entry.hex }} />
                    <span>{entry.label}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#a855f7' }} />
                  <span>Assayer (Auditor)</span>
                </div>
              </>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', border: '1px dashed #ef4444', background: 'rgba(239,68,68,0.1)' }} />
              <span>🔥 High Audit Demand</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', border: '1px dashed #10b981', background: 'rgba(16,185,129,0.1)' }} />
              <span>Standard Audit Demand</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', border: '1px dashed #8b5cf6', background: 'rgba(139,92,246,0.1)' }} />
              <span>Search Radius ({radiusKm}km)</span>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setShowLegend(true)} style={{
            position: 'absolute',
            bottom: '20px',
            left: '20px',
            zIndex: 1000,
            background: 'var(--bg-surface-2)',
            backdropFilter: 'blur(8px)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 10px',
            color: 'var(--text-primary)',
            fontSize: '11px',
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            transition: 'all 0.2s',
            outline: 'none'
          }}>
            🗺️ Show Legend
          </button>
        )}

      {/* Floating Route Intelligence Panel */}
      {selectedAssayerForRouting && (
        <div style={{
          position: 'absolute',
          top: '55px',
          left: '25px',
          width: '260px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md)',
          padding: '12px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          gap: '10px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <b style={{ color: 'var(--accent)', fontSize: '13px' }}>{selectedAssayerForRouting.displayName ?? [selectedAssayerForRouting.firstName, selectedAssayerForRouting.lastName].filter(Boolean).join(' ')}</b>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Route to {selectedAssayerForRouting.branchName}</div>
            </div>
            <button type="button" aria-label="Close routing panel" onClick={() => setSelectedAssayerForRouting(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px' }}>&times;</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px', background: 'var(--bg-primary)', padding: '2px', borderRadius: 'var(--radius-sm)' }}>
            {(['driving', 'two-wheeler', 'walking'] as const).map(mode => {
              const label = mode === 'driving' ? 'Car' : mode === 'two-wheeler' ? 'Bike' : 'Walk';
              return (
                <button
                  key={mode}
                  onClick={() => setTravelMode(mode)}
                  aria-pressed={travelMode === mode}
                  aria-label={`Travel by ${label.toLowerCase()}`}
                  style={{
                    padding: '4px 2px',
                    background: travelMode === mode ? 'var(--status-pending-bg)' : 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    color: travelMode === mode ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontSize: '10px',
                    fontWeight: travelMode === mode ? 700 : 500,
                    cursor: 'pointer',
                    textAlign: 'center',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px',
                  }}
                >
                  <span aria-hidden="true" style={{ fontSize: '12px' }}>{mode === 'driving' ? '🚗' : mode === 'two-wheeler' ? '🏍️' : '🚶'}</span>
                  {label}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{roadDistanceKm !== null ? 'Road Distance:' : 'Straight-line:'}</span>
              <b>{actualDistance.toFixed(1)} km</b>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Est. Travel Time:</span>
              <b>{durationVal} mins</b>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', fontSize: '10px', color: 'var(--text-muted)' }}>
              <span>Mode:</span>
              <span>{travelMode === 'driving' ? '🚗 Car' : travelMode === 'two-wheeler' ? '🏍️ Motorcycle' : '🚶 Walking'}</span>
              <span>| Speed: ~{speed} km/h</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-hair)', paddingTop: '6px', marginTop: '4px' }}>
              <span>{travelMode === 'driving'
                ? (roadDistanceKm !== null ? 'Travel allowance:' : 'Travel allowance (approx):')
                : 'Est. fuel cost:'}</span>
              <b style={{ color: estCost == null ? 'var(--text-muted)' : 'var(--text-primary)', fontSize: '12px' }}>
                {estCost == null ? 'rate unavailable' : `₹${estCost}`}
              </b>
            </div>
            <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {roadDistanceKm !== null ? 'Road distance from OSRM' : 'Estimate based on straight-line distance'} — traffic not included
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
});
