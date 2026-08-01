import { Platform } from 'react-native';
import type { InteractiveMapWeb } from './MapWeb';
import type { InteractiveMapNative } from './MapNative';

// Metro resolves the platform-specific module via file extensions:
//   - web → MapEntry.web.tsx  (Leaflet/OSM, no native deps)
//   - android/ios → MapEntry.native.tsx (react-native-maps)
// This default file exists so TypeScript can type-check the `./MapEntry` import.
export const InteractiveMap: typeof InteractiveMapWeb | typeof InteractiveMapNative =
  Platform.OS === 'web' ? (require('./MapEntry.web').InteractiveMap) : (require('./MapEntry.native').InteractiveMap);
