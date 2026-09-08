import React from 'react';
import { Plus, Download, Upload, SlidersHorizontal, FileSpreadsheet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ToolbarMenu, MenuAction } from '../ToolbarMenu';
import { counted } from '../../../utils/plural';

export interface RosterHeaderProps {
  totalCount: number;
  filteredCount: number;
  appliedCount: number;
  showFilters: boolean;
  onToggleFilters: () => void;
  onOpenExport: () => void;
  onOpenImport: () => void;
  canCreate: boolean;
  canManage: boolean;
  onExportExcel: () => void;
  exportingExcel: boolean;
}

export const RosterHeader: React.FC<RosterHeaderProps> = ({
  totalCount,
  filteredCount,
  appliedCount,
  showFilters,
  onToggleFilters,
  onOpenExport,
  onOpenImport,
  canCreate,
  onExportExcel,
  exportingExcel,
}) => {
  const navigate = useNavigate();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
      }}
    >
      <div>
        <h1
          style={{
            margin: 0,
            fontSize: '20px',
            fontWeight: 700,
            color: 'var(--text-primary)',
            letterSpacing: '-0.02em',
          }}
        >
          Assayer Workforce Roster
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
          {totalCount.toLocaleString('en-IN')} total registered assayers
          {filteredCount !== totalCount && (
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
              {' '}
              · {filteredCount.toLocaleString('en-IN')} matching current filters
            </span>
          )}
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onToggleFilters}
          className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', padding: '7px 12px' }}
        >
          <SlidersHorizontal size={14} />
          <span>Filters</span>
          {appliedCount > 0 && (
            <span
              style={{
                marginLeft: '4px',
                background: showFilters ? 'rgba(255,255,255,0.25)' : 'var(--accent)',
                color: '#fff',
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: '10px',
                fontWeight: 700,
              }}
            >
              {appliedCount}
            </span>
          )}
        </button>

        <ToolbarMenu label="Export" icon={<Download size={13} />} panelWidth={280}>
          {(close) => (
            <>
              <MenuAction
                label={`Current view (CSV, what you see now) — Choose columns, ${counted(filteredCount, 'person', 'people')}`}
                hint="Pick exactly the columns you need. Downloads a CSV; the dialog also lets you switch to everyone loaded instead of just this view."
                icon={<Download size={13} />}
                onClick={() => {
                  close();
                  onOpenExport();
                }}
              />
              <MenuAction
                label={exportingExcel ? 'Preparing the workbook…' : 'Full roster + pay rates (workbook, everyone)'}
                hint="Ignores the filters — everyone, with the payroll rate card and assignment counts the roster screen never receives. Built on the server."
                icon={<FileSpreadsheet size={13} />}
                tone="var(--success)"
                disabled={exportingExcel}
                onClick={() => {
                  close();
                  onExportExcel();
                }}
              />
            </>
          )}
        </ToolbarMenu>

        {canCreate && (
          <>
            <button
              type="button"
              onClick={onOpenImport}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', padding: '7px 12px' }}
            >
              <Upload size={14} />
              <span>Import</span>
            </button>

            <button
              type="button"
              onClick={() => navigate('/hr/register')}
              className="btn btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '7px 14px' }}
            >
              <Plus size={15} />
              <span>Add assayer</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
};
