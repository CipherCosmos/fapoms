import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Image, Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { AppText, Button, Icon, IconButton } from './ui/primitives';
import { useT } from '../i18n';
import { MobileApiService, type LiveIdCardCode, type MyIdCard } from '../services/api.service';

/*
  Screenshot blocking (Android FLAG_SECURE; iOS hides the screen from recordings and tells us about
  screenshots). A native module: present from the next app build, absent in an older installed app —
  so it is loaded defensively and the card works either way. The live code is the real protection.
*/
let ScreenCapture: {
  preventScreenCaptureAsync: (key?: string) => Promise<void>;
  allowScreenCaptureAsync: (key?: string) => Promise<void>;
  addScreenshotListener?: (cb: () => void) => { remove: () => void };
} | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ScreenCapture = require('expo-screen-capture');
} catch {
  ScreenCapture = null;
}

const NAVY = '#0b1633';
const INDIGO = '#1e2a6b';
const GOLD = '#d4a017';
const GOLD_SOFT = '#f4d77a';
const INK = '#0f172a';
const MUTED = '#64748b';

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
const initialsOf = (name: string) => (name || '').split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * THE DIGITAL ID CARD (owner, 2026-09-23) — the only form the card takes. Nothing to download,
 * share or print.
 *
 * What makes it worth trusting is on screen and moving: a QR and a 6-digit code that change every
 * minute (checked on our public /verify page against the record as it is now), a running clock and
 * a moving sheen. A screenshot freezes all three, and its code stops working within two minutes.
 */
