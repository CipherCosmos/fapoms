import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { useI18n } from '../i18n/I18nProvider';
import { LockedGate, PasswordGate, RegistrationGate } from '../screens/GateScreens';
import { LanguageScreen } from '../screens/LanguageScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { MeScreen } from '../screens/MeScreen';
import { MoneyScreen } from '../screens/MoneyScreen';
import { RegisterScreen } from '../screens/RegisterScreen';
import { TodayScreen } from '../screens/TodayScreen';
import { colors } from '../theme/tokens';
import { MAX_FONT_SCALE, type } from '../theme/typography';
import { Icon, Text, type IconName } from '../ui';
import type { RootStackParamList, TabParamList } from './linking';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

const TAB_ICON: Record<keyof TabParamList, [IconName, IconName]> = {
  Today: ['today', 'today-outline'],
  Money: ['wallet', 'wallet-outline'],
  Me: ['person-circle', 'person-circle-outline'],
};

/** Three tabs. No swiping between them (bottom tabs never swipe); icon + word on each. */
const MainTabs: React.FC = () => {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        // Keep each tab mounted once visited, so returning to Today does not refetch or lose scroll.
        lazy: true,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.inkSecondary,
        tabBarStyle: {
          height: 68 + insets.bottom,
          paddingTop: 6,
          paddingBottom: Math.max(insets.bottom, 8),
          backgroundColor: colors.surface,
          borderTopColor: colors.line,
        },
        tabBarIcon: ({ focused, color }) => (
          <Icon name={TAB_ICON[route.name][focused ? 0 : 1]} size={26} rawColor={color} />
        ),
        tabBarLabel: ({ focused, color }) => (
          <Text variant={focused ? 'label' : 'secondary'} style={{ color, fontSize: type.label.fontSize }} maxFontSizeMultiplier={Math.min(MAX_FONT_SCALE, 1.4)}>
            {route.name === 'Today' ? t('tabs.today') : route.name === 'Money' ? t('tabs.money') : t('tabs.me')}
          </Text>
        ),
        tabBarAccessibilityLabel: route.name === 'Today' ? t('tabs.today') : route.name === 'Money' ? t('tabs.money') : t('tabs.me'),
      })}
    >
      <Tabs.Screen name="Today" component={TodayScreen} />
      <Tabs.Screen name="Money" component={MoneyScreen} />
      <Tabs.Screen name="Me" component={MeScreen} />
    </Tabs.Navigator>
  );
};

const Splash: React.FC = () => (
  <View style={styles.splash}>
    <ActivityIndicator size="large" color={colors.accent} />
  </View>
);

/**
 * Which screens exist depends on the state: language not chosen → Language; signed out → Login;
 * a locked / forced-password / registration-only session → its gate; otherwise the tabs. Screens
 * are swapped (not pushed), so Back can never walk from the tabs into the login screen.
 * `Register` is always reachable, for the invite deep link.
 */
export const RootNavigator: React.FC = () => {
  const { ready, needsChoice, t } = useI18n();
  const { isAuthenticated, authenticating, locked, user } = useAuth();

  if (!ready || authenticating) return <Splash />;

  return (
    <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade', contentStyle: { backgroundColor: colors.ground } }}>
      {needsChoice ? (
        <Stack.Screen name="Language" component={LanguageScreen} />
      ) : !isAuthenticated ? (
        <Stack.Screen name="Login" component={LoginScreen} />
      ) : locked ? (
        <Stack.Screen name="Locked" component={LockedGate} />
      ) : user?.mustChangePassword ? (
        <Stack.Screen name="Password" component={PasswordGate} />
      ) : user?.registrationInProgress ? (
        <Stack.Screen name="RegistrationGate" component={RegistrationGate} />
      ) : (
        <Stack.Screen name="Main" component={MainTabs} />
      )}
      <Stack.Screen
        name="Register"
        component={RegisterScreen}
        options={{ headerShown: true, title: t('register.title'), presentation: 'modal', headerTintColor: colors.accent }}
      />
    </Stack.Navigator>
  );
};

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.ground },
});
