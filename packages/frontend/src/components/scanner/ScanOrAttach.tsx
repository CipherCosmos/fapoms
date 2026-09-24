import React, { useState } from 'react';
import { Camera, Paperclip } from 'lucide-react';
import { SCAN_UPLOAD_ACCEPT, scanFileName, scanProfileFor } from '@fapoms/shared';
import { DocumentScanner } from './DocumentScanner';
import { blobBytes, jpegPagesToPdf } from './jpeg-pages-to-pdf';

/**
 * TWO WAYS TO PUT A PAPER DOCUMENT ON A RECORD, OFFERED TOGETHER EVERYWHERE.
 *
 * "Scan" opens the camera and hands back a flattened, cleaned-up JPEG of the document.
 * "Choose file" is the file picker that has always been here, unchanged — a PDF from a flatbed at
 * the desk, a photo already in the gallery, a scan somebody emailed in.
 *
 * ONE CONTROL, so the two cannot drift: the accept-list is the shared one both the picker and the
 * server's guard are built from, the size rule is checked once, and every surface gets the camera
 * the day it adopts this rather than three surfaces growing three different scan buttons.
 *
 * The scan button is not rendered at all where `getUserMedia` does not exist — an old browser, or
 * any page served over plain HTTP, where the camera is unavailable by specification rather than by
 * choice. A dead button that explains itself only after being pressed is worse than no button.
 */

export interface ScanOrAttachProps {
  /** What is being attached — titles the scanner and names the produced file. */
  documentLabel: string;
  /**
   * WHICH document this is (`OnboardingDocument`), which is how the scanner knows to draw a card
   * outline for a PAN and an A4 one for a joining form, which finish to start on, and whether to
   * expect a second page. An unrecognised or absent requirement falls back to no expected shape,
   * which is the scanner exactly as it behaved before any of this.
   */
  requirement?: string | null;
  /** Called with everything chosen or scanned. Several files only when `multiple`. */
  onFiles: (files: File[]) => void;
  /**
   * Whether the FILE PICKER takes several files at once. The scanner's own page count comes from
   * the document's profile, not from here — a PAN card is one page however this is set.
   */
  multiple?: boolean;
  disabled?: boolean;
  /** Overrides the picker's wording once something is already on file. */
  attachLabel?: string;
  /** The picker's accept-list, for the few surfaces that take a narrower set than the default. */
  accept?: string;
  size?: 'sm' | 'md';
  /**
   * How the two doors are drawn.
   *
   * `pair` (the default, and what every HR screen uses) is two equal buttons side by side. `primary`
   * is for somebody on a phone with the paper in their hand — the candidate's own form: one large
   * camera button, and the file picker as a small "or choose file" link under it.
   */
  variant?: 'pair' | 'primary';
  /** The camera button's words. "Scan" by default; the candidate form says "Take photo" / "Retake". */
  scanLabel?: string;
  /**
   * Hand a multi-page scan back as ONE PDF rather than one JPEG per page.
   *
   * For a surface that keeps one file per document: it used to take the first page and silently
   * drop the rest. A single-page scan stays the JPEG it was.
   */
  combinePages?: boolean;
}

/** A multi-page scan as one PDF, named for the document. Single pages pass through untouched. */
export async function combineScannedPages(files: File[], documentLabel: string): Promise<File[]> {
  if (files.length < 2 || !files.every((f) => f.type === 'image/jpeg')) return files;
  const pages = await Promise.all(files.map((f) => blobBytes(f)));
  const pdf = jpegPagesToPdf(pages);
  return [new File([pdf as BlobPart], scanFileName(documentLabel, 'pdf', new Date()), { type: 'application/pdf' })];
}

export function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export const ScanOrAttach: React.FC<ScanOrAttachProps> = ({
  documentLabel, requirement, onFiles, multiple = false, disabled = false,
  attachLabel = 'Choose file', accept = SCAN_UPLOAD_ACCEPT, size = 'md',
  variant = 'pair', scanLabel, combinePages = false,
}) => {
  const [scanning, setScanning] = useState(false);
  const profile = scanProfileFor(requirement);

  const handleScanned = (files: File[]) => {
    setScanning(false);
    if (!combinePages) { onFiles(files); return; }
    void combineScannedPages(files, documentLabel)
      // A PDF that could not be built is no reason to lose the scan: send the pages as they are.
      .catch(() => files)
      .then(onFiles);
  };

  const picker = (
    <input
      type="file"
      accept={accept}
      multiple={multiple}
      disabled={disabled}
      style={{ display: 'none' }}
      onChange={(e) => {
        const chosen = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (chosen.length) onFiles(chosen);
      }}
    />
  );

  const scanner = scanning && (
    <DocumentScanner
      documentLabel={documentLabel}
      profile={profile}
      onCancel={() => setScanning(false)}
      onScanned={handleScanned}
    />
  );

  if (variant === 'primary') {
    const big: React.CSSProperties = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
      minHeight: '48px', padding: '12px 20px', fontSize: 'var(--text-sm)', fontWeight: 600, margin: 0,
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
    };
    const link: React.CSSProperties = {
      fontSize: 'var(--text-xs)', color: 'var(--accent)', textDecoration: 'underline',
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1, fontWeight: 600,
    };
    const hasCamera = cameraAvailable();
    return (
      <>
        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
          {hasCamera ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                style={big}
                disabled={disabled}
                onClick={() => setScanning(true)}
              >
                <Camera size={18} /> {scanLabel ?? 'Take photo'}
              </button>
              <label style={link}>
                or {attachLabel.charAt(0).toLowerCase()}{attachLabel.slice(1)}
                {picker}
              </label>
            </>
          ) : (
            // No camera to offer — the picker becomes the one big button rather than a small link.
            <label className="btn btn-primary" style={big}>
              <Paperclip size={16} /> {attachLabel}
              {picker}
            </label>
          )}
        </div>
        {scanner}
      </>
    );
  }

  const padding = size === 'sm' ? '5px 9px' : '9px 14px';
  const fontSize = size === 'sm' ? 'var(--text-2xs)' : 'var(--text-xs)';
  const shared: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    padding, fontSize, margin: 0,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
  };

  return (
    <>
      <div style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap' }}>
        {cameraAvailable() && (
          <button
            type="button"
            className="btn btn-secondary"
            style={shared}
            disabled={disabled}
            onClick={() => setScanning(true)}
          >
            <Camera size={size === 'sm' ? 12 : 14} /> {scanLabel ?? 'Scan'}
          </button>
        )}
        <label className="btn btn-secondary" style={shared}>
          <Paperclip size={size === 'sm' ? 12 : 14} /> {attachLabel}
          <input
            type="file"
            accept={accept}
            multiple={multiple}
            disabled={disabled}
            // Kept for the phones whose browser has no `getUserMedia` but does hand a file picker
            // straight to the camera app. On everything else the Scan button above is the better
            // door, and this one stays what it always was: whatever is already on the device.
            capture={undefined}
            style={{ display: 'none' }}
            onChange={(e) => {
              const chosen = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (chosen.length) onFiles(chosen);
            }}
          />
        </label>
      </div>

      {scanner}
    </>
  );
};

export default ScanOrAttach;