export const IdCardModal: React.FC<{ visible: boolean; onClose: () => void }> = ({ visible, onClose }) => {
  const tr = useT();
  const [card, setCard] = useState<MyIdCard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveIdCardCode | null>(null);
  const [liveError, setLiveError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [screenshotWarned, setScreenshotWarned] = useState(false);
  const offset = useRef(0); // server clock minus phone clock
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sheen = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  const loadCode = useCallback(async () => {
    const res = await MobileApiService.getIdCardCode();
    if (res.success && res.data) {
      offset.current = res.data.serverNow - Date.now();
      setLive(res.data);
      setLiveError(false);
      const wait = Math.max(1000, res.data.changesAt - res.data.serverNow + 300);
      refreshTimer.current = setTimeout(() => { void loadCode(); }, wait);
    } else {
      // A code we cannot refresh is a code nobody should be shown — hide it, try again shortly.
      setLive(null);
      setLiveError(true);
      refreshTimer.current = setTimeout(() => { void loadCode(); }, 10_000);
    }
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    setCard(null); setLoadError(null); setLive(null); setScreenshotWarned(false);
    void MobileApiService.getMyIdCard().then((res) => {
      if (cancelled) return;
      if (!res.success || !res.data) { setLoadError(res.error ?? tr('idCard.loadFailed')); return; }
      setCard(res.data);
      if (res.data.issued) void loadCode();
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const sheenLoop = Animated.loop(Animated.timing(sheen, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    const pulseLoop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
    ]));
    sheenLoop.start(); pulseLoop.start();
    void ScreenCapture?.preventScreenCaptureAsync('id-card').catch(() => undefined);
    const shot = ScreenCapture?.addScreenshotListener?.(() => setScreenshotWarned(true));
    return () => {
      cancelled = true;
      clearInterval(tick);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      sheenLoop.stop(); pulseLoop.stop();
      shot?.remove();
      void ScreenCapture?.allowScreenCaptureAsync('id-card').catch(() => undefined);
    };
  }, [visible, loadCode, sheen, pulse, tr]);

  const serverNow = new Date(now + offset.current);
  const secondsLeft = live ? Math.max(0, Math.ceil((live.changesAt - (now + offset.current)) / 1000)) : 0;
  const clock = `${pad(serverNow.getHours())}:${pad(serverNow.getMinutes())}:${pad(serverNow.getSeconds())}`;
  const verifyHost = live ? live.verifyUrl.replace(/\/verify\/card\/.*$/, '').replace(/^https?:\/\//, '') : '';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <IconButton icon="close" onPress={onClose} accessibilityLabel={tr('idCard.close')} />
          <AppText variant="bodyStrong" style={{ color: '#fff' }}>{tr('idCard.title')}</AppText>
          <View style={{ width: 40 }} />
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          {loadError ? (
            <View style={styles.panel}>
              <AppText variant="bodyStrong">{tr('idCard.loadFailed')}</AppText>
              <AppText variant="small" tone="muted">{loadError}</AppText>
              <Button label={tr('idCard.close')} onPress={onClose} />
            </View>
          ) : !card ? (
            <ActivityIndicator color={GOLD_SOFT} size="large" style={{ marginTop: 80 }} />
          ) : !card.issued ? (
            <View style={styles.panel}>
              <Icon name="id-card-outline" size={36} color={INDIGO} />
              <AppText variant="bodyStrong">{tr('idCard.notIssuedTitle')}</AppText>
              {card.blockedBecause.map((b) => <AppText key={b} variant="small" tone="muted">• {b}</AppText>)}
              <AppText variant="small" tone="muted">{tr('idCard.notIssuedBody')}</AppText>
            </View>
          ) : (
            <View style={styles.card} accessibilityLabel={`${tr('idCard.title')}: ${card.fullName}, ${card.assayerCode}`}>
              {/* Header */}
              <View style={styles.header}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                  <Image source={require('../../assets/sumeru-logo.png')} style={{ width: 30, height: 30 }} resizeMode="contain" />
                  <View style={{ flex: 1 }}>
                    <AppText numberOfLines={1} style={styles.org}>{(card.organisation ?? 'SUMERU GLOBAL').toUpperCase()}</AppText>
                    <AppText style={styles.orgSub}>FIELD AUDIT OPERATIONS</AppText>
                  </View>
                </View>
                <View style={styles.digitalPill}><AppText style={styles.digitalPillText}>DIGITAL ID</AppText></View>
                {/* The sheen: always moving, so a still image of the card reads as a still image. */}
                <Animated.View pointerEvents="none" style={[styles.sheen, {
                  transform: [{ translateX: sheen.interpolate({ inputRange: [0, 1], outputRange: [-220, 420] }) }, { rotate: '20deg' }],
                }]} />
              </View>

              {/* Photo */}
              <View style={styles.photoRing}>
                <View style={styles.photoInner}>
                  {card.photo
                    ? <Image source={{ uri: card.photo }} style={{ width: '100%', height: '100%' }} />
                    : <AppText style={styles.initials}>{initialsOf(card.fullName)}</AppText>}
                </View>
              </View>

              {/* Who */}
              <View style={{ alignItems: 'center', paddingHorizontal: 18, gap: 6 }}>
                <AppText style={styles.name}>{card.fullName}</AppText>
                <View style={styles.titleChip}><AppText style={styles.titleChipText}>{card.jobTitle.toUpperCase()}</AppText></View>
                <AppText style={styles.code}>{card.assayerCode}</AppText>
              </View>

              {/* Facts */}
              <View style={styles.facts}>
                <View style={styles.fact}><AppText style={styles.factLabel}>VALID UNTIL</AppText><AppText style={styles.factValue}>{fmtDate(card.validTill)}</AppText></View>
                {card.location ? <View style={styles.fact}><AppText style={styles.factLabel}>BASED IN</AppText><AppText style={styles.factValue}>{card.location}</AppText></View> : null}
                {card.department ? <View style={styles.fact}><AppText style={styles.factLabel}>DEPARTMENT</AppText><AppText style={styles.factValue}>{card.department}</AppText></View> : null}
              </View>

              {/* The live proof */}
              <View style={styles.liveBox}>
                <View style={styles.liveRow}>
                  <Animated.View style={[styles.liveDot, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }]} />
                  <AppText style={styles.liveText}>LIVE</AppText>
                  <AppText style={styles.clock}>{clock}</AppText>
                </View>
                {live ? (
                  <>
                    <Image source={{ uri: live.qr }} style={styles.qr} accessibilityLabel={tr('idCard.qrLabel')} />
                    <View accessible accessibilityLabel={`${tr('idCard.codeLabel')} ${live.code.split('').join(' ')}`}>
                      <AppText style={styles.otp}>{live.code.slice(0, 3)} {live.code.slice(3)}</AppText>
                    </View>
                    <View style={styles.bar}><View style={[styles.barFill, { width: `${(secondsLeft / 60) * 100}%` }]} /></View>
                    <AppText style={styles.hint}>{tr('idCard.changesIn', { seconds: secondsLeft })}</AppText>
                    <AppText style={styles.hint}>{tr('idCard.howToCheck', { place: `${verifyHost}/verify` })}</AppText>
                  </>
                ) : (
                  <AppText style={[styles.hint, { paddingVertical: 24 }]}>{liveError ? tr('idCard.offline') : tr('idCard.loadingCode')}</AppText>
                )}
              </View>

              {/* Footer */}
              <View style={styles.footer}>
                <View style={{ flex: 1 }}>
                  {card.helplinePhone ? <AppText style={styles.footText}>{tr('idCard.ifFound', { phone: card.helplinePhone })}</AppText> : null}
                  {card.officeAddress ? <AppText style={styles.footText}>{card.officeAddress}</AppText> : null}
                </View>
                {card.signatoryName ? (
                  <View style={{ alignItems: 'flex-end' }}>
                    <AppText style={[styles.footText, { color: INK, fontWeight: '700' }]}>{card.signatoryName}</AppText>
                    {card.signatoryTitle ? <AppText style={styles.footText}>{card.signatoryTitle}</AppText> : null}
                  </View>
                ) : null}
              </View>
            </View>
          )}
          {screenshotWarned && (
            <AppText style={[styles.hint, { color: GOLD_SOFT, marginTop: 12 }]}>{tr('idCard.screenshotWarning')}</AppText>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: NAVY },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingTop: 36, paddingBottom: 8 },
  scroll: { padding: 16, paddingBottom: 40, alignItems: 'center' },
  panel: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 20, padding: 20, gap: 10, alignItems: 'flex-start' },
  card: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 24, overflow: 'hidden' },
  header: { height: 128, backgroundColor: INDIGO, borderBottomWidth: 3, borderBottomColor: GOLD, padding: 16, flexDirection: 'row', alignItems: 'flex-start', gap: 8, overflow: 'hidden' },
  org: { color: '#fff', fontWeight: '800', fontSize: 13, letterSpacing: 0.8 },
  orgSub: { color: GOLD_SOFT, fontSize: 9, letterSpacing: 2 },
  digitalPill: { borderWidth: 1, borderColor: GOLD_SOFT, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  digitalPillText: { color: GOLD_SOFT, fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  sheen: { position: 'absolute', top: -40, left: 0, width: 60, height: 240, backgroundColor: 'rgba(255,255,255,0.12)' },
  photoRing: { alignSelf: 'center', marginTop: -58, width: 120, height: 120, borderRadius: 60, padding: 4, backgroundColor: GOLD },
  photoInner: { flex: 1, borderRadius: 56, overflow: 'hidden', backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 34, fontWeight: '800', color: INDIGO },
  name: { fontSize: 21, fontWeight: '800', color: NAVY, textAlign: 'center', marginTop: 10 },
  titleChip: { backgroundColor: '#fdf6e3', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 3 },
  titleChipText: { color: '#8a6100', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  code: { fontSize: 14, fontWeight: '700', color: INK, letterSpacing: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  facts: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 18, paddingTop: 14, gap: 12 },
  fact: { minWidth: '44%', flexGrow: 1 },
  factLabel: { fontSize: 9, letterSpacing: 1.2, color: MUTED },
  factValue: { fontSize: 13, fontWeight: '700', color: INK },
  liveBox: { margin: 16, padding: 14, borderRadius: 16, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', alignItems: 'center', gap: 8 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'stretch' },
  liveDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#16a34a' },
  liveText: { fontSize: 11, fontWeight: '800', color: '#16a34a', letterSpacing: 1.5 },
  clock: { marginLeft: 'auto', fontSize: 13, fontWeight: '700', color: INK, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  qr: { width: 190, height: 190 },
  otp: { fontSize: 30, fontWeight: '900', color: NAVY, letterSpacing: 6, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  bar: { alignSelf: 'stretch', height: 4, borderRadius: 2, backgroundColor: '#e2e8f0', overflow: 'hidden' },
  barFill: { height: 4, backgroundColor: GOLD },
  hint: { fontSize: 11, color: MUTED, textAlign: 'center' },
  footer: { backgroundColor: '#f1f5f9', paddingHorizontal: 18, paddingVertical: 10, flexDirection: 'row', gap: 10 },
  footText: { fontSize: 10, color: MUTED },
});

export default IdCardModal;
