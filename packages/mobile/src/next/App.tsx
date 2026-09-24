import 'react-native-gesture-handler';
import React, { useCallback, useEffect, useRef } from 'react';
import { StatusBar, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, createNavigationContainerRef, type LinkingOptions } from '@react-navigation/native';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { MobileApiService, getApiBaseUrl, initApiBaseUrl } from '../services/api.service';
import {
  getLastNotificationResponseAsync,
  registerAndroidNotificationChannels,
  registerForPushNotificationsAsync,
  setupNotificationListeners,
} from '../services/notification.service';
import { loadPreferences } from '../services/preferences';
import { initialIosTap, listenIosPush, registerIosPush } from './background/push-ios';
import { extractPushData, planForPush, type TapTarget } from './background/push-plan';
import { handlePushInBackground } from './background/runtime';
import { registerBackgroundWork, unregisterBackgroundWork } from './background/tasks';
import { I18nProvider } from './i18n/I18nProvider';
import { LINKING_SCREENS, linkingPrefixes, type RootStackParamList } from './nav/linking';
import { RootNavigator } from './nav/RootNavigator';
import { colors } from './theme/tokens';
import { ToastProvider } from './ui';
import { moveLoginToAfterFirstUnlock } from './secure-store-policy';

const navigationRef = createNavigationContainerRef<RootStackParamList>();

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: colors.ground, card: colors.surface, text: colors.ink, primary: colors.accent, border: colors.line },
};

/** Go where a tapped notification points, once the tabs exist. */
function openTarget(target: TapTarget) {
  if (!navigationRef.isReady()) return false;
  const state = navigationRef.getRootState();
  if (!state?.routeNames.includes('Main')) return false;
  const params = target.tab === 'Today' ? { assignmentId: target.assignmentId, queryId: target.queryId } : undefined;
  navigationRef.navigate('Main', { screen: target.tab, params } as never);
  return true;
}

/**
 * Session-scoped wiring: while someone is signed in, the background work is registered and push is
 * on; on sign-out it is all taken down. Notification taps land on the job they are about, including
 * the tap that cold-started the app.
 */
const SessionEffects: React.FC = () => {
  const { isAuthenticated, user, locked } = useAuth();
  const pending = useRef<TapTarget | null>(null);
  const ready = isAuthenticated && !locked && !user?.mustChangePassword && !user?.registrationInProgress;

  useEffect(() => {
    if (isAuthenticated) {
      registerAndroidNotificationChannels();
      void registerBackgroundWork();
      // Android: the existing path (expo device token). On iPhone it only asks the notification
      // permission (local arrival notices need it) and returns without a token.
      void registerForPushNotificationsAsync().then(() => registerIosPush());
    } else {
      void unregisterBackgroundWork();
    }
  }, [isAuthenticated]);

  const handleTap = useCallback((response: any) => {
    const plan = planForPush(extractPushData(response?.notification?.request?.content?.data ?? response));
    if (plan.silent) return;
    if (plan.notificationId) void MobileApiService.markNotificationRead(plan.notificationId).catch(() => undefined);
    if (!openTarget(plan.target)) pending.current = plan.target;
  }, []);

  useEffect(() => setupNotificationListeners(undefined, handleTap), [handleTap]);
  useEffect(() => {
    void getLastNotificationResponseAsync().then((r) => {
      if (r) handleTap(r);
    });
    void initialIosTap().then((data) => {
      if (data) handleTap(data);
    });
  }, [handleTap]);

  // iPhone (Firebase): a push while the app is open refreshes; a tap on one opens its job.
  useEffect(
    () =>
      listenIosPush({
        onData: (data) => void handlePushInBackground(data).catch(() => undefined),
        onTap: handleTap,
      }),
    [handleTap],
  );

  // A tap that arrived before the tabs existed (cold start, lock screen) is replayed once they do.
  useEffect(() => {
    if (!ready || !pending.current) return;
    const target = pending.current;
    const id = setTimeout(() => {
      if (openTarget(target)) pending.current = null;
    }, 0);
    return () => clearTimeout(id);
  }, [ready]);

  return null;
};

/**
 * The rebuilt field app. Loaded only when the build was made with EXPO_PUBLIC_APP_V2=1
 * (see index.js); the current app is untouched otherwise.
 */
export default function NextApp(): React.ReactElement {
  const [booted, setBooted] = React.useState(false);

  useEffect(() => {
    // Same boot order as the current app: server address and device preferences before the
    // session is restored (AuthProvider restores on mount, so it renders only after this).
    // The login move runs before AuthProvider restores the session, so the restore reads it from
    // its new place.
    void Promise.all([
      initApiBaseUrl().catch(() => undefined),
      loadPreferences().catch(() => undefined),
      moveLoginToAfterFirstUnlock(),
    ]).then(() => setBooted(true));
  }, []);

  const linking: LinkingOptions<RootStackParamList> = {
    prefixes: linkingPrefixes(getApiBaseUrl()),
    config: LINKING_SCREENS as unknown as LinkingOptions<RootStackParamList>['config'],
  };

  return (
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" backgroundColor="transparent" translucent />
        <I18nProvider>
          <ToastProvider>
            {booted ? (
              <AuthProvider>
                <NavigationContainer ref={navigationRef} theme={theme} linking={linking}>
                  <SessionEffects />
                  <RootNavigator />
                </NavigationContainer>
              </AuthProvider>
            ) : null}
          </ToastProvider>
        </I18nProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: colors.ground } });
