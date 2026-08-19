import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Image, PanResponder, Animated, LayoutChangeEvent } from 'react-native';
import { AppText, Icon, Tappable } from './primitives';
import { useTheme } from '../../theme/ThemeProvider';

/**
 * A keyless "drop a pin" map, built from raster tiles, `<Image>` and `PanResponder`.
 *
 * ## Why this is hand-rolled instead of `react-native-maps`
 *
 * `react-native-maps` IS installed (see components/MapNative.tsx) but it cannot be used here.
 * On Android it needs a Google Maps API key, and `GOOGLE_MAPS_API_KEY` is unset for this
 * project — every APK in the field today ships without one. Mounting `PROVIDER_GOOGLE` in that
 * state does not degrade to a blank rectangle: the native view fails to create and takes the
 * whole Activity down. A picker built on it would crash the app on the assayer's actual phone,
 * on the one screen they open to fix their own record. MapNative.tsx documents this at length.
 *
 * A WebView/Leaflet map would work, but `react-native-webview` is a native module, and this app
 * ships JS-only fixes over-the-air in about a minute (scripts/publish-ota.sh). Adding a native
 * dependency changes the runtime fingerprint and forces a 15–40 minute rebuild plus a manual
 * reinstall for every field worker. So: React Native core only.
 *
 * What remains is the oldest trick in web mapping — a "slippy map". Standard Web Mercator tile
 * math turns (lat, lng, zoom) into 256px PNG tiles, we lay a grid of `<Image>`s over the
 * viewport, and `PanResponder` drags that grid around. No SDK, no key, no native code.
 *
 * ## Fixed centre pin
 *
 * The pin does not move; the map moves under it. The map's centre IS the chosen coordinate.
 * This is what Uber, Ola and Swiggy all do for address pinning, and it is far more robust than a
 * draggable marker: no hit-testing, no marker/gesture conflicts, and the target stays under the
 * user's thumb-free centre of the screen rather than under their finger.
 *
 * ## OpenStreetMap tile usage policy
 *
 * Tiles come from OSM's public tile servers, which are donated infrastructure with a usage
 * policy (no bulk downloading, no heavy automated use, attribution required). This component is
 * a deliberately light consumer: one small viewport, no prefetching beyond the visible grid,
 * a capped maximum zoom, and panning debounced so a drag does not machine-gun requests. The
 * attribution is rendered on the map, as the policy requires.
 *
 * If this ever grows beyond occasional profile edits, TILE_URL_TEMPLATE should move to platform
 * settings (the backend already has a runtime config store) and point at a paid or self-hosted
 * tile source rather than the community servers.
 */

/** `{z}/{x}/{y}` raster tiles, 256px. See the OSM tile policy note above before raising usage. */
const TILE_URL_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_SIZE = 256;

/** Capped well below OSM's 19 — street-level detail is enough to place a house, and every extra
 *  zoom level is another four tiles fetched for the same viewport. */
export const MAX_ZOOM = 18;
export const MIN_ZOOM = 3;

/** Roughly the geographic centre of India, at a zoom that shows the whole country. Used ONLY as a
 *  starting viewport for a manual placement the user has explicitly asked for — never written to
 *  a profile as if it were a real home location. See useAssayerProfile.ts on why a plausible
 *  fabricated default (a hardcoded New Delhi) is worse than an obviously missing one. */
export const INDIA_CENTRE = { latitude: 22.9734, longitude: 78.6569, zoom: 4 };

/* ── Web Mercator ────────────────────────────────────────────────────────────────────────── */

/** Pixel coordinates in the whole-world square at `zoom` (world is 256 * 2^zoom px on a side). */
function project(latitude: number, longitude: number, zoom: number) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const x = ((longitude + 180) / 360) * scale;
  const sinLat = Math.sin((latitude * Math.PI) / 180);
  // Clamped to Mercator's ±85.05° limit; beyond it the projection runs to infinity.
  const clamped = Math.min(Math.max(sinLat, -0.9999), 0.9999);
  const y = (0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI)) * scale;
  return { x, y };
}

/** The inverse of `project` — world pixels back to lat/lng. */
function unproject(x: number, y: number, zoom: number) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const longitude = (x / scale) * 360 - 180;
  const n = Math.PI - 2 * Math.PI * (y / scale);
  const latitude = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { latitude, longitude };
}

/**
 * The server's plausibility gate, mirrored client-side.
 *
 * `packages/backend/src/modules/geo/coordinate-resolution.ts` rejects anything outside these
 * exact bounds (and rejects 0,0, which is this app's "unknown" marker). Checking here means an
 * off-India pin is caught with a message the assayer can act on, instead of being silently
 * dropped by the server after a save that reported success.
 */
