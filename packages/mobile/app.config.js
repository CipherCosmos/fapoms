module.exports = {
  expo: {
    name: 'FAPOMS Assayer App',
    slug: 'fapoms-mobile',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'dark',
    assetBundlePatterns: ['**/*'],
    extra: {
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.fapoms.mobile',
      googleServicesFile: './GoogleService-Info.plist',
    },
    android: {
      package: 'com.fapoms.mobile',
      googleServicesFile: './google-services.json',
      config: {
        googleMaps: {
          apiKey: process.env.GOOGLE_MAPS_API_KEY || '',
        },
      },
      adaptiveIcon: {
        backgroundColor: '#0f172a',
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
    ],
    web: {
      favicon: './assets/favicon.png',
    },
  },
};
