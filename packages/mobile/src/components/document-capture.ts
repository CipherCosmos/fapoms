import * as DocumentPicker from 'expo-document-picker';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type * as ImagePickerModule from 'expo-image-picker';
import {
  SCAN_UPLOAD_IMAGE_ACCEPT, SCAN_UPLOAD_MIME_TYPES, scanFileName, scanMimeType, uploadSizeProblem,
} from '@fapoms/shared';
import { isDocumentScannerAvailable, scanDocument } from '../../modules/document-scanner';
import { scanPlanFor } from './document-scan-options';
import { DOCUMENT_CAMERA, FACE_PHOTO_CAMERA, type CaptureKind } from '../screens/self-registration/document-rows';

/**
 * TAKING A DOCUMENT OR A FACE PHOTO, WITH NO SCREEN IN BETWEEN.
 *
 * One tap on a registration row goes straight to the camera, and what comes back is uploaded. The
 * old flow stopped on a "Save document" screen with a file-name box — a question nobody filling in
 * a form can answer usefully, asked after every single photo. The name now comes from
 * `scanFileName` (the document's own label), exactly as the browser names its scans.
 *
 * Three doors, chosen per row by `capturePlanFor`:
 *  - ML Kit's document scanner (Android) for papers: edges, straightening and cleanup on-device.
 *  - expo-image-picker's camera for the face photo (front camera, passport crop) and for papers on
 *    a phone without ML Kit (iOS).
 *  - The file picker, always offered as "or choose file".
 */

export interface CapturedFile {
  uri: string;
  name: string;
  mimeType: string;
}

export type CaptureOutcome =
  | { status: 'captured'; files: CapturedFile[] }
  | { status: 'cancelled' }
  /** The camera permission was refused — offer Settings and the file picker instead. */
  | { status: 'cameraDenied' }
  /** A plain-English sentence to show under the row. */
  | { status: 'refused'; message: string }
  | { status: 'failed'; message?: string };

/**
 * expo-image-picker, or null in a build without its native half.
 *
 * The package throws at import when its native module is missing, and an installed APK from before
 * it was added does not have it. Asking first keeps that phone working on the scanner and the file
 * picker instead of crashing the registration screen.
 */
function imagePicker(): typeof ImagePickerModule | null {
  if (!requireOptionalNativeModule('ExponentImagePicker')) return null;
  try {
    return require('expo-image-picker') as typeof ImagePickerModule;
  } catch {
    return null;
  }
}

export const isCameraAvailable = (): boolean => imagePicker() !== null;
export { isDocumentScannerAvailable };

const extensionOf = (name: string | null | undefined, mimeType: string | null | undefined): string => {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(name ?? '')?.[1]?.toLowerCase();
  if (fromName) return fromName === 'jpeg' ? 'jpg' : fromName;
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/heic') return 'heic';
  return 'jpg';
};

function named(label: string, uri: string, sourceName: string | null | undefined, mime: string | null | undefined, page?: number): CapturedFile {
  const ext = extensionOf(sourceName, mime);
  const name = scanFileName(label, ext, new Date(), page);
  return { uri, name, mimeType: mime || scanMimeType(name) || 'application/octet-stream' };
}

/** Refused before the upload starts, in the same sentence the browser uses. */
function sizeRefusal(assets: Array<{ name?: string | null; fileName?: string | null; size?: number; fileSize?: number }>): string | null {
  for (const a of assets) {
    const size = a.size ?? a.fileSize;
    if (!size) continue;
    const problem = uploadSizeProblem({ name: a.name ?? a.fileName ?? 'file', size });
    if (problem) return problem;
  }
  return null;
}

async function withScanner(requirement: string, label: string): Promise<CaptureOutcome> {
  const result = await scanDocument(scanPlanFor(requirement).options);
  if (result.status !== 'success' || result.pages.length === 0) return { status: 'cancelled' };
  // One PDF of every page when ML Kit assembled one; the single page's picture otherwise.
  if (result.pdf?.uri) return { status: 'captured', files: [named(label, result.pdf.uri, null, 'application/pdf')] };
  return { status: 'captured', files: [named(label, result.pages[0].uri, null, 'image/jpeg')] };
}

async function withCamera(label: string, face: boolean): Promise<CaptureOutcome> {
  const picker = imagePicker();
  if (!picker) return { status: 'failed' };
  const permission = await picker.requestCameraPermissionsAsync();
  if (!permission.granted) return { status: 'cameraDenied' };
  const settings = face ? FACE_PHOTO_CAMERA : DOCUMENT_CAMERA;
  const result = await picker.launchCameraAsync({
    mediaTypes: ['images'],
    cameraType: face ? picker.CameraType.front : picker.CameraType.back,
    allowsEditing: settings.allowsEditing,
    ...(face ? { aspect: FACE_PHOTO_CAMERA.aspect } : {}),
    quality: settings.quality,
  });
  if (result.canceled || !result.assets?.length) return { status: 'cancelled' };
  const tooBig = sizeRefusal(result.assets);
  if (tooBig) return { status: 'refused', message: tooBig };
  const a = result.assets[0];
  return { status: 'captured', files: [named(label, a.uri, a.fileName, a.mimeType ?? 'image/jpeg')] };
}

/** The big "Take photo" button, whichever camera the row's plan names. */
export async function captureWith(kind: CaptureKind, requirement: string, label: string): Promise<CaptureOutcome> {
  try {
    if (kind === 'scanner') return await withScanner(requirement, label);
    if (kind === 'faceCamera') return await withCamera(label, true);
    if (kind === 'camera') return await withCamera(label, false);
    return await chooseFiles(label, { multiple: false, imagesOnly: false });
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : undefined };
  }
}

/** "or choose file": any accepted file, several only when the document has pages. */
export async function chooseFiles(label: string, opts: { multiple: boolean; imagesOnly: boolean }): Promise<CaptureOutcome> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      // The server's own accept-list — the same one the browser's picker offers.
      type: opts.imagesOnly ? SCAN_UPLOAD_IMAGE_ACCEPT.split(',') : SCAN_UPLOAD_MIME_TYPES,
      copyToCacheDirectory: true,
      multiple: opts.multiple,
    });
    if (result.canceled || !result.assets?.length) return { status: 'cancelled' };
    const assets = opts.multiple ? result.assets : result.assets.slice(0, 1);
    const tooBig = sizeRefusal(assets);
    if (tooBig) return { status: 'refused', message: tooBig };
    return {
      status: 'captured',
      files: assets.map((a, i) => named(label, a.uri, a.name, a.mimeType, assets.length > 1 ? i + 1 : undefined)),
    };
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : undefined };
  }
}

/** "or choose from gallery" for the face photo — the same passport crop as the camera. */
export async function chooseFromGallery(label: string): Promise<CaptureOutcome> {
  const picker = imagePicker();
  if (!picker) return chooseFiles(label, { multiple: false, imagesOnly: true });
  try {
    const result = await picker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: FACE_PHOTO_CAMERA.aspect,
      quality: FACE_PHOTO_CAMERA.quality,
    });
    if (result.canceled || !result.assets?.length) return { status: 'cancelled' };
    const tooBig = sizeRefusal(result.assets);
    if (tooBig) return { status: 'refused', message: tooBig };
    const a = result.assets[0];
    return { status: 'captured', files: [named(label, a.uri, a.fileName, a.mimeType ?? 'image/jpeg')] };
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : undefined };
  }
}
