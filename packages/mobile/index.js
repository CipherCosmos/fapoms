import { registerRootComponent } from 'expo';

/**
 * Entry point for every platform.
 *
 * `main` used to point straight at `App.tsx`. Metro resolves that fine because `.tsx` is one
 * of its source extensions, but the contexts that resolve the entry with plain Node semantics
 * cannot see it, and fail with "Cannot resolve entry file". A `.js` entry resolves everywhere.
 *
 * Two apps, chosen at BUILD time:
 *
 *  - EXPO_PUBLIC_APP_V2=1 → the rebuilt field app (`src/next`). Its entry defines the background
 *    tasks (geofence, background sync, data push) before registering the root, because the OS can
 *    start the bundle with no screen to run them.
 *  - anything else → the current app, exactly as before.
 *
 * `EXPO_PUBLIC_*` is inlined as a literal when the bundle is built, so a production bundle drops
 * the branch it will never take — the current app's bundle carries none of the new app's modules,
 * and an installed APK that receives an OTA of the current app never evaluates them. Both branches
 * use `require`, not `import`: an `import` is hoisted and would load both apps.
 */
if (process.env.EXPO_PUBLIC_APP_V2 === '1') {
  require('./src/next/entry');
} else {
  // Same evaluation order as before this switch existed: the calls module, then App, then the
  // calling set-up, then the root.
  const { initializeCalling } = require('./src/services/calls');
  const App = require('./App').default;
  /**
   * WebRTC globals must exist before anything constructs a LiveKit Room, so this runs at the
   * entry point. It is crash-safe by design: in Expo Go (no native module) it fails quietly,
   * `callingAvailable` stays false, and the app runs exactly as before with calling hidden.
   */
  initializeCalling();
  registerRootComponent(App);
}
