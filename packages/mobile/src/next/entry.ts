/**
 * Entry point of the rebuilt app, required by `index.js` only when EXPO_PUBLIC_APP_V2 === '1'.
 *
 * Order matters: the keychain rule is set before anything can read the login, and the background
 * tasks must be DEFINED on every bundle start — including the
 * headless starts the OS makes for a geofence, a background run or a data push, where no screen
 * is ever mounted — so they are imported before the root component is registered.
 */
import { registerRootComponent } from 'expo';
// First: every token read — including a headless start's — uses the new app's keychain rule.
import './secure-store-policy';
import './background/tasks';
import NextApp from './App';

registerRootComponent(NextApp);
