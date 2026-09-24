/**
 * Which native modules are linked into which build.
 *
 * React Native Firebase is ONLY for the rebuilt app on iPhone (EXPO_PUBLIC_APP_V2=1), and only once
 * GOOGLE_SERVICE_INFO_PLIST is supplied: it bridges Apple's push service to Firebase, which the
 * server sends through. It is never linked into:
 *  - Android builds of either app — Android keeps the existing push path (expo-notifications'
 *    device token → Firebase Admin), and a second Firebase SDK there would compete for the same
 *    messages;
 *  - iPhone builds of the current app — so its native project is exactly what it was.
 *
 * Read by the autolinking step of every native build (Gradle settings / CocoaPods), with the
 * build's environment, so the same env var that picks the app picks what is linked.
 *
 * The navigation / animation modules the new app needs (screens, safe-area, gesture handler,
 * reanimated) are likewise linked only into new-app builds, so a new build of the current app
 * carries the same community native modules it always did. (Expo modules — task manager,
 * background task, font, linking — are linked by Expo's own autolinking, which cannot be switched
 * per build; nothing in the current app loads them.)
 */
const { iosFirebase } = require('./plugins/ios-setup');

const APP_V2 = process.env.EXPO_PUBLIC_APP_V2 === '1';
// Linked only when the iPhone build was given a valid GoogleService-Info.plist (IOS-SETUP.md);
// without it iPhone push is simply off and the build does not need the Firebase pods.
const FIREBASE_ON_IOS = APP_V2 && iosFirebase(__dirname).enabled;

const iosOnlyInNewApp = { platforms: { android: null, ...(FIREBASE_ON_IOS ? {} : { ios: null }) } };
const onlyInNewApp = APP_V2 ? {} : { platforms: { android: null, ios: null } };

module.exports = {
  dependencies: {
    '@react-native-firebase/app': iosOnlyInNewApp,
    '@react-native-firebase/messaging': iosOnlyInNewApp,
    'react-native-screens': onlyInNewApp,
    'react-native-safe-area-context': onlyInNewApp,
    'react-native-gesture-handler': onlyInNewApp,
    'react-native-reanimated': onlyInNewApp,
  },
};
