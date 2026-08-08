module.exports = {
  expo: {
    name: 'Karat',
    slug: 'fapoms-mobile',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    icon: './assets/icon.png',
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#14100C',
    },
    assetBundlePatterns: ['**/*'],
    /**
     * Draw behind the system bars.
     *
     * The status bar was painted a fixed `#14100C`, so the app stopped at a solid dark strip
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
    extra: {
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
      apiUrl: process.env.EXPO_PUBLIC_API_URL || '',
      ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.fapoms.assayer',
      buildNumber: '1',
      infoPlist: {
        NSCameraUsageDescription:
          'Karat requires camera access to scan gold audit sheets and capture document evidence.',
        NSLocationWhenInUseUsageDescription:
          'Karat requires location access to verify assayer presence at bank audit branches and show navigate routes.',
        NSPhotoLibraryUsageDescription:
          'Karat requires photo library access to upload expense receipts and audit paperwork.',
        NSFaceIDUsageDescription:
          'Karat uses Face ID to allow quick biometric sign-in.',
      },
    },
    android: {
      package: 'com.fapoms.assayer',
      versionCode: 1,
      // Present in the repo but never wired in — without this, a native build has no way to
      // know which Firebase project to register push against, so `getDevicePushTokenAsync()`
      // would either fail or register against nothing at all.
      googleServicesFile: './google-services.json',
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
      ],
      config: {
        googleMaps: {
          apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
        },
      },
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#14100C',
      },
    },
    plugins: [
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
