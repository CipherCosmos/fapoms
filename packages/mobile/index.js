import { registerRootComponent } from 'expo';

import { initializeCalling } from './src/services/calls';

import App from './App';

/**
 * WebRTC globals must exist before anything constructs a LiveKit Room, so this runs at the
 * entry point. It is crash-safe by design: in Expo Go (no native module) it fails quietly,
 * `callingAvailable` stays false, and the app runs exactly as before with calling hidden.
 */
initializeCalling();

/**
 * Entry point for every platform.
 *
 * `main` used to point straight at `App.tsx`. Metro resolves that fine because `.tsx` is one
 * of its source extensions, but the contexts that resolve the entry with plain Node semantics
 * cannot see it, and fail with "Cannot resolve entry file". A `.js` entry resolves everywhere.
 */
registerRootComponent(App);
