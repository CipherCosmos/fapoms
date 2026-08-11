import React from 'react';
import { Platform } from 'react-native';
import { InteractiveMapNative } from './MapNative';
import { InteractiveMapWeb, MapRenderProps } from './MapWeb';

export const InteractiveMap: React.FC<MapRenderProps> = (props) => {
  if (Platform.OS === 'web') {
    return <InteractiveMapWeb {...props} />;
  }
  return <InteractiveMapNative {...props} />;
};
