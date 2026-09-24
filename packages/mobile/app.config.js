/**
 * The rebuilt field app (`src/next`) is a separate BUILD: EXPO_PUBLIC_APP_V2=1 at build time.
 *
 * Everything below that only the new app needs — background location, background runs, silent
 * push, the deep-link scheme and invite links, and its own runtime version — is switched on ONLY
 * for that build, so a build of the current app produces exactly the manifest and Info.plist it
 * always has (no new Play Store background-location declaration, no new iOS prompts).
 */
const APP_V2 = process.env.EXPO_PUBLIC_APP_V2 === '1';

/**
 * iPhone-only values the owner supplies later (IOS-SETUP.md). Each is optional: missing → that
 * feature is off and the build still works. Only consulted for the new app; an Android build
 * reads nothing from them (their only effects are iOS fields and iOS-only plugins).
 */
const { iosFirebase, appleTeamId } = require('./plugins/ios-setup');
const IOS_FIREBASE = APP_V2 ? iosFirebase(__dirname) : { enabled: false };
const APPLE_TEAM_ID = APP_V2 ? appleTeamId() : null;

/** `https://host` of the server this build talks to, for invite links — https only. */
const inviteHost = (() => {
  const m = /^https:\/\/([^/?#:]+)/i.exec(process.env.EXPO_PUBLIC_API_URL || '');
  return m ? m[1].toLowerCase() : null;
})();

module.exports = {
  expo: {
    name: 'Orbit',
    slug: 'fapoms-mobile',
    // The new app carries native modules the current APKs do not (task manager, background task,
    // reanimated, screens…). Its own version — and so its own runtimeVersion below — means an OTA
    // built for one can never be delivered to the other: an update of the new app landing on an
    // old APK would crash on launch.
    version: APP_V2 ? '2.0.0' : '1.0.0',

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
    runtimeVersion: APP_V2 ? '2.0.0' : '1.0.0',
    // Deep links (`com.fapoms.assayer://register/<token>`), new app only.
    ...(APP_V2 ? { scheme: 'com.fapoms.assayer' } : {}),
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
      backgroundColor: '#0A101C',
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
     * (and the app name row) with the brand blue.
     */
    notification: {
      icon: './assets/notification-icon.png',
      color: '#2F7DFF',
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
      // New app, iPhone push via Firebase: only with a valid GOOGLE_SERVICE_INFO_PLIST.
      ...(IOS_FIREBASE.enabled ? { googleServicesFile: IOS_FIREBASE.plistPath } : {}),
      // New app, invite links open the app (universal links): only with APPLE_TEAM_ID and an https
      // server. The server must also publish /.well-known/apple-app-site-association.
      ...(APP_V2 && APPLE_TEAM_ID && inviteHost
        ? { appleTeamId: APPLE_TEAM_ID, associatedDomains: [`applinks:${inviteHost}`] }
        : {}),
      infoPlist: {
        NSCameraUsageDescription:
          'Take photos of your documents and your face photo, and scan audit papers.',
        NSLocationWhenInUseUsageDescription:
          'Orbit requires location access to verify assayer presence at bank audit branches and show navigate routes.',
        NSPhotoLibraryUsageDescription:
          'Orbit requires photo library access to upload expense receipts and audit paperwork.',
        NSFaceIDUsageDescription:
          'Orbit uses Face ID to allow quick biometric sign-in.',
        NSMicrophoneUsageDescription:
          'Orbit uses the microphone for in-app voice calls with the operations desk about audit clarifications.',
        ...(APP_V2
          ? {
              // A silent ("content-available") push may wake the app to refresh a job. Set here
              // rather than through the expo-notifications plugin, whose `mode` would also rewrite
              // the push entitlement. No `location` mode: region monitoring (geofencing) relaunches
              // the app without it, and there is no continuous tracking. `processing` for the
              // background run is added by the expo-background-task plugin below.
              UIBackgroundModes: ['remote-notification'],
            }
          : {}),
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
      ...(APP_V2 && inviteHost
        ? {
            // Invite links (https://<server>/register/<token>) open the app. `autoVerify` makes it
            // an App Link, which Android only honours once the server publishes
            // /.well-known/assetlinks.json for this package and signing key; until then the link
            // opens in the browser as it does today.
            intentFilters: [
              {
                action: 'VIEW',
                autoVerify: true,
                data: [{ scheme: 'https', host: inviteHost, pathPrefix: '/register/' }],
                category: ['BROWSABLE', 'DEFAULT'],
              },
            ],
          }
        : {}),
      config: {
        googleMaps: {
          apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
        },
      },
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        // Matches the mark's own ground colour, and `iconBackground` in colors.xml — the value
        // this bare project actually builds against.
        backgroundColor: '#0A101C',
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
        APP_V2
          ? {
              locationWhenInUsePermission:
                'Orbit uses your location to check you in when you reach the branch for your job.',
              locationAlwaysAndWhenInUsePermission:
                'Orbit checks you in by itself when you reach the branch for today’s job, even when the app is closed. It only watches for today’s branches and does not follow you all day.',
              locationAlwaysPermission:
                'Orbit checks you in by itself when you reach the branch for today’s job, even when the app is closed.',
              // ACCESS_BACKGROUND_LOCATION, for geofencing ("Allow all the time").
              isAndroidBackgroundLocationEnabled: true,
              // Off explicitly: the plugin otherwise turns on a location foreground service with
              // background location, which geofencing does not use and Play would ask us to justify.
              isAndroidForegroundServiceEnabled: false,
              // Off: region monitoring does not need iOS's continuous-location background mode.
              isIosBackgroundLocationEnabled: false,
            }
          : {
              locationWhenInUsePermission:
                'Allow Orbit to use your location to show the route and travel time to your assigned audit branch.',
            },
      ],
      // The OS-scheduled background run (Android WorkManager / iOS BGTaskScheduler), new app only.
      ...(APP_V2 ? ['expo-background-task'] : []),
      // iPhone push via Firebase (new app, only once the plist is supplied). The plugin's Android
      // changes are discarded: Android keeps its existing push path.
      ...(IOS_FIREBASE.enabled ? [['./plugins/withIosOnly', ['@react-native-firebase/app']]] : []),
      // Says which iPhone features are off and why; runs only when an iOS project is generated.
      ...(APP_V2
        ? [
            [
              './plugins/withIosSetupNotice',
              {
                missing: [
                  ...(IOS_FIREBASE.enabled ? [] : [`iPhone push — ${IOS_FIREBASE.problem}`]),
                  ...(APPLE_TEAM_ID ? [] : ['invite links on iPhone (Associated Domains) — APPLE_TEAM_ID is not set']),
                  ...(inviteHost ? [] : ['invite links — EXPO_PUBLIC_API_URL is not an https address']),
                ],
              },
            ],
          ]
        : []),
      /**
       * The plain phone camera, for a registration's face photo (front camera) and for taking a
       * document photo where Google's ML Kit scanner is not there (iOS, or an Android phone
       * without it). Native module, so it needs a new APK — an OTA cannot deliver it.
       * `cameraPermission` is the iOS prompt; it replaces `NSCameraUsageDescription` above, so it
       * covers the audit-sheet use too. Photos and microphone keep the texts set above.
       */
      [
        'expo-image-picker',
        {
          cameraPermission:
            'Take photos of your documents and your face photo, and scan audit papers.',
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
          // React Native Firebase's iOS pods (Swift) need static frameworks. Only in an iPhone build
          // of the new app that actually has Firebase; every other build is unchanged.
          ...(IOS_FIREBASE.enabled ? { ios: { useFrameworks: 'static' } } : {}),
        },
      ],
    ],
    web: {
      favicon: './assets/favicon.png',
      bundler: 'metro',
    },
  },
};
