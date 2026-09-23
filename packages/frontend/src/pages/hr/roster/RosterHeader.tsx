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
      {/*
        No second title.

        This screen sits inside the Workforce section, under a header that already says "Workforce"
        and a People tab that already carries the headcount — so "Assayer Workforce Roster / 107
        total registered assayers" was the same two facts a third and fourth time, stacked, above a
        row of nine counted filter chips. What is left is the only thing this line knew that the
        others did not: how many rows the current filters are showing.
      */}
      <div>
        {filteredCount !== totalCount ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            Showing <strong style={{ color: 'var(--text-primary)' }}>{filteredCount.toLocaleString('en-IN')}</strong>
            {' '}of {totalCount.toLocaleString('en-IN')}
          </p>
        ) : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onToggleFilters}
          className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'}`}
          title={showFilters ? 'Hide the filter panel' : `Show filters${appliedCount > 0 ? ` — ${appliedCount} active` : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', padding: '7px 12px' }}
        >
          <SlidersHorizontal size={14} />
          <span>Filters</span>
          {appliedCount > 0 && (
            <span
              style={{
                marginLeft: '4px',
                background: showFilters ? 'rgba(255,255,255,0.25)' : 'var(--accent)',
                color: '#fff',
                fontSize: 'var(--text-2xs)',
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
              title="Import roster rows from an Excel workbook — rehearsed first, nothing written blindly"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', padding: '7px 12px' }}
            >
              <Upload size={14} />
              <span>Import</span>
            </button>

            {/*
              The door, and the reason this line matters more than it looks.

              It opened `/hr/register` — a seven-step form that wrote a live roster row after step
              one, with no interview, no application and no review. That made the bypass the path
              everybody found, and made the rest of the pipeline look optional. Adding somebody now
              starts where the spec says it starts: a candidate, an interview outcome, and a
              registration link they fill in themselves.
            */}
            <button
              type="button"
              onClick={() => navigate('/hr/interviews')}
              className="btn btn-primary"
              title="Start hiring — add a candidate interview, then invite them to register themselves"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-sm)', padding: '7px 14px' }}
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
