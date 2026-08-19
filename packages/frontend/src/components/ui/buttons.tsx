import React from 'react';
import { Plus, Download, Upload } from 'lucide-react';

/**
 * Shared "Add / Create" gradient primary CTA button. The `--gradient-neon` +
 * `--shadow-neon` primary button with a Plus icon was duplicated across Projects,
 * Rules, Users, Assayers.
 */
export const PrimaryButton: React.FC<{
  onClick?: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
  type?: 'button' | 'submit';
  style?: React.CSSProperties;
  disabled?: boolean;
}> = ({ onClick, children, icon = <Plus size={16} />, type = 'button', style, disabled }) => {
  // Renders the shared `.btn .btn-primary` class (single source of truth for
  // styling/hover) rather than duplicating the look with inline styles.
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="btn btn-primary"
      style={{ display: 'flex', alignItems: 'center', gap: '8px', ...style }}
    >
      {icon}
      {children}
    </button>
  );
};

/**
 * Shared "Upload Excel" label + hidden file input + "Download Template" button pair,
 * duplicated across Assayers.tsx and Projects.tsx.
 *
 * `busy` is optional and defaults to false, so every existing call site keeps working
 * unchanged. It exists because a roster or branch-sheet import runs for as long as the
 * server takes to read the file, and until now the control gave no sign of that: the file
 * dialog closed, nothing on screen changed, and the operator picked the file a second time.
 * Two overlapping imports of the same sheet is not harmless — the second one re-runs every
 * row against a roster the first is still writing. A `<label>` cannot be disabled the way a
 * button can, so while busy we take the hidden input out of play (`disabled`), stop pointer
 * events on the label, and say what is happening on its face.
 */
export const UploadExcelControls: React.FC<{
  onUpload: (file: File) => void;
  onDownloadTemplate: () => void;
  accept?: string;
  uploadLabel?: string;
  templateLabel?: string;
  /** An import is running: the control stops accepting a second file and shows a working state. */
  busy?: boolean;
  /** Disabled for a reason of the caller's own (no permission, nothing selected yet). */
  disabled?: boolean;
  /** Shown in place of `uploadLabel` while `busy`. */
  busyLabel?: string;
}> = ({
  onUpload, onDownloadTemplate, accept = '.xlsx,.xls,.csv',
  uploadLabel = 'Upload Excel', templateLabel = 'Download Template',
  busy = false, disabled = false, busyLabel = 'Uploading…',
}) => {
  const off = busy || disabled;
  return (
    <>
      <label
        aria-disabled={off}
        style={{
          opacity: off ? 0.6 : 1,
          pointerEvents: off ? 'none' : undefined,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: 'rgba(63, 125, 83, 0.12)',
          border: '1px solid rgba(63, 125, 83, 0.3)',
          color: 'var(--status-active)',
          padding: '9px 16px',
          borderRadius: 'var(--radius-md)',
          fontWeight: 600,
          cursor: off ? 'not-allowed' : 'pointer',
          fontSize: '13px',
        }}
      >
        <Upload size={16} />
        {busy ? busyLabel : uploadLabel}
        <input
          type="file"
          accept={accept}
          disabled={off}
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
            e.target.value = '';
          }}
        />
      </label>
      <button
        onClick={onDownloadTemplate}
        disabled={off}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          color: 'var(--text-secondary)',
          padding: '9px 16px',
          borderRadius: 'var(--radius-md)',
          fontWeight: 600,
          opacity: off ? 0.6 : 1,
          cursor: off ? 'not-allowed' : 'pointer',
          fontSize: '13px',
        }}
      >
        <Download size={16} />
        {templateLabel}
      </button>
    </>
  );
};
