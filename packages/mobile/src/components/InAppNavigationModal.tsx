import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, Modal as RNModal, Platform, ActivityIndicator, ScrollView } from 'react-native';
import * as Location from 'expo-location';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { AssayerAssignment } from '../types/mobile-app';
import { styles } from '../theme/styles';
import { InteractiveMap } from './MapEntry';

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
}

interface FareInfo {
  text: string;
  currency: string;
  value: number;
}

// Geodesic "straight-line" distance (Haversine) in km. Used as a graceful,
// zero-key fallback when routing is unavailable.
function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const la1 = (a.latitude * Math.PI) / 180;
  const la2 = (b.latitude * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
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
          const res = await fetch(`${DIRECTIONS_URL}?${params.toString()}`);
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
          const res = await fetch(url);
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

  // Dynamic reroute: poll location while navigating; if far off the route, re-route.
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!visible || !navigating || !origin || !destination) return;

    pollRef.current = setInterval(async () => {
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const current: LatLng = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
        const lastOrigin = origin;
        if (!lastOrigin) return;
        setOrigin(current);

        // If we have a real route and the user has drifted off it, re-route.
        if (routeCoords.length > 1) {
          const off = distanceToPolylineKm(current, routeCoords);
          if (off > 0.12) {
            // 120m off route → reroute
            const lastKey = routeCacheKey(
              apiKey ? 'google' : 'osrm',
              mode,
              lastOrigin,
              destination,
            );
            const nextKey = routeCacheKey(
              apiKey ? 'google' : 'osrm',
              mode,
              current,
              destination,
            );
            // Only refetch when the origin actually moved (avoid cache-hit spam).
            if (nextKey !== lastKey) {
              buildRoute(current, mode);
            }
          }
        }
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
  }, [visible, navigating, origin, destination, routeCoords, mode, apiKey, buildRoute]);

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

  return (
    <RNModal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#090d16' }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 14,
            backgroundColor: '#0f172a',
            borderBottomWidth: 1,
            borderBottomColor: 'rgba(99,102,241,0.2)',
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 16, fontWeight: '900', color: '#fff' }}>
              {assignment?.branchName || 'In-App Navigation'}
            </Text>
            <Text style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }} numberOfLines={1}>
              {assignment?.branchAddress || ''}
            </Text>
          </View>
          <TouchableOpacity
            onPress={onClose}
            style={{ backgroundColor: 'rgba(239,68,68,0.15)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}
          >
            <Text style={{ color: '#f87171', fontWeight: '800', fontSize: 13 }}>✕ Close</Text>
          </TouchableOpacity>
        </View>

        {/* Map (platform-split: Leaflet/OSM on web, react-native-maps on native) */}
        {destination && (
          <View style={{ flex: 1 }}>
            <View style={{ flex: 1 }}>
              <InteractiveMap
                origin={origin || undefined}
                destination={destination}
                routeCoords={routeCoords}
                fitKey={fitKey}
              />
            </View>

            {/* Mode toggle */}
            <View style={{ position: 'absolute', top: 12, left: 12, right: 12, flexDirection: 'row', justifyContent: 'center' }}>
              <View style={{ flexDirection: 'row', backgroundColor: 'rgba(15,23,42,0.95)', borderRadius: 24, padding: 3, borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)' }}>
                {(['driving', 'transit'] as RouteMode[]).map((m) => {
                  const active = mode === m;
                  return (
                    <TouchableOpacity
                      key={m}
                      onPress={() => setMode(m)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 16,
                        paddingVertical: 8,
                        borderRadius: 20,
                        backgroundColor: active ? '#2563eb' : 'transparent',
                      }}
                    >
                      <Ionicons name={m === 'driving' ? 'car' : 'bus'} size={16} color={active ? '#fff' : '#94a3b8'} />
                      <Text style={{ color: active ? '#fff' : '#94a3b8', fontWeight: '800', fontSize: 13 }}>
                        {m === 'driving' ? 'Drive' : 'Transit'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Bottom panel */}
            <View style={{ position: 'absolute', left: 12, right: 12, bottom: 12, maxHeight: 260, backgroundColor: 'rgba(15,23,42,0.97)', borderRadius: 16, padding: 14, borderWidth: 1, borderColor: 'rgba(99,102,241,0.25)' }}>
              {loading ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
                  <ActivityIndicator size="small" color="#2563eb" />
                  <Text style={{ color: '#94a3b8', fontSize: 13 }}>Calculating {mode === 'driving' ? 'drive' : 'transit'} route...</Text>
                </View>
              ) : (
                <>
                  {/* ETA + fare row */}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Ionicons name="time-outline" size={18} color="#38bdf8" />
                      <Text style={{ fontSize: 24, fontWeight: '900', color: '#fff' }}>
                        {travelSeconds != null ? formatDuration(travelSeconds) : '--'}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {fare && mode === 'transit' && (
                        <View style={{ backgroundColor: 'rgba(16,185,129,0.15)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' }}>
                          <Text style={{ fontSize: 11, color: '#34d399', fontWeight: '800' }}>Fare {fare.text || `₹${fare.value}`}</Text>
                        </View>
                      )}
                      {usingFallback && (
                        <View style={{ backgroundColor: 'rgba(245,158,11,0.15)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)' }}>
                          <Text style={{ fontSize: 10, color: '#fbbf24', fontWeight: '700' }}>ESTIMATE</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    <Ionicons name="navigate" size={13} color="#94a3b8" />
                    <Text style={{ color: '#94a3b8', fontSize: 12 }}>
                      {distanceKm != null ? `${distanceKm.toFixed(1)} km` : '—'} {mode === 'driving' ? 'driving' : 'transit'} distance
                    </Text>
                  </View>

                  {/* Turn-by-turn steps */}
                  {steps.length > 0 && (
                    <View style={{ marginTop: 8, maxHeight: 110 }}>
                      <ScrollView nestedScrollEnabled style={{ flex: 1 }}>
                        {steps.map((s, i) => (
                          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 }}>
                            <Ionicons name={maneuverIcon(s.maneuver)} size={14} color="#60a5fa" />
                            <Text style={{ color: '#e2e8f0', fontSize: 12, flex: 1 }} numberOfLines={2}>
                              {i === 0 ? <Text style={{ color: '#38bdf8', fontWeight: '800' }}>• </Text> : null}
                              {s.instruction}
                            </Text>
                            {s.distanceM > 0 && (
                              <Text style={{ color: '#64748b', fontSize: 11 }}>
                                {s.distanceM >= 1000 ? `${(s.distanceM / 1000).toFixed(1)} km` : `${Math.round(s.distanceM)} m`}
                              </Text>
                            )}
                          </View>
                        ))}
                      </ScrollView>
                    </View>
                  )}

                  {error && <Text style={{ color: '#f87171', fontSize: 11, marginTop: 6 }}>{error}</Text>}
                  {mode === 'transit' && !apiKey && (
                    <Text style={{ color: '#fbbf24', fontSize: 10, marginTop: 4 }}>
                      Transit requires GOOGLE_MAPS_API_KEY.
                    </Text>
                  )}
                  {usingFallback && !isWeb && mode === 'driving' && (
                    <Text style={{ color: '#fbbf24', fontSize: 10, marginTop: 4 }}>
                      No Google Maps API key set — showing straight-line estimate. Add GOOGLE_MAPS_API_KEY for live routing.
                    </Text>
                  )}

                  {/* Action buttons */}
                  {origin && (
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                      <TouchableOpacity
                        onPress={() => buildRoute(origin, mode)}
                        style={[styles.mapBtn, { flex: 1, backgroundColor: '#2563eb', borderColor: '#2563eb' }]}
                      >
                        <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>↻ Refresh</Text>
                      </TouchableOpacity>
                      {steps.length > 0 && (
                        <TouchableOpacity
                          onPress={() => setNavigating((n) => !n)}
                          style={[styles.mapBtn, { flex: 1, backgroundColor: navigating ? 'rgba(239,68,68,0.9)' : 'rgba(16,185,129,0.2)', borderColor: navigating ? '#ef4444' : '#10b981' }]}
                        >
                          <Text style={{ color: navigating ? '#fff' : '#34d399', fontSize: 13, fontWeight: '800' }}>
                            {navigating ? '⏹ Stop Nav' : '▶ Start Nav'}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </>
              )}
            </View>
          </View>
        )}
      </View>
    </RNModal>
  );
};
