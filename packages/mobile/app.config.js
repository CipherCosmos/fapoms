module.exports = {
  expo: {
    name: 'FAPOMS Assayer App',
    slug: 'fapoms-mobile',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'dark',
    assetBundlePatterns: ['**/*'],
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.fapoms.mobile',
      googleServicesFile: './GoogleService-Info.plist',
    },
    android: {
      package: 'com.fapoms.mobile',
      googleServicesFile: './google-services.json',
      adaptiveIcon: {
        backgroundColor: '#0f172a',
      },
    },
    web: {
      favicon: './assets/favicon.png',
    },
  },
};
