import React, { useMemo, useState } from 'react';
import { Download, FileSpreadsheet, ShieldAlert } from 'lucide-react';

import { Modal } from '../../components/ui';
import { downloadCsv, datedFilename } from '../../utils/csv';
import { counted } from '../../utils/plural';
import {
  ROSTER_EXPORT_COLUMNS, EXPORT_COLUMN_GROUPS, EXPORT_PRESETS,
  buildRosterExport, restrictedColumns, columnByKey,
} from './roster-export';
import type { RosterPerson } from './roster-filters';

/**
 * Choose what to export, and what to export it about.
 *
 * The two exports this replaces could not be chosen at all: a fixed eleven columns of the current
 * view, or a server workbook of the whole roster. Anybody wanting "the Kerala people with their
 * skills and joining dates" exported everything and deleted columns in Excel — which is where a
 * masked PAN gets pasted into a bank portal.
 *
 * WHAT IT DOES NOT REPLACE. `GET /reports/assayer-roster` stays, and is offered from inside this
 * dialog, because it carries two things the browser has never been sent: the payroll rate card
 * (base fee, daily and hourly rates, allowances, effective dates) and per-person assignment
 * counts. Those are not columns this picker is hiding — they are not in the roster response. So
 * the two are complements and the dialog says which is which, rather than leaving a clerk to
 * find out by opening both.
 */

/** Remembering the last choice, because a clerk exports the same thing every week. */
const REMEMBERED = 'fapoms.roster.export.columns';

const readRemembered = (): string[] | null => {
  try {
    const raw = window.localStorage.getItem(REMEMBERED);
    const parsed = raw ? JSON.parse(raw) : null;
    // Silently drop any column that no longer exists rather than exporting a blank one.
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string' && columnByKey(k)) : null;
  } catch { return null; }
};

const remember = (keys: string[]): void => {
  try { window.localStorage.setItem(REMEMBERED, JSON.stringify(keys)); } catch { /* private window */ }
};

