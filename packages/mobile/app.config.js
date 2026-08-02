module.exports = {
  expo: {
    name: 'FAPOMS Field Assayer',
    slug: 'fapoms-mobile',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    icon: './assets/icon.png',
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#0A101C',
    },
    assetBundlePatterns: ['**/*'],
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
          'FAPOMS requires camera access to scan gold audit sheets and capture document evidence.',
        NSLocationWhenInUseUsageDescription:
          'FAPOMS requires location access to verify assayer presence at bank audit branches and show navigate routes.',
        NSPhotoLibraryUsageDescription:
          'FAPOMS requires photo library access to upload expense receipts and audit paperwork.',
        NSFaceIDUsageDescription:
          'FAPOMS uses Face ID to allow quick biometric sign-in.',
      },
    },
    android: {
      package: 'com.fapoms.assayer',
      versionCode: 1,
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
        backgroundColor: '#0A101C',
      },
    },
    plugins: [
      [
        'expo-location',
        {
          locationWhenInUsePermission:
            'Allow FAPOMS to use your location to show the route and travel time to your assigned audit branch.',
        },
      ],
      [
        'expo-document-picker',
        {
          iOSEnterpriseDevelopment: true,
        },
      ],
    ],
    web: {
      favicon: './assets/favicon.png',
      bundler: 'metro',
    },
  },
};
