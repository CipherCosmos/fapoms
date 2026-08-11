import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';

export interface PickedDocumentAsset {
  uri?: string;
  name?: string;
  file?: any;
  mimeType?: string;
}

/**
 * Resolve the base64 payload of a picked document on every platform.
 *
 * expo-file-system v18 ships a no-op shim on web (no readAsStringAsync), so calling the legacy
 * API there throws and the error is invisible because Alert.alert is a no-op on web. On web the
 * document picker already returns a data: URL, so we can slice the base64 out directly and skip
 * FileSystem entirely.
 */
export async function assetToBase64(asset: PickedDocumentAsset): Promise<string> {
  if (Platform.OS === 'web') {
    const uri = asset.uri || '';
    if (uri.startsWith('data:')) {
      const comma = uri.indexOf(',');
      if (comma > 0) return uri.slice(comma + 1);
    }
    if (asset.file) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const comma = result ? result.indexOf(',') : -1;
          resolve(comma > 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(new Error('Failed to read the selected file.'));
        reader.readAsDataURL(asset.file);
      });
    }
    throw new Error('The selected file could not be read.');
  }

  const base64 = await FileSystem.readAsStringAsync(asset.uri || '', {
    encoding: FileSystem.EncodingType.Base64,
  });
  return base64;
}
