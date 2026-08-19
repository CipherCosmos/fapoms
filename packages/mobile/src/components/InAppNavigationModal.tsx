import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, Modal as RNModal, Platform, ActivityIndicator, ScrollView } from 'react-native';
import * as Location from 'expo-location';
import Constants from 'expo-constants';
import { useTheme } from '../theme/ThemeProvider';
import { useLocation } from '../context/LocationContext';
import { AppText, Badge, Button, Icon, IconButton, Tappable } from './ui/primitives';
import { AssayerAssignment } from '../types/mobile-app';
import { InteractiveMap } from './MapEntry';
import { calculateHaversineDistance } from '@fapoms/shared';

interface InAppNavigationModalProps {
  visible: boolean;
  assignment: AssayerAssignment | null;
  onClose: () => void;
}

interface LatLng {
  latitude: number;
  longitude: number;
}

type RouteMode = 'driving' | 'transit';

interface NavStep {
  instruction: string;
  distanceM: number;
  durationS: number;
  maneuver?: string;
  coords?: LatLng[]; // the step's own polyline (for live step progression)
}

interface FareInfo {
  text: string;
  currency: string;
  value: number;
}

// Geodesic "straight-line" distance (Haversine) in km. Used as a graceful,
// zero-key fallback when routing is unavailable.
function haversineKm(a: LatLng, b: LatLng): number {
  return calculateHaversineDistance(a.latitude, a.longitude, b.latitude, b.longitude);
}

function formatDuration(seconds: number): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
}

const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';

/**
 * Both routing providers are reached with a bare `fetch`, which has no timeout of its own — a
 * request to a host that accepted the connection and then went silent never settles.
 *
 * That is the ordinary field failure, not an exotic one: a handset holding a bar of signal on a
 * congested rural tower, or sitting behind a bank's captive portal. The whole route build is
 * awaited between `setLoading(true)` and the `applyResult`/estimate that clears it, so a hung
 * socket leaves the sheet spinning forever AND keeps `canNavigate` false — the assayer can
 * neither see how far the branch is nor start navigation, with nothing on screen saying why.
 * Aborting hands control back to the straight-line estimate below, which needs no network.
 */
const ROUTE_FETCH_TIMEOUT_MS = 12000;

async function fetchWithTimeout(url: string, timeoutMs = ROUTE_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Route cache: keyed by "provider|mode|originLng,originLat|destLng,destLat". Prevents
// redundant network calls when the same origin→destination is re-requested
// (e.g. modal re-open, StrictMode double-invoke, or re-render).
interface CachedRoute {
  coords: LatLng[];
  distanceKm: number;
  travelSeconds: number;
  fallback: boolean;
  steps: NavStep[];
  fare: FareInfo | null;
  mode: RouteMode;
}
const routeCache = new Map<string, CachedRoute>();

function routeCacheKey(provider: 'google' | 'osrm' | 'estimate', mode: RouteMode, from: LatLng, to: LatLng): string {
  const round = (n: number) => Math.round(n * 1e5);
  return `${provider}|${mode}|${round(from.longitude)},${round(from.latitude)}|${round(to.longitude)},${round(to.latitude)}`;
}

// Decode an encoded polyline (Google Directions & OSRM both use this format).
function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dLng;

    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}

// OSRM geometry precision factor (5 by default → 1e5 divisor).
function decodeOsrmPolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dLng;

    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}

