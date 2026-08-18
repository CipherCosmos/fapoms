module.exports = {
  expo: {
    name: 'Orbit',
    slug: 'fapoms-mobile',
    version: '1.0.0',

    /**
     * Over-the-air updates, so a fix reaches a field assayer without an APK reinstall.
     *
     * `runtimeVersion` is the contract between a shipped APK and the updates it may accept. The
     * `appVersion` policy ties it to `version` above, which is exactly the safety property you
     * want: an OTA payload is JavaScript and assets, and pushing JS that calls a native module
     * the installed binary does not contain crashes the app on launch with no way back. Bumping
     * `version` marks a build as native-incompatible, so older installs simply stop being offered
     * updates instead of being broken by one.
     *
     * What OTA CAN change: screens, logic, styling, images, the default backend URL.
     * What it CANNOT: new native modules, permissions, an Expo SDK upgrade. Those need a new APK.
     *
     * `fallbackToCacheTimeout: 0` means launch never blocks on the network — the app starts on
     * the bundle it has and fetches in the background, which matters on a handset in the field
     * with poor signal. The update applies on the NEXT launch.
     *
     * Written as a literal rather than `{ policy: 'appVersion' }`, because this project keeps its
     * native `android/` directory in the repo — the bare workflow — and there the policy is not
     * evaluated. Both `expo start` and `eas update` stop with "runtime version policies are not
     * supported", so a dev client could not load the app at all and no OTA update could be
     * published: the very feature this block exists for. Prebuild had already resolved it to the
     * literal "1.0.0" in `android/app/src/main/res/values/strings.xml`, so the shipped binary was
     * unaffected and the breakage was invisible until someone ran the tooling.
     *
     * Keep this in step with `version` above — bumping one without the other is what the policy
     * was there to prevent.
     */
    runtimeVersion: '1.0.0',
    updates: {
      fallbackToCacheTimeout: 0,
      url: `https://u.expo.dev/${
        process.env.EAS_PROJECT_ID || '05ed5767-ce2f-4872-be1e-5509682f33fe'
      }`,
      /**
       * Which stream this build follows.
       *
       * `eas build` injects the channel from eas.json by itself. A LOCAL gradle build does not,
       * and without it the app asks for updates on no channel and silently never receives any —
       * a build that looks fine and is simply never updatable. Set EXPO_UPDATE_CHANNEL when
       * building locally; see BUILD-APK.md.
       */
      ...(process.env.EXPO_UPDATE_CHANNEL
        ? { requestHeaders: { 'expo-channel-name': process.env.EXPO_UPDATE_CHANNEL } }
        : {}),
    },
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    icon: './assets/icon.png',
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#0E1016',
    },
    assetBundlePatterns: ['**/*'],
    /**
     * Draw behind the system bars.
     *
     * The status bar was painted a fixed `#131017`, so the app stopped at a solid dark strip
     * instead of filling the screen — and in light theme that strip did not match the page
     * underneath it either. Transparent and translucent lets content run edge to edge; the
     * top bar already reserves `StatusBar.currentHeight` so nothing sits under the clock.
     */
    androidStatusBar: {
      translucent: true,
      backgroundColor: '#00000000',
    },
    androidNavigationBar: {
      barStyle: 'light-content',
    },
    /**
     * Status-bar/push icon. Android renders the small icon as a pure silhouette — a
     * full-colour launcher icon there degrades to a grey blob, which is what field
     * phones showed. This is a white orbit glyph on transparency; `color` tints it
     * (and the app name row) with the brand violet.
     */
    notification: {
      icon: './assets/notification-icon.png',
      color: '#8B7CFF',
    },
    extra: {
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
      apiUrl: process.env.EXPO_PUBLIC_API_URL || '',
      /**
       * The EAS project this app publishes updates to: @deepstacker/fapoms-mobile.
       *
       * Hardcoded rather than env-only because a build that silently lacks it produces an APK
       * with no update URL — one that looks fine, installs fine, and can never receive an OTA
       * update. Not a secret; it appears in the project's own public URL. EAS_PROJECT_ID still
       * overrides it, for anyone publishing to a different project.
       */
      eas: { projectId: process.env.EAS_PROJECT_ID || '05ed5767-ce2f-4872-be1e-5509682f33fe' },
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.fapoms.assayer',
      buildNumber: '1',
      infoPlist: {
        NSCameraUsageDescription:
          'Orbit requires camera access to scan gold audit sheets and capture document evidence.',
        NSLocationWhenInUseUsageDescription:
          'Orbit requires location access to verify assayer presence at bank audit branches and show navigate routes.',
        NSPhotoLibraryUsageDescription:
          'Orbit requires photo library access to upload expense receipts and audit paperwork.',
        NSFaceIDUsageDescription:
          'Orbit uses Face ID to allow quick biometric sign-in.',
        NSMicrophoneUsageDescription:
          'Orbit uses the microphone for in-app voice calls with the operations desk about audit clarifications.',
      },
    },
    android: {
      package: 'com.fapoms.assayer',
      // No `versionCode` here, on purpose. eas.json sets `appVersionSource: "remote"`, so EAS
      // owns that counter and increments it on every build — a value typed here is IGNORED by
      // EAS (it says so at every build) yet still lands in the manifest expo-constants exposes,
      // so it sat at 4 while real builds moved on: a number that looked authoritative and was
      // wrong. Android refuses to install a lower versionCode over a higher one, which is why
      // the counter must be owned by exactly one place. The number a screen shows comes from
      // the running binary (`expo-application`, see utils/appVersion.ts), never from here.
      // The file itself is gitignored (it's a real credential, not a placeholder) and only
      // ever existed on whichever machine ran the local `./gradlew assembleRelease` build.
      // EAS Build's cloud workers only see what git tracks, so a cloud build had no way to
      // know which Firebase project to register push against — `getDevicePushTokenAsync()`
      // would either fail or register against nothing. `GOOGLE_SERVICES_JSON` is an EAS file
      // secret; EAS downloads it to a temp path on the build worker and exposes that path
      // through this env var. Local builds still fall back to the file sitting right here.
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON || './google-services.json',
      permissions: [
        'CAMERA',
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
        'READ_EXTERNAL_STORAGE',
        'WRITE_EXTERNAL_STORAGE',
        'USE_BIOMETRIC',
        'USE_FINGERPRINT',
        'VIBRATE',
        'NOTIFICATIONS',
        // In-app voice calling (LiveKit/WebRTC): capture the mic, route audio to the
        // earpiece/speaker, and reach Bluetooth headsets on Android 12+.
        'RECORD_AUDIO',
        'BLUETOOTH_CONNECT',
        'MODIFY_AUDIO_SETTINGS',
      ],
      config: {
        googleMaps: {
          apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
        },
      },
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        // Matches the flame artwork's own background, and `iconBackground` in colors.xml —
        // the value this bare project actually builds against.
        backgroundColor: '#0E1016',
      },
    },
    plugins: [
      // Keeps release APKs off React Native's shared debug signing key. Must be a plugin, not an
      // edit to android/app/build.gradle — that directory is a gitignored prebuild artifact.
      './plugins/withReleaseSigning',
      // Wires @livekit/react-native + react-native-webrtc into the native build (audio-mode
      // service config, required Android/iOS project tweaks). Native builds only — Expo Go
      // ignores config plugins, where calls.ts detects the missing module and disables calling.
      '@livekit/react-native-expo-plugin',
      [
        'expo-location',
        {
          locationWhenInUsePermission:
            'Allow Karat to use your location to show the route and travel time to your assigned audit branch.',
        },
      ],
      [
        'expo-document-picker',
        {
          iOSEnterpriseDevelopment: true,
        },
      ],
      // Auth tokens live in the OS keystore (Android Keychain / iOS Keychain) rather than
      // in a plain file. Session state previously went through `globalThis.localStorage`,
      // which does not exist in React Native — so nothing persisted at all.
      'expo-secure-store',
      [
        /**
         * Release builds ship minified and shrunk.
         *
         * Proguard was off, so the release APK carried the full unminified Java/Kotlin
         * surface. The bigger win is architecture: a universal APK bundles native libs for
         * four ABIs (~106 MB of the 125 MB debug build), and 59 MB of that is x86/x86_64 —
         * emulator-only, dead weight on every real handset. Production builds an AAB so Play
         * splits per device, but the `preview` APK that gets sideloaded to field devices does
         * not, which is exactly the build an assayer on a cheap phone receives.
         *
         * Resource shrinking is deliberately OFF. React Native packages bundled assets into
         * `res/raw`, where the only thing referencing them is JavaScript at runtime — the
         * shrinker cannot see that, so it judged them unused and stripped them. It removed
         * every font from the release APK, and since all iconography is Ionicons glyphs, the
         * shipped build had no icons anywhere while debug looked fine. It saved a few hundred
         * KB against a 55 MB APK whose bulk is native libraries.
         */
        'expo-build-properties',
        {
          android: {
            enableProguardInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: false,
          },
        },
      ],
    ],
    web: {
      favicon: './assets/favicon.png',
      bundler: 'metro',
    },
  },
};
