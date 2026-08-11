const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

const mobileNodeModules = path.resolve(__dirname, 'node_modules');

const mobileReactPath = path.resolve(mobileNodeModules, 'react');
const mobileReactDOMPath = path.resolve(mobileNodeModules, 'react-dom');
const mobileRNWPath = path.resolve(mobileNodeModules, 'react-native-web');
const mobileJSXRuntimePath = path.resolve(mobileNodeModules, 'react/jsx-runtime.js');
const mobileJSXDevRuntimePath = path.resolve(mobileNodeModules, 'react/jsx-dev-runtime.js');

config.resolver = {
  ...config.resolver,
  nodeModulesPaths: [mobileNodeModules],
  extraNodeModules: {
    'react': mobileReactPath,
    'react-dom': mobileReactDOMPath,
    'react-native-web': mobileRNWPath,
    'react/jsx-runtime': mobileJSXRuntimePath,
    'react/jsx-dev-runtime': mobileJSXDevRuntimePath,
  },
  resolveRequest: (context, moduleName, platform) => {
    // Intercept ANY resolution request for react, react-dom, jsx-runtime, or react-native-web
    // whether requested as package name ("react") or relative path ("../../react/index.js")
    if (moduleName === 'react' || moduleName.endsWith('/react') || moduleName.endsWith('/react/index.js')) {
      return {
        filePath: require.resolve(mobileReactPath),
        type: 'sourceFile',
      };
    }
    if (moduleName === 'react/jsx-runtime' || moduleName.endsWith('/react/jsx-runtime') || moduleName.endsWith('/react/jsx-runtime.js')) {
      return {
        filePath: require.resolve(mobileJSXRuntimePath),
        type: 'sourceFile',
      };
    }
    if (moduleName === 'react/jsx-dev-runtime' || moduleName.endsWith('/react/jsx-dev-runtime') || moduleName.endsWith('/react/jsx-dev-runtime.js')) {
      return {
        filePath: require.resolve(mobileJSXDevRuntimePath),
        type: 'sourceFile',
      };
    }
    if (moduleName === 'react-dom' || moduleName.endsWith('/react-dom') || moduleName.endsWith('/react-dom/index.js')) {
      return {
        filePath: require.resolve(mobileReactDOMPath),
        type: 'sourceFile',
      };
    }
    if (moduleName === 'react-native-web' || moduleName.endsWith('/react-native-web')) {
      return {
        filePath: require.resolve(mobileRNWPath),
        type: 'sourceFile',
      };
    }

    return context.resolveRequest(context, moduleName, platform);
  },
};

module.exports = config;
