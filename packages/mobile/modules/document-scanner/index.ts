import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

/** A single captured page, as a `content://` URI produced by ML Kit. */
export interface ScannedPage {
  uri: string;
  pageNumber: number;
}

/** The multi-page PDF ML Kit assembles from the captured pages. */
export interface ScannedPdf {
  uri: string;
  pageCount: number;
}

export interface ScanResult {
  status: 'success' | 'cancel';
  pages: ScannedPage[];
  pdf: ScannedPdf | null;
}

export interface ScanOptions {
  /** Max pages the user may capture. Omit for unlimited. */
  pageLimit?: number;
  /**
   * How much of ML Kit's editor to expose.
   * - `full` — crop, rotate, filters, add/delete page, gallery import (what Drive shows)
   * - `base_with_filter` — capture + filters, no gallery import
   * - `base` — capture only
   */
  scannerMode?: 'full' | 'base_with_filter' | 'base';
  /** Allow importing an existing photo instead of capturing. */
  galleryImportAllowed?: boolean;
  /** Which artifacts to produce. `both` gives per-page JPEGs *and* the assembled PDF. */
  resultFormat?: 'pdf' | 'jpeg' | 'both';
}

const NativeDocumentScanner = requireOptionalNativeModule<{
  scanDocument(options: ScanOptions): Promise<ScanResult>;
}>('FapomsDocumentScanner');

/**
 * Whether the on-device Google scanner is usable here.
 *
 * False on web, on iOS (ML Kit's document scanner is Android-only), and inside Expo Go,
 * which cannot load custom native modules. Callers must branch on this rather than
 * assuming a scanner exists — the previous implementation swallowed the missing-module
 * case in a try/catch and left the user on a black screen with no explanation.
 */
export const isDocumentScannerAvailable = (): boolean =>
  Platform.OS === 'android' && NativeDocumentScanner != null;

const CANCELLED: ScanResult = { status: 'cancel', pages: [], pdf: null };

/**
 * Launches Google's ML Kit document scanner and resolves once the user finishes or backs out.
 *
 * Resolves (never rejects) on cancellation so callers can treat "user changed their mind"
 * as ordinary flow rather than an error path.
 */
export async function scanDocument(options: ScanOptions = {}): Promise<ScanResult> {
  if (!NativeDocumentScanner) return CANCELLED;

  return NativeDocumentScanner.scanDocument({
    scannerMode: 'full',
    galleryImportAllowed: true,
    resultFormat: 'both',
    ...options,
  });
}
