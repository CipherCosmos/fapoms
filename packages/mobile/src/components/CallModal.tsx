import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Modal, View, Vibration, Platform } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Avatar, GlowBlob, Icon, Tappable } from './ui/primitives';
import { useFeedback } from './ui/Feedback';
import {
  CallState,
  acceptCall,
  declineCall,
  getCallState,
  hangupCall,
  subscribeToCallState,
  toggleMute,
  toggleSpeaker,
} from '../services/calls';

/**
 * Full-screen in-call / incoming-call UI, mounted once at the app root (like
 * InAppNavigationModal). Renders nothing while no call exists; the calls service's
 * observable store decides everything else.
 *
 * Design notes: Midnight Neon language — violet GlowBlob halo behind the peer avatar, the
 * hang-up control is the screen's one glowing danger action. No TextInputs live here, so the
 * documented Fabric IME/elevation constraint doesn't apply, and every subcomponent is
 * declared at module scope (see ProfileScreen.tsx for why inline declarations remount).
 */

function useCallState(): CallState {
  return useSyncExternalStore(subscribeToCallState, getCallState, getCallState);
}

/** mm:ss since the call went active. */
function formatElapsed(connectedAt: number | null, now: number): string {
  if (!connectedAt) return '00:00';
  const s = Math.max(0, Math.floor((now - connectedAt) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** Ring vibration: pulse-pause loop until answered or dismissed. No audio asset needed. */
const RING_PATTERN = Platform.OS === 'android' ? [0, 600, 400, 600, 1400] : [0, 1400];

/** Round call-control button (mute / speaker / accept / decline / hang up). */
const CallControl: React.FC<{
  icon: string;
  label: string;
  onPress: () => void;
  /** Filled colour treatment; default is a quiet surface chip. */
  tone?: 'neutral' | 'danger' | 'success';
  /** Lit state for toggles (mute on, speaker on). */
  active?: boolean;
  /** Neon halo — reserved for the decisive action (accept / hang up). */
  glow?: boolean;
  size?: number;
}> = ({ icon, label, onPress, tone = 'neutral', active, glow, size = 64 }) => {
  const t = useTheme();
  const bg =
    tone === 'danger' ? t.colors.danger
    : tone === 'success' ? t.colors.success
    : active ? t.colors.primarySoft
    : t.colors.surfaceAlt;
  const fg =
    tone === 'danger' || tone === 'success' ? '#FFFFFF'
    : active ? t.colors.primary
    : t.colors.text;
  const glowStyle = glow
    ? {
        shadowColor: bg,
        shadowOpacity: 0.55,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
        elevation: 10,
      }
    : null;

  return (
    <View style={{ alignItems: 'center', gap: t.space.sm }}>
      <Tappable onPress={onPress} scaleTo={0.9} accessibilityLabel={label} accessibilityRole="button">
        <View
          style={[
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: bg,
              borderWidth: 1,
              borderColor: tone === 'neutral' && !active ? t.colors.border : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
            },
            glowStyle,
          ]}
        >
          <Icon name={icon} size={Math.round(size * 0.42)} color={fg} />
        </View>
      </Tappable>
      <AppText variant="caption" tone="muted">{label}</AppText>
    </View>
  );
};

export const CallModal: React.FC = () => {
  const t = useTheme();
  const feedback = useFeedback();
  const call = useCallState();
  const [now, setNow] = useState(Date.now());

  const visible = call.phase !== 'idle';
  const incoming = call.phase === 'incoming';
  const active = call.phase === 'active';

  // Drive the mm:ss timer only while a call is actually running.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  // Looped ring vibration while an incoming call waits; stops the instant the phase moves on.
  useEffect(() => {
    if (!incoming) return;
    Vibration.vibrate(RING_PATTERN, true);
    return () => Vibration.cancel();
  }, [incoming]);

  if (!visible) return null;

  const statusLine = incoming
    ? 'Incoming call'
    : call.phase === 'connecting'
      ? 'Connecting…'
      : call.phase === 'outgoing'
        ? 'Ringing…'
        : formatElapsed(call.connectedAt, now);

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={() => {
      // Hardware back mirrors the on-screen dismissal: decline a ring, hang up a call.
      void (incoming ? declineCall() : hangupCall());
    }}>
      <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
        {/* The ambient neon halo, concentrated behind the caller identity. */}
        <View pointerEvents="none" style={{ position: 'absolute', top: 40, alignSelf: 'center' }}>
          <GlowBlob color={t.colors.primary} size={420} opacity={incoming ? 0.07 : 0.05} />
        </View>
        <View pointerEvents="none" style={{ position: 'absolute', bottom: -140, right: -110 }}>
          <GlowBlob color={t.colors.accent} size={320} opacity={0.04} />
        </View>

        {/* Identity + status */}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: t.space['2xl'], gap: t.space.md }}>
          <Avatar name={call.peerName || 'Desk'} size={104} />
          <AppText variant="h1" style={{ textAlign: 'center' }}>{call.peerName || 'Data Entry Team'}</AppText>
          <AppText
            variant={active ? 'h2' : 'body'}
            tone={active ? 'accent' : 'muted'}
            style={active ? { fontVariant: ['tabular-nums'] } : undefined}
          >
            {statusLine}
          </AppText>

          {!!call.queryText && (
            <View
              style={{
                marginTop: t.space.lg,
                paddingVertical: t.space.md,
                paddingHorizontal: t.space.lg,
                borderRadius: t.radius.lg,
                backgroundColor: t.colors.surface,
                borderWidth: 1,
                borderColor: t.colors.border,
                maxWidth: 340,
              }}
            >
              <AppText variant="overline" tone="faint" style={{ marginBottom: 4 }}>ABOUT THIS QUERY</AppText>
              <AppText variant="small" tone="muted" numberOfLines={3}>{call.queryText}</AppText>
            </View>
          )}
        </View>

        {/* Controls */}
        <View style={{ paddingBottom: t.space['4xl'] + t.space.lg, paddingHorizontal: t.space['2xl'] }}>
          {incoming ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-evenly' }}>
              <CallControl icon="close" label="Decline" tone="danger" size={72}
                onPress={() => { void declineCall(); }} />
              <CallControl icon="call" label="Accept" tone="success" glow size={72}
                onPress={() => {
                  acceptCall().catch((err) =>
                    feedback.error('Could not answer', err?.message || 'The call could not be connected.'));
                }} />
            </View>
          ) : (
            <View style={{ flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'flex-end' }}>
              <CallControl
                icon={call.muted ? 'mic-off' : 'mic'}
                label={call.muted ? 'Unmute' : 'Mute'}
                active={call.muted}
                onPress={() => { void toggleMute(); }}
              />
              <CallControl icon="call" label="End" tone="danger" glow size={76}
                onPress={() => { void hangupCall(); }} />
              <CallControl
                icon={call.speakerOn ? 'volume-high' : 'volume-medium'}
                label="Speaker"
                active={call.speakerOn}
                onPress={() => { void toggleSpeaker(); }}
              />
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
};