// Strip HTML tags from Google Directions instruction text.
function stripHtml(html: string): string {
  return (html || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").trim();
}

// Minimum distance (km) from a point to a polyline — used for off-route detection.
function distanceToPolylineKm(p: LatLng, coords: LatLng[]): number {
  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const abx = b.longitude - a.longitude;
    const aby = b.latitude - a.latitude;
    const apx = p.longitude - a.longitude;
    const apy = p.latitude - a.latitude;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? (apx * abx + apy * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.longitude + t * abx;
    const py = a.latitude + t * aby;
    min = Math.min(min, haversineKm(p, { latitude: py, longitude: px }));
  }
  return min === Infinity ? 0 : min;
}

export const InAppNavigationModal: React.FC<InAppNavigationModalProps> = ({
  visible,
  assignment,
  onClose,
}) => {
  const t = useTheme();
  const { attachPositionSource, reportPosition } = useLocation();
  const [origin, setOrigin] = useState<LatLng | null>(null);
  const [routeCoords, setRouteCoords] = useState<LatLng[]>([]);
  const [distanceKm, setDistanceKm] = useState<number | null>(null);
  const [travelSeconds, setTravelSeconds] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const [mode, setMode] = useState<RouteMode>('driving');
  const [steps, setSteps] = useState<NavStep[]>([]);
  const [fare, setFare] = useState<FareInfo | null>(null);
  const [navigating, setNavigating] = useState(false);
  const routeRequestIdRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- Live turn-by-turn navigation state ----
  const [heading, setHeading] = useState<number | null>(null);
  const [speed, setSpeed] = useState<number | null>(null); // m/s
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [remainingKm, setRemainingKm] = useState<number | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [passedIndex, setPassedIndex] = useState(0);
  /**
   * Whether the full map has been asked for.
   *
   * Tapping "Navigate" used to throw a full-screen map over everything, which is a heavy answer
   * to what is usually a light question — an assayer checking how far the branch is and how
   * long it will take before deciding when to leave. The sheet answers that in place; the map
   * is one tap further for the times it is actually wanted.
   */
  const [expanded, setExpanded] = useState(false);

  // A reopen should start from the summary again rather than wherever the last visit ended.
  useEffect(() => {
    if (!visible) setExpanded(false);
  }, [visible]);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const stepEndsRef = useRef<LatLng[]>([]);
  const progressIdxRef = useRef(0);
  const maxVertexRef = useRef(0);
  // Live snapshot of everything the position watcher needs (avoids re-subscribing).
  const navCtxRef = useRef<{
    steps: NavStep[]; routeCoords: LatLng[]; distanceKm: number | null;
    travelSeconds: number | null; mode: RouteMode; buildRoute: (from: LatLng, m?: RouteMode) => Promise<void>;
  }>({ steps: [], routeCoords: [], distanceKm: null, travelSeconds: null, mode: 'driving', buildRoute: () => Promise.resolve() });

  // Rebuild step-end anchors whenever the route steps change.
  useEffect(() => {
    stepEndsRef.current = steps
      .map((s) => (s.coords && s.coords.length ? s.coords[s.coords.length - 1] : null))
      .filter((c): c is LatLng => c != null);
    progressIdxRef.current = 0;
    maxVertexRef.current = 0;
    setActiveStepIndex(0);
    setPassedIndex(0);
  }, [steps]);

  const apiKey = Constants.expoConfig?.extra?.googleMapsApiKey as string | undefined;
  const isWeb = Platform.OS === 'web';

  const destination: LatLng | null = useMemo(
    () =>
      assignment
        ? { latitude: assignment.latitude, longitude: assignment.longitude }
        : null,
    [assignment],
  );

  const requestPermission = useCallback(async (): Promise<LatLng | null> => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setError('Location permission denied. Showing destination only.');
      return null;
    }
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
  }, []);

  const buildRoute = useCallback(
    async (from: LatLng, routeMode: RouteMode = mode) => {
      if (!destination) return;

      const provider: 'google' | 'osrm' | 'estimate' =
        apiKey ? 'google' : isWeb ? 'osrm' : 'estimate';
      const key = routeCacheKey(provider, routeMode, from, destination);

      const cached = routeCache.get(key);
      if (cached) {
        setRouteCoords(cached.coords);
        setDistanceKm(cached.distanceKm);
        setTravelSeconds(cached.travelSeconds);
        setUsingFallback(cached.fallback);
        setSteps(cached.steps);
        setFare(cached.fare);
        setError(null);
        setFitKey((k) => k + 1);
        return;
      }

      const requestId = ++routeRequestIdRef.current;
      setLoading(true);
      setError(null);

      const applyResult = (result: CachedRoute) => {
        routeCache.set(key, result);
        if (requestId !== routeRequestIdRef.current) return;
        setRouteCoords(result.coords);
        setDistanceKm(result.distanceKm);
        setTravelSeconds(result.travelSeconds);
        setUsingFallback(result.fallback);
        setSteps(result.steps);
        setFare(result.fare);
        setFitKey((k) => k + 1);
        setLoading(false);
      };

      // Google Directions preferred (native live-traffic ETA; web real route).
      // Requires GOOGLE_MAPS_API_KEY. Falls back to free OSRM (web) / estimate.
      if (apiKey) {
        const params = new URLSearchParams({
          origin: `${from.latitude},${from.longitude}`,
          destination: `${destination.latitude},${destination.longitude}`,
          mode: routeMode,
          units: 'metric',
          key: apiKey,
        });
        if (routeMode === 'driving') {
          params.set('traffic_model', 'best_guess');
          params.set('departure_time', 'now');
        } else {
          params.set('departure_time', 'now');
          params.set('alternatives', 'true');
        }
        try {
          const res = await fetchWithTimeout(`${DIRECTIONS_URL}?${params.toString()}`);
          const data = await res.json();
          if (data.status === 'OK' && data.routes?.length) {
            const route = data.routes[0];
            const leg = route.legs?.[0];
            const points = decodePolyline(route.overview_polyline?.points || '');
            if (points.length >= 2) {
              const parsedSteps: NavStep[] = (leg?.steps || []).map((s: any) => ({
                instruction: stripHtml(s.html_instructions || ''),
                distanceM: s.distance?.value ?? 0,
                durationS: s.duration?.value ?? 0,
                maneuver: s.maneuver,
                coords: decodePolyline(s.polyline?.points || ''),
              }));
              const transitFare = route.fare
                ? { text: route.fare.text || '', currency: route.fare.currency, value: route.fare.value }
                : null;
              applyResult({
                coords: points,
                distanceKm: leg?.distance ? leg.distance.value / 1000 : 0,
                travelSeconds: leg?.duration_in_traffic
                  ? leg.duration_in_traffic.value
                  : leg?.duration
                    ? leg.duration.value
                    : 0,
                fallback: false,
                steps: parsedSteps,
                fare: routeMode === 'transit' ? transitFare : null,
                mode: routeMode,
              });
              return;
            }
          }
          setError(data?.error_message || 'Could not fetch a route.');
        } catch (e: any) {
          setError('Route fetch failed.');
        }
      }

      // ---- Web fallback: free OSRM routing (OpenStreetMap data), no API key ----
      if (isWeb && routeMode === 'driving') {
        try {
          const url =
            `${OSRM_URL}/${from.longitude},${from.latitude};${destination.longitude},${destination.latitude}` +
            `?overview=full&geometries=polyline&steps=false`;
          const res = await fetchWithTimeout(url);
          const data = await res.json();
          if (data.code === 'Ok' && data.routes?.length) {
            const route = data.routes[0];
            const points = decodeOsrmPolyline(route.geometry || '');
            if (points.length >= 2) {
              applyResult({
                coords: points,
                distanceKm: route.distance / 1000,
                travelSeconds: route.duration,
                fallback: false,
                steps: [],
                fare: null,
                mode: routeMode,
              });
              return;
            }
          }
        } catch (e) {
          // fall through to estimate
        }
      }

      // ---- Last resort: straight-line estimate ----
      applyResult({
        coords: [],
        distanceKm: haversineKm(from, destination),
        travelSeconds: (haversineKm(from, destination) / 35) * 3600,
        fallback: true,
        steps: [],
        fare: null,
        mode: routeMode,
      });
    },
    [destination, apiKey, isWeb, mode],
  );

  // Keep the live-nav context snapshot fresh with the latest values.
  useEffect(() => {
    navCtxRef.current = { steps, routeCoords, distanceKm, travelSeconds, mode, buildRoute };
  }, [steps, routeCoords, distanceKm, travelSeconds, mode, buildRoute]);

  // Initial load: permission + first route.
  useEffect(() => {
    if (!visible || !destination) {
      setRouteCoords([]);
      setOrigin(null);
      setDistanceKm(null);
      setTravelSeconds(null);
      setUsingFallback(false);
      setError(null);
      setSteps([]);
      setFare(null);
      setNavigating(false);
      setHeading(null);
      setSpeed(null);
      setActiveStepIndex(0);
      setRemainingKm(null);
      setRemainingSeconds(null);
      setPassedIndex(0);
      return;
    }

    let cancelled = false;
    (async () => {
      let from: LatLng | null = null;
      try {
        from = await requestPermission();
      } catch {
        from = null;
      }
      if (cancelled) return;
      setOrigin(from);
      if (from) {
        await buildRoute(from);
      } else {
        setDistanceKm(null);
        setTravelSeconds(null);
        setUsingFallback(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, assignment, destination, requestPermission, buildRoute]);

  // Re-route when the mode changes.
  useEffect(() => {
    if (visible && origin && destination) {
      buildRoute(origin, mode);
    }
  }, [mode, visible, origin, destination, buildRoute]);

  // ---- Live turn-by-turn position handler: advances the current step, refreshes
  // the live traffic ETA, tracks the travelled route, and re-routes when off course.
  const handleNavPosition = useCallback(
    (
      lat: number,
      lng: number,
      opt?: { heading?: number | null; speed?: number | null; accuracy?: number | null },
    ) => {
      const ctx = navCtxRef.current;
      const c: LatLng = { latitude: lat, longitude: lng };
      setOrigin(c);
      if (opt?.heading != null) setHeading(opt.heading);
      if (opt?.speed != null) setSpeed(opt.speed);

      // Share the stream with the movement trail rather than making it open a second subscription
      // to the same hardware. It applies its own recording policy, so most of these are discarded
      // — this is a drive, and turn-by-turn samples far finer than any travel claim needs.
      reportPosition({
        latitude: lat,
        longitude: lng,
        accuracy: opt?.accuracy ?? null,
        speed: opt?.speed ?? null,
        heading: opt?.heading ?? null,
      });

      const ends = stepEndsRef.current;
      if (ends.length > 0 && ctx.steps.length > 0) {
        // Advance to the first step end the user hasn't yet passed (within 28 m).
        while (progressIdxRef.current < ends.length) {
          if (haversineKm(c, ends[progressIdxRef.current]) * 1000 < 28) progressIdxRef.current += 1;
          else break;
        }
        const active = Math.min(progressIdxRef.current, ends.length - 1);
        setActiveStepIndex(active);

        const toActiveEndM = haversineKm(c, ends[active]) * 1000;
        let remM = toActiveEndM;
        for (let i = active + 1; i < ctx.steps.length; i++) remM += ctx.steps[i].distanceM;
        setRemainingKm(remM / 1000);
        if (ctx.distanceKm && ctx.distanceKm > 0 && ctx.travelSeconds) {
          // Scale the original traffic-aware duration by the remaining fraction.
          setRemainingSeconds(ctx.travelSeconds * (remM / 1000 / ctx.distanceKm));
        }
      }

      if (ctx.routeCoords.length > 1) {
        let nearest = 0;
        let best = Infinity;
        for (let i = 0; i < ctx.routeCoords.length; i++) {
          const d = haversineKm(c, ctx.routeCoords[i]);
          if (d < best) { best = d; nearest = i; }
        }
        if (nearest > maxVertexRef.current) maxVertexRef.current = nearest;
        setPassedIndex(Math.min(maxVertexRef.current, ctx.routeCoords.length - 1));

        // Re-route if the user drifted > 120 m from the route.
        if (distanceToPolylineKm(c, ctx.routeCoords) > 0.12) {
          ctx.buildRoute(c, ctx.mode);
        }
      }
    },
    [reportPosition],
  );

  /**
   * Tell the movement trail to stand its own watcher down while this one is running.
   *
   * Held for the whole navigating window, including the web polling path, so there is never a
   * moment where both this component and the trail are asking the platform for positions.
   */
  useEffect(() => {
    if (!visible || !navigating) return;
    return attachPositionSource();
  }, [visible, navigating, attachPositionSource]);

  // Native: high-frequency location watch powering turn-by-turn navigation.
  useEffect(() => {
    if (watchRef.current) { watchRef.current.remove(); watchRef.current = null; }
    if (!visible || !navigating || isWeb) return;
    let cancelled = false;
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (cancelled || perm.status !== 'granted') return;
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 5, timeInterval: 2500 },
        (loc) => handleNavPosition(loc.coords.latitude, loc.coords.longitude, {
          heading: loc.coords.heading,
          speed: loc.coords.speed,
          accuracy: loc.coords.accuracy,
        }),
      );
      if (!cancelled) watchRef.current = sub;
      else sub.remove();
    })();
    return () => {
      cancelled = true;
      if (watchRef.current) { watchRef.current.remove(); watchRef.current = null; }
    };
  }, [visible, navigating, isWeb, handleNavPosition]);

  // Web fallback: poll location while navigating; if far off the route, re-route.
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!visible || !navigating || !origin || !destination || !isWeb) return;

    pollRef.current = setInterval(async () => {
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        handleNavPosition(loc.coords.latitude, loc.coords.longitude, {
          heading: loc.coords.heading,
          speed: loc.coords.speed,
          accuracy: loc.coords.accuracy,
        });
      } catch {
        // ignore location failures during polling
      }
    }, 12000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [visible, navigating, origin, destination, isWeb, handleNavPosition]);

  const maneuverIcon = (m?: string): any => {
    switch (m) {
      case 'turn-left': return 'arrow-back';
      case 'turn-right': return 'arrow-forward';
      case 'merge': return 'git-merge';
      case 'fork-left': return 'return-down-back';
      case 'fork-right': return 'return-down-forward';
      case 'straight': return 'arrow-up';
      case 'ramp-right': return 'arrow-up-forward';
      case 'ramp-left': return 'arrow-up-back';
      case 'roundabout-left': return 'repeat';
      case 'roundabout-right': return 'repeat';
      case 'uturn-left': return 'arrow-undo';
      case 'uturn-right': return 'arrow-redo';
      case 'depart': return 'flag';
      case 'arrive': return 'flag';
      default: return 'navigate';
    }
  };

  /**
   * Starts guidance inside the app.
   *
   * Kept in-app deliberately: the assignment, the check-in and the query thread all live here,
   * and an assayer who is bounced out to another app to drive has to find their way back to
   * do any of them. The sheet stays the default answer for "how far is it"; this is the step
   * for when they are actually setting off.
   */
  const startNavigation = useCallback(() => {
    setExpanded(true);
    setNavigating(true);
  }, []);

  if (!visible) return null;

  /**
   * The default: a sheet over whatever the assayer was looking at, not a takeover.
   *
   * One action only. The first version of this carried "Start navigation", "Route map" and
   * "Close" side by side — two ways to open the same map, plus a button for something the
   * backdrop and the back gesture already do. The assignment card's own Navigate button is
   * what opened this, so repeating that choice here asked the assayer to decide twice.
   */
  // Navigation can start whenever there is somewhere to go and the route has finished
  // resolving. It used to require `steps.length > 0`, i.e. a turn-by-turn list, which only the
  // Google Directions provider returns — with no GOOGLE_MAPS_API_KEY (the default, see
  // app.config.js) the native path falls back to a straight-line estimate that carries no
  // steps, so the button was permanently disabled and navigation could never begin. The
  // expanded map is useful without steps: it shows the destination, the live position and the
  // distance/ETA; the turn-by-turn banner simply stays hidden until steps exist.
  const canNavigate = Boolean(destination) && !loading;

  const collapseToSheet = () => {
    setNavigating(false);
    setExpanded(false);
  };

  // Hardware back / gesture steps out of the full-screen map back to the summary sheet, and
  // only the sheet dismisses the whole feature. Previously the map's own back control and its
  // onRequestClose both only collapsed `expanded`, and there was no control that called
  // `onClose` from the map at all — so once navigation was started the feature could not be
  // closed from where the user actually was.
  const handleRequestClose = () => {
    if (expanded) collapseToSheet();
    else onClose();
  };

  return (
    <RNModal visible={visible} animationType="slide" transparent onRequestClose={handleRequestClose}>
      {!expanded ? (
        <View style={{ flex: 1, backgroundColor: t.colors.scrim, justifyContent: 'flex-end' }}>
          <Tappable onPress={onClose} style={{ flex: 1 }} accessibilityLabel="Dismiss">
            <View style={{ flex: 1 }} />
          </Tappable>

          <View style={{
            backgroundColor: t.colors.bg,
            borderTopLeftRadius: t.radius.xl,
            borderTopRightRadius: t.radius.xl,
            paddingHorizontal: t.space.xl,
            paddingTop: t.space.md,
            paddingBottom: t.space['2xl'],
            gap: t.space.xl,
          }}>
            <View style={{ alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: t.colors.border }} />

            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.space.md }}>
              <View style={{ flex: 1, gap: t.space.xs }}>
                <AppText variant="h2" numberOfLines={1}>{assignment?.branchName || 'Branch'}</AppText>
                {assignment?.branchAddress ? (
                  <View style={{ flexDirection: 'row', gap: t.space.sm }}>
                    <Icon name="location-outline" size={14} color={t.colors.textFaint} style={{ marginTop: 3 }} />
                    <AppText variant="small" tone="muted" style={{ flex: 1 }} numberOfLines={3}>
                      {assignment.branchAddress}
                    </AppText>
                  </View>
                ) : null}
              </View>
              <IconButton icon="close" onPress={onClose} accessibilityLabel="Close" size={38} />
            </View>

            {/* Time and distance as a pair of tiles: they are the two numbers the sheet exists
                to answer, and they were previously two bare labels lost against the address. */}
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              {([
                { label: 'TRAVEL TIME', value: travelSeconds != null ? formatDuration(travelSeconds) : '—', icon: 'time-outline' },
                { label: 'DISTANCE', value: distanceKm != null ? `${distanceKm.toFixed(1)} km` : '—', icon: 'navigate-outline' },
              ]).map((tile) => (
                <View
                  key={tile.label}
                  style={{
                    flex: 1, gap: 4, padding: t.space.lg,
                    borderRadius: t.radius.lg, backgroundColor: t.colors.surface,
                    borderWidth: 1, borderColor: t.colors.border,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Icon name={tile.icon} size={13} color={t.colors.textFaint} />
                    <AppText variant="overline" tone="faint">{tile.label}</AppText>
                  </View>
                  {loading
                    ? <ActivityIndicator size="small" color={t.colors.primary} style={{ alignSelf: 'flex-start' }} />
                    : <AppText variant="h2">{tile.value}</AppText>}
                </View>
              ))}
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
              <View style={{
                flexDirection: 'row', backgroundColor: t.colors.surface, borderRadius: t.radius.pill,
                padding: 4, borderWidth: 1, borderColor: t.colors.border,
              }}>
                {(['driving', 'transit'] as RouteMode[]).map((m) => {
                  const active = mode === m;
                  return (
                    <Tappable key={m} onPress={() => setMode(m)}>
                      <View style={{
                        flexDirection: 'row', alignItems: 'center', gap: 6,
                        paddingHorizontal: t.space.lg, paddingVertical: t.space.sm,
                        borderRadius: t.radius.pill,
                        backgroundColor: active ? t.colors.primarySoft : 'transparent',
                      }}>
                        <Icon name={m === 'driving' ? 'car' : 'bus'} size={16} color={active ? t.colors.primary : t.colors.textFaint} />
                        <AppText variant="caption" tone={active ? 'primary' : 'faint'}>
                          {m === 'driving' ? 'Drive' : 'Transit'}
                        </AppText>
                      </View>
                    </Tappable>
                  );
                })}
              </View>
              {fare && mode === 'transit' && <Badge label={fare.text || `₹${fare.value}`} tone="success" />}
              {usingFallback && !loading && <Badge label="ESTIMATE" tone="warning" />}
            </View>

            {usingFallback && !loading && (
              <AppText variant="caption" tone="muted">
                Straight-line estimate — no route service reachable. The real drive will be longer.
              </AppText>
            )}

            {error && <AppText variant="caption" tone="danger">{error}</AppText>}

            <View style={{ gap: t.space.sm }}>
              <Button
                label="Start navigation"
                icon="navigate"
                onPress={startNavigation}
                size="lg"
                full
                disabled={!canNavigate}
              />
              {!canNavigate && !loading && (
                <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
                  Turn-by-turn needs your location and a reachable route service.
                </AppText>
              )}
            </View>
          </View>
        </View>
      ) : (
        <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 14,
            backgroundColor: t.colors.surface,
            borderBottomWidth: 1,
            borderBottomColor: t.colors.border,
          }}
        >
          <View style={{ flex: 1 }}>
            <AppText variant="h3" numberOfLines={1}>{assignment?.branchName || 'In-App Navigation'}</AppText>
            <AppText variant="caption" tone="muted" numberOfLines={1}>{assignment?.branchAddress || ''}</AppText>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <Button
              label="Back"
              variant="neutral"
              icon="chevron-back"
              onPress={collapseToSheet}
              size="sm"
            />
            {/* Direct dismissal from the map — the exit that was missing. Back returns to the
                summary sheet; this closes the feature outright. */}
            <IconButton icon="close" onPress={onClose} accessibilityLabel="Close navigation" size={38} />
          </View>
        </View>

        {/* Live turn-by-turn banner */}
        {navigating && steps.length > 0 && (
          <View style={{ backgroundColor: t.colors.primarySoft, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.colors.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 46, height: 46, borderRadius: 12, backgroundColor: t.colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={maneuverIcon(steps[activeStepIndex]?.maneuver)} size={26} color={t.colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText variant="h3" numberOfLines={2}>{steps[activeStepIndex]?.instruction || 'Arrive'}</AppText>
                {activeStepIndex < steps.length - 1 && (
                  <AppText variant="caption" tone="muted" numberOfLines={1}>
                    Next: {steps[activeStepIndex + 1]?.instruction || ''}
                  </AppText>
                )}
              </View>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon name="time-outline" size={16} color={t.colors.primary} />
                <AppText variant="h2">{remainingSeconds != null ? formatDuration(remainingSeconds) : '--'}</AppText>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon name="navigate" size={14} color={t.colors.textFaint} />
                <AppText variant="caption" tone="muted">{remainingKm != null ? `${remainingKm.toFixed(1)} km` : '--'}</AppText>
              </View>
              {speed != null && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Icon name="speedometer" size={14} color={t.colors.textFaint} />
                  <AppText variant="caption" tone="muted">{Math.max(0, Math.round(speed * 3.6))} km/h</AppText>
                </View>
              )}
            </View>
          </View>
        )}

        {/* Map */}
        {destination && (
          <View style={{ flex: 1 }}>
            <View style={{ flex: 1 }}>
              <InteractiveMap
                origin={origin || undefined}
                destination={destination}
                routeCoords={routeCoords}
                fitKey={fitKey}
                heading={heading ?? undefined}
                follow={navigating}
                passedIndex={passedIndex}
              />
            </View>

            {/* Mode toggle (hidden while navigating) */}
            {!navigating && (
              <View style={{ position: 'absolute', top: 12, left: 12, right: 12, flexDirection: 'row', justifyContent: 'center' }}>
                <View style={{ flexDirection: 'row', backgroundColor: t.colors.surface, borderRadius: t.radius.pill, padding: 4, borderWidth: 1, borderColor: t.colors.border }}>
                  {(['driving', 'transit'] as RouteMode[]).map((m) => {
                    const active = mode === m;
                    return (
                      <Tappable key={m} onPress={() => setMode(m)}>
                        <View style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          paddingHorizontal: t.space.lg,
                          paddingVertical: t.space.sm,
                          borderRadius: t.radius.pill,
                          backgroundColor: active ? t.colors.primarySoft : 'transparent',
                        }}>
                          <Icon name={m === 'driving' ? 'car' : 'bus'} size={16} color={active ? t.colors.primary : t.colors.textFaint} />
                          <AppText variant="caption" tone={active ? 'primary' : 'faint'}>
                            {m === 'driving' ? 'Drive' : 'Transit'}
                          </AppText>
                        </View>
                      </Tappable>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Bottom panel */}
            <View style={{ position: 'absolute', left: 12, right: 12, bottom: 12, maxHeight: 260, backgroundColor: t.colors.surface, borderRadius: t.radius.lg, padding: t.space.lg, borderWidth: 1, borderColor: t.colors.border }}>
              {loading ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
                  <ActivityIndicator size="small" color={t.colors.primary} />
                  <AppText variant="body" tone="muted">Calculating {mode === 'driving' ? 'drive' : 'transit'} route...</AppText>
                </View>
              ) : (
                <>
                  {/* ETA + fare row */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Icon name="time-outline" size={18} color={t.colors.primary} />
                      <AppText variant="h1">{travelSeconds != null ? formatDuration(travelSeconds) : '--'}</AppText>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {fare && mode === 'transit' && (
                        <Badge label={`Fare ${fare.text || `₹${fare.value}`}`} tone="success" />
                      )}
                      {usingFallback && (
                        <Badge label="ESTIMATE" tone="warning" />
                      )}
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    <Icon name="navigate" size={13} color={t.colors.textFaint} />
                    <AppText variant="caption" tone="muted">
                      {distanceKm != null ? `${distanceKm.toFixed(1)} km` : '—'} {mode === 'driving' ? 'driving' : 'transit'} distance
                    </AppText>
                  </View>

                  {/* Turn-by-turn steps (active step highlighted during nav) */}
                  {steps.length > 0 && (
                    <View style={{ marginTop: 8, maxHeight: 110 }}>
                      <ScrollView nestedScrollEnabled style={{ flex: 1 }}>
                        {steps.map((s, i) => {
                          const isActive = navigating && i === activeStepIndex;
                          return (
                            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3, backgroundColor: isActive ? t.colors.primarySoft : 'transparent', borderRadius: 6, paddingHorizontal: isActive ? 6 : 0 }}>
                              <Icon name={maneuverIcon(s.maneuver)} size={14} color={isActive ? t.colors.primary : t.colors.textFaint} />
                              <AppText variant="small" style={{ flex: 1 }} numberOfLines={2} tone={isActive ? 'primary' : undefined}>
                                {s.instruction}
                              </AppText>
                              {s.distanceM > 0 && (
                                <AppText variant="caption" tone="faint">
                                  {s.distanceM >= 1000 ? `${(s.distanceM / 1000).toFixed(1)} km` : `${Math.round(s.distanceM)} m`}
                                </AppText>
                              )}
                            </View>
                          );
                        })}
                      </ScrollView>
                    </View>
                  )}

                  {error && <AppText variant="caption" tone="danger" style={{ marginTop: 6 }}>{error}</AppText>}

                  {/* Action buttons */}
                  {origin && (
                    <View style={{ flexDirection: 'row', gap: t.space.md, marginTop: t.space.md }}>
                      <Button label="Refresh" icon="refresh" variant="neutral" onPress={() => buildRoute(origin, mode)} style={{ flex: 1 }} />
                      {steps.length > 0 && (
                        <Button
                          label={navigating ? 'Stop Nav' : 'Start Nav'}
                          icon={navigating ? 'square' : 'play'}
                          variant={navigating ? 'danger' : 'primary'}
                          onPress={() => setNavigating((n) => !n)}
                          style={{ flex: 1 }}
                        />
                      )}
                    </View>
                  )}
                </>
              )}
            </View>
          </View>
        )}
        </View>
      )}
    </RNModal>
  );
};
