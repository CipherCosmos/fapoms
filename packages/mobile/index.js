import { registerRootComponent } from 'expo';

import App from './App';

/**
 * Entry point for every platform.
 *
 * `main` used to point straight at `App.tsx`. Metro resolves that fine because `.tsx` is one
 * of its source extensions, but the contexts that resolve the entry with plain Node semantics
 * cannot see it, and fail with "Cannot resolve entry file". A `.js` entry resolves everywhere.
 */
registerRootComponent(App);