export function isPlausibleIndianCoord(latitude?: number | null, longitude?: number | null): boolean {
  if (latitude == null || longitude == null) return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude === 0 && longitude === 0) return false;
  return latitude >= 6.4 && latitude <= 37.7 && longitude >= 68.0 && longitude <= 97.5;
}

/* ── Component ───────────────────────────────────────────────────────────────────────────── */

export interface MapPickerProps {
  /** The current pin. The map centre is always this coordinate. */
  latitude: number;
  longitude: number;
  /** Fired when a pan settles (debounced), and on every zoom step. */
  onChange: (latitude: number, longitude: number) => void;
  /** When false the map is a static preview: no panning, no zoom buttons. */
  editable?: boolean;
  /** Starting zoom. Ignored after first render — zoom is then the user's. */
  initialZoom?: number;
  height?: number;
}

export const MapPicker: React.FC<MapPickerProps> = ({
  latitude,
  longitude,
  onChange,
  editable = true,
  initialZoom = 15,
  height = 210,
}) => {
  const t = useTheme();

  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(() => Math.min(Math.max(initialZoom, MIN_ZOOM), MAX_ZOOM));
  const [centre, setCentre] = useState({ latitude, longitude });

  /** Tiles that 404'd or timed out. A weak field connection must degrade to a coloured square,
   *  never to a broken component — the coordinate is still valid without its picture. */
  const [failed, setFailed] = useState<Record<string, true>>({});

  /**
   * Live drag offset. Kept in an `Animated.ValueXY` and driven straight from the responder so
   * the tile grid tracks the finger without a React render per frame; the actual centre is only
   * recomputed once, on release.
   */
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const centreRef = useRef(centre);
  centreRef.current = centre;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  /** The last coordinate we told the parent about, so the prop echoing back does not re-centre
   *  the map mid-gesture (which would fight the user's drag). */
  const lastEmitted = useRef<{ latitude: number; longitude: number } | null>(null);
  const emitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const emit = useCallback(
    (lat: number, lng: number) => {
      if (emitTimer.current) clearTimeout(emitTimer.current);
      // Debounced: a pan that ends with a small correcting nudge should produce one
      // reverse-geocode, not three. The parent's geocoding is the expensive half of this.
      emitTimer.current = setTimeout(() => {
        lastEmitted.current = { latitude: lat, longitude: lng };
        onChange(lat, lng);
      }, 280);
    },
    [onChange],
  );

  useEffect(() => () => { if (emitTimer.current) clearTimeout(emitTimer.current); }, []);

  // Follow the props when they move for a reason other than our own emit — "use my current
  // location", a pincode lookup, a fresh profile load.
  useEffect(() => {
    const mine = lastEmitted.current;
    if (mine && Math.abs(mine.latitude - latitude) < 1e-6 && Math.abs(mine.longitude - longitude) < 1e-6) return;
    setCentre({ latitude, longitude });
  }, [latitude, longitude]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => editable,
        onMoveShouldSetPanResponder: (_e, g) => editable && (Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2),
        onPanResponderMove: (_e, g) => {
          pan.setValue({ x: g.dx, y: g.dy });
        },
        onPanResponderRelease: (_e, g) => {
          pan.setValue({ x: 0, y: 0 });
          const z = zoomRef.current;
          const c = centreRef.current;
          // The map moved right under a fixed pin, so the pin moved LEFT across the world —
          // hence the subtraction.
          const world = project(c.latitude, c.longitude, z);
          const next = unproject(world.x - g.dx, world.y - g.dy, z);
          setCentre(next);
          emit(next.latitude, next.longitude);
        },
        onPanResponderTerminate: () => { pan.setValue({ x: 0, y: 0 }); },
      }),
    [editable, emit, pan],
  );

  const step = (delta: number) => {
    const next = Math.min(Math.max(zoom + delta, MIN_ZOOM), MAX_ZOOM);
    if (next === zoom) return;
    setZoom(next);
    // Zoom keeps the centre, so the coordinate does not change — but re-emitting lets the parent
    // treat a zoom as a deliberate confirmation of the same point.
    emit(centreRef.current.latitude, centreRef.current.longitude);
  };

  /** The visible tile grid: whole tiles covering the viewport, plus one ring of overscan so a
   *  drag reveals loaded tiles rather than empty space. */
  const tiles = useMemo(() => {
    if (width <= 0) return [];
    const worldSize = Math.pow(2, zoom);
    const c = project(centre.latitude, centre.longitude, zoom);
    const topLeftX = c.x - width / 2;
    const topLeftY = c.y - height / 2;
    const firstX = Math.floor(topLeftX / TILE_SIZE) - 1;
    const firstY = Math.floor(topLeftY / TILE_SIZE) - 1;
    const cols = Math.ceil(width / TILE_SIZE) + 3;
    const rows = Math.ceil(height / TILE_SIZE) + 3;

    const out: { key: string; uri: string; left: number; top: number }[] = [];
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const tx = firstX + i;
        const ty = firstY + j;
        // Rows outside the world simply do not exist; columns wrap around the date line.
        if (ty < 0 || ty >= worldSize) continue;
        const wrappedX = ((tx % worldSize) + worldSize) % worldSize;
        out.push({
          key: `${zoom}/${wrappedX}/${ty}`,
          uri: TILE_URL_TEMPLATE.replace('{z}', String(zoom)).replace('{x}', String(wrappedX)).replace('{y}', String(ty)),
          left: tx * TILE_SIZE - topLeftX,
          top: ty * TILE_SIZE - topLeftY,
        });
      }
    }
    return out;
  }, [width, height, zoom, centre]);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w !== width) setWidth(w);
  };

  const ZoomButton: React.FC<{ icon: string; label: string; onPress: () => void; disabled: boolean }> = ({
    icon, label, onPress, disabled,
  }) => (
    <Tappable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}>
      <View
        style={{
          width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
          borderRadius: t.radius.sm,
          backgroundColor: t.colors.surface,
          borderWidth: 1, borderColor: t.colors.border,
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Icon name={icon} size={16} color={t.colors.text} />
      </View>
    </Tappable>
  );

  return (
    <View
      onLayout={onLayout}
      style={{
        height,
        borderRadius: t.radius.lg,
        borderWidth: 1,
        borderColor: t.colors.border,
        backgroundColor: t.colors.surfaceAlt,
        overflow: 'hidden',
      }}
      {...panResponder.panHandlers}
    >
      {/* Tiles. `surfaceAlt` behind them is the fallback any failed tile falls through to. */}
      <Animated.View
        style={{ ...StyleSheetAbsoluteFill, transform: [{ translateX: pan.x }, { translateY: pan.y }] }}
      >
        {tiles.map((tile) =>
          failed[tile.key] ? null : (
            <Image
              key={tile.key}
              source={{ uri: tile.uri }}
              onError={() => setFailed((prev) => ({ ...prev, [tile.key]: true }))}
              style={{ position: 'absolute', left: tile.left, top: tile.top, width: TILE_SIZE, height: TILE_SIZE }}
              // Tiles are opaque squares; fading them in makes a pan look like a stutter.
              fadeDuration={0}
            />
          ),
        )}
      </Animated.View>

      {/* The fixed centre pin. `pointerEvents: none` throughout so it never eats a drag. */}
      <View pointerEvents="none" style={StyleSheetAbsoluteFill}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {/* Drawn as a stem plus a dot at the true centre, offset up by half its height so the
              dot — not the middle of the glyph — sits on the coordinate. */}
          <View style={{ alignItems: 'center', marginBottom: 26 }}>
            <Icon name="location" size={30} color={t.colors.primary} />
          </View>
          <View
            style={{
              position: 'absolute',
              width: 8, height: 8, borderRadius: t.radius.pill,
              backgroundColor: t.colors.primary,
              borderWidth: 1.5, borderColor: t.colors.onPrimary,
            }}
          />
        </View>
      </View>

      {editable && (
        <View style={{ position: 'absolute', right: t.space.sm, top: t.space.sm, gap: t.space.xs }}>
          <ZoomButton icon="add" label="Zoom in" onPress={() => step(1)} disabled={zoom >= MAX_ZOOM} />
          <ZoomButton icon="remove" label="Zoom out" onPress={() => step(-1)} disabled={zoom <= MIN_ZOOM} />
        </View>
      )}

      {/* Required by the OSM tile usage policy. Not optional, and not to be styled away. */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          paddingHorizontal: t.space.sm, paddingVertical: 2,
          backgroundColor: t.colors.scrim,
        }}
      >
        <AppText variant="caption" style={{ color: t.colors.text, fontSize: 9, lineHeight: 12 }}>
          © OpenStreetMap contributors
        </AppText>
      </View>
    </View>
  );
};

/** Inlined rather than `StyleSheet.absoluteFillObject` so the file needs no StyleSheet import
 *  purely for a four-property constant. */
const StyleSheetAbsoluteFill = { position: 'absolute' as const, left: 0, right: 0, top: 0, bottom: 0 };
