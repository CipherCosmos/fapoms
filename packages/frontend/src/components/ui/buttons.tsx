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
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'var(--btn-bg)',
        border: 'none',
        color: 'var(--btn-text)',
        padding: '10px 18px',
        borderRadius: 'var(--radius-md)',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow: 'var(--shadow-sm)',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
};

/**
 * Shared "Upload Excel" label + hidden file input + "Download Template" button pair,
 * duplicated across Assayers.tsx and Projects.tsx.
 */
export const UploadExcelControls: React.FC<{
  onUpload: (file: File) => void;
  onDownloadTemplate: () => void;
  accept?: string;
  uploadLabel?: string;
  templateLabel?: string;
}> = ({ onUpload, onDownloadTemplate, accept = '.xlsx,.xls,.csv', uploadLabel = 'Upload Excel', templateLabel = 'Download Template' }) => {
  return (
    <>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: 'rgba(63, 125, 83, 0.12)',
          border: '1px solid rgba(63, 125, 83, 0.3)',
          color: 'var(--status-active)',
          padding: '9px 16px',
          borderRadius: 'var(--radius-md)',
          fontWeight: 600,
          cursor: 'pointer',
          fontSize: '13px',
        }}
      >
        <Upload size={16} />
        {uploadLabel}
        <input
          type="file"
          accept={accept}
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
          cursor: 'pointer',
          fontSize: '13px',
        }}
      >
        <Download size={16} />
        {templateLabel}
      </button>
    </>
  );
};
