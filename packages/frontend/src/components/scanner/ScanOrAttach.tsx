import React, { useState } from 'react';
import { Camera, Paperclip } from 'lucide-react';
import { SCAN_UPLOAD_ACCEPT, scanProfileFor } from '@fapoms/shared';
import { DocumentScanner } from './DocumentScanner';

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
}

export function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export const ScanOrAttach: React.FC<ScanOrAttachProps> = ({
  documentLabel, requirement, onFiles, multiple = false, disabled = false,
  attachLabel = 'Choose file', accept = SCAN_UPLOAD_ACCEPT, size = 'md',
}) => {
  const [scanning, setScanning] = useState(false);
  const profile = scanProfileFor(requirement);

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
            <Camera size={size === 'sm' ? 12 : 14} /> Scan
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

      {scanning && (
        <DocumentScanner
          documentLabel={documentLabel}
          profile={profile}
          onCancel={() => setScanning(false)}
          onScanned={(files) => { setScanning(false); onFiles(files); }}
        />
      )}
    </>
  );
};

export default ScanOrAttach;