export const RosterExportDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  /** The people the filters currently leave on screen. */
  filtered: RosterPerson[];
  /** Everybody the page has loaded, whatever the filters say. */
  all: RosterPerson[];
  /** True when the server holds more people than this page asked for. */
  truncated: boolean;
  /** How many the server holds in total, for the sentence about what a CSV cannot cover. */
  rosterTotal: number;
  /** A one-line description of what the filters are currently doing, for the file's own name. */
  filterSummary: string;
  /** Runs the server-built workbook — kept here so the toolbar needs one export control. */
  onExcelExport: () => void;
  excelBusy: boolean;
}> = ({
  open, onClose, filtered, all, truncated, rosterTotal, filterSummary, onExcelExport, excelBusy,
}) => {
  const [scope, setScope] = useState<'filtered' | 'all'>('filtered');
  const [selected, setSelected] = useState<string[]>(
    () => readRemembered() ?? EXPORT_PRESETS[0].columns,
  );

  const rows = scope === 'filtered' ? filtered : all;
  const blocked = useMemo(() => restrictedColumns(all), [all]);
  const chosenMasked = selected.filter((k) => columnByKey(k)?.masked);

  const toggle = (key: string) =>
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const download = () => {
    // Ordered by the catalogue, not by the order they were ticked: a file whose columns move
    // between runs cannot be pasted into last month's sheet.
    const keys = ROSTER_EXPORT_COLUMNS.filter((c) => selected.includes(c.key)).map((c) => c.key);
    const { headers, cells } = buildRosterExport(rows, keys);
    remember(keys);
    downloadCsv(datedFilename(scope === 'filtered' ? 'workforce-selection' : 'workforce-roster'), headers, cells);
    onClose();
  };

  const scopeChoice = (value: 'filtered' | 'all', label: string, hint: string) => (
    <label
      key={value}
      style={{
        display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '8px 10px',
        borderRadius: '8px', cursor: 'pointer', fontSize: '12.5px', flex: '1 1 240px',
        border: `1px solid ${scope === value ? 'var(--accent)' : 'var(--border-color)'}`,
        background: scope === value ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
      }}
    >
      <input
        type="radio"
        name="roster-export-scope"
        checked={scope === value}
        onChange={() => setScope(value)}
        style={{ marginTop: '2px' }}
      />
      <span>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '12px', lineHeight: 1.45 }}>{hint}</span>
      </span>
    </label>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export the workforce"
      width={720}
      maxHeight="86vh"
      footer={(
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {counted(selected.length, 'column')} × {counted(rows.length, 'person', 'people')}
          </span>
          <button onClick={onClose} className="btn btn-secondary" style={{ fontSize: '12.5px', padding: '8px 14px', marginLeft: 'auto' }}>
            Cancel
          </button>
          <button
            onClick={download}
            disabled={selected.length === 0 || rows.length === 0}
            className="btn btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', padding: '8px 14px' }}
          >
            <Download size={14} /> Download CSV
          </button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '12.5px' }}>
        <section>
          <h3 style={{ fontSize: '13px', fontWeight: 700, margin: '0 0 6px' }}>Who goes in the file</h3>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {/*
              "The people on screen" would be a lie by 141: the table draws 200 rows at a time
              behind a "Show more", and the file gets every row the filters leave.
            */}
            {scopeChoice(
              'filtered',
              `The ${counted(filtered.length, 'person', 'people')} these filters leave`,
              filterSummary,
            )}
            {scopeChoice(
              'all',
              `Everyone loaded (${all.length})`,
              truncated
                ? `Ignores the filters. The server holds ${rosterTotal} — this page has the ${all.length} most recently added, so use the Excel workbook below for the whole book.`
                : 'Ignores the filters and covers the whole roster this page has loaded.',
            )}
          </div>
        </section>

        <section>
          <h3 style={{ fontSize: '13px', fontWeight: 700, margin: '0 0 6px' }}>Start from a job</h3>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {EXPORT_PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => setSelected(p.columns)}
                title={p.hint}
                style={{
                  padding: '5px 11px', borderRadius: '999px', fontSize: '12px', fontWeight: 600,
                  cursor: 'pointer', border: '1px solid var(--border-color)',
                  background: 'var(--bg-surface-2)', color: 'var(--text-secondary)',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '5px', lineHeight: 1.5 }}>
            A preset only ticks boxes — change anything below before you download.
          </div>
        </section>

        <section>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 700, margin: '0 0 6px' }}>Columns</h3>
            <button
              onClick={() => setSelected([])}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: 'var(--accent)', padding: 0 }}
            >
              Untick everything
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px' }}>
            {EXPORT_COLUMN_GROUPS.map((group) => (
              <div key={group} style={{ flex: '1 1 210px', minWidth: '200px' }}>
                <div style={{
                  fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                  color: 'var(--text-muted)', marginBottom: '3px',
                }}>
                  {group}
                </div>
                {ROSTER_EXPORT_COLUMNS.filter((c) => c.group === group).map((c) => {
                  const off = blocked.has(c.key);
                  return (
                    <label
                      key={c.key}
                      title={off ? 'Your account is not allowed to read this field, so it would export blank.' : undefined}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '2px 0',
                        fontSize: '12px', lineHeight: 1.4,
                        cursor: off ? 'not-allowed' : 'pointer',
                        color: off ? 'var(--text-muted)' : (c.masked ? 'var(--warning)' : 'var(--text-primary)'),
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(c.key)}
                        disabled={off}
                        onChange={() => toggle(c.key)}
                        style={{ marginTop: '2px' }}
                      />
                      <span>
                        {c.label}
                        {off && <span style={{ display: 'block', fontSize: '12px' }}>Not available to your account</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </section>

        {/*
          The masked three, said before the file is made rather than discovered inside it.
          Shown always — somebody deciding whether to tick "PAN" needs this at the moment they
          are deciding — and made louder once one of them is ticked.
        */}
        <section style={{
          display: 'flex', gap: '9px', alignItems: 'flex-start',
          padding: '10px 12px', borderRadius: '8px', lineHeight: 1.55,
          border: `1px solid ${chosenMasked.length ? 'var(--warning)' : 'var(--border-color)'}`,
          background: 'var(--bg-surface-2)',
        }}>
          <ShieldAlert size={15} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '1px' }} />
          <div style={{ fontSize: '12px' }}>
            <strong style={{ fontWeight: 700 }}>PAN, Aadhaar and bank account numbers cannot be exported in full.</strong>{' '}
            They reach this screen already covered, so those three columns hold the last four
            characters and nothing more — which is why their headings say so. Use{' '}
            <em>PAN on file</em>, <em>Aadhaar on file</em> and <em>Bank account on file</em> when
            the question is whether the record has one. A whole number is shown one person at a
            time on their own record, and that request is recorded against your name.
            {chosenMasked.length > 0 && (
              <div style={{ marginTop: '6px', fontWeight: 600, color: 'var(--warning)' }}>
                {counted(chosenMasked.length, 'masked column')} ticked — the file will contain
                covered values such as ••••234F, not usable numbers.
              </div>
            )}
          </div>
        </section>

        {/*
          The server workbook, kept and explained rather than quietly replaced. It holds the pay
          rates and assignment history, which are not in the roster response at all — no column
          picker here could produce them.
        */}
        <section style={{
          display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
          padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border-color)',
        }}>
          <div style={{ flex: '1 1 320px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            <strong style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Need pay rates?</strong>{' '}
            The payroll rate card and each person's assignment counts are not on this screen, so no
            choice of columns above can include them. The server builds those into a two-sheet
            Excel workbook covering everyone, which takes a few seconds.
          </div>
          <button
            onClick={onExcelExport}
            disabled={excelBusy}
            className="btn btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '7px 12px', color: 'var(--success)' }}
          >
            <FileSpreadsheet size={13} /> {excelBusy ? 'Preparing…' : 'Full roster + pay rates (Excel)'}
          </button>
        </section>
      </div>
    </Modal>
  );
};
