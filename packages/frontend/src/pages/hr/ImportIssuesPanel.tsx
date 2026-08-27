import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Check } from 'lucide-react';

import { api } from '../../services/api';
import { useToast } from '../../components/ui';
import { label, Empty } from './hr-ui';
import { userMessage } from '../../services/errors';
import { counted } from '../../utils/plural';

/**
 * The cells the roster import could not read, waiting for somebody to decide.
 *
 * The import never guesses: a cell whose meaning it cannot establish is kept with its original
 * text and the row it came from, and the person still imports. This is where those land.
 *
 * **Grouped, not listed.** The same unreadable word repeats across hundreds of rows — 145 people
 * carry one variant, 25 another — and a flat list of them is a list nobody reads. One line per
 * distinct problem, with the count and the people behind it, so the decision is made once and
 * applied to everyone it touches.
 *
 * Closing an entry demands an account of what was decided. The queue exists because nothing was
 * guessed; closing one blank puts the guess back without a record of it, which the server also
 * refuses.
 */

interface Issue {
  id: string;
  sourceSheet: string;
  sourceRow: number;
  sourceColumn: string;
  rawValue: string;
  reason: string;
  sourceAssayerCode: string | null;
  assayer?: { assayerCode?: string; firstName?: string; lastName?: string } | null;
}

interface Group {
  key: string;
  column: string;
  rawValue: string;
  reason: string;
  issues: Issue[];
}

export const ImportIssuesPanel: React.FC<{ canManage: boolean; onResolved?: () => void }> = ({
  canManage, onResolved,
}) => {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const { toast } = useToast();

  const load = () => {
    api.request<{ rows: Issue[]; openCount: number }>('/assayers/roster/import-issues')
      .then((d) => { setIssues(d.rows ?? []); setOpenCount(d.openCount ?? 0); })
      .catch(() => { setIssues([]); setOpenCount(0); });
  };

  useEffect(load, []);

  const groups = useMemo<Group[]>(() => {
    const byKey = new Map<string, Group>();
    for (const i of issues ?? []) {
      // Grouped on what the problem *is* — the column and the text in it — rather than on where
      // it was found, because that is what one decision covers.
      const key = `${i.sourceColumn}::${i.rawValue.toLowerCase()}`;
      const g = byKey.get(key) ?? { key, column: i.sourceColumn, rawValue: i.rawValue, reason: i.reason, issues: [] };
      g.issues.push(i);
      byKey.set(key, g);
    }
    return [...byKey.values()].sort((a, b) => b.issues.length - a.issues.length);
  }, [issues]);

  const resolveGroup = async (g: Group) => {
    const stated = resolution.trim();
    if (!stated) {
      toast({ type: 'error', message: 'Say what was decided about these cells before closing them.' });
      return;
    }
    setBusy(true);
    try {
      for (const i of g.issues) {
        await api.request(`/assayers/roster/import-issues/${i.id}/resolve`, {
          method: 'POST', body: JSON.stringify({ resolution: stated }),
        });
      }
      toast({
        type: 'success',
        title: 'Closed',
        message: `${counted(g.issues.length, 'cell')} in “${g.column}” marked decided.`,
      });
      setExpanded(null);
      setResolution('');
      load();
      onResolved?.();
    } catch (e) { toast({ type: 'error', message: userMessage(e) }); } finally { setBusy(false); }
  };

  if (issues === null || openCount === 0) return null;

  return (
    <div style={{
      border: '1px solid var(--warning)', borderRadius: '10px',
      background: 'var(--bg-card)', overflow: 'hidden',
    }}>
      <button
        onClick={() => setShow((s) => !s)}
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left',
          padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-primary)', fontSize: '13px',
        }}
      >
        <AlertTriangle size={15} style={{ color: 'var(--warning)', flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          <strong style={{ fontWeight: 600 }}>
            {counted(openCount, 'cell')} from the roster import could not be read.
          </strong>{' '}
          <span style={{ color: 'var(--text-muted)' }}>
            {groups.length === 1 ? 'One distinct problem' : `${groups.length} distinct problems`}.
            Nothing was guessed — the people imported and these await a decision.
          </span>
        </span>
        {show ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>

      {show && (
        <div style={{ borderTop: '1px solid var(--border-hair)' }}>
          {groups.length === 0 ? (
            <Empty>Nothing outstanding.</Empty>
          ) : groups.map((g) => (
            <div key={g.key} style={{ borderBottom: '1px solid var(--border-hair)', padding: '10px 14px' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <div style={{ ...label, minWidth: '150px' }}>{g.column}</div>
                <div style={{ fontSize: '13px', color: 'var(--text-primary)', flex: 1, minWidth: '220px' }}>
                  “{g.rawValue}” — {g.reason}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {counted(g.issues.length, 'person', 'people')}
                </div>
              </div>

              <div style={{ marginTop: '5px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                {g.issues.slice(0, 12).map((i) => i.assayer?.assayerCode ?? i.sourceAssayerCode ?? `row ${i.sourceRow}`).join(', ')}
                {g.issues.length > 12 && ` and ${g.issues.length - 12} more`}
              </div>

              {canManage && (expanded === g.key ? (
                <div style={{ marginTop: '9px', display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <input
                    autoFocus
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') resolveGroup(g); if (e.key === 'Escape') setExpanded(null); }}
                    placeholder="What was decided? e.g. “Availability note in the wrong column — ignore.”"
                    style={{
                      flex: 1, minWidth: '260px', padding: '7px 10px', fontSize: '12.5px',
                      background: 'var(--bg-surface)', color: 'var(--text-primary)',
                      border: '1px solid var(--border-color)', borderRadius: '7px',
                    }}
                  />
                  <button
                    onClick={() => resolveGroup(g)}
                    disabled={busy}
                    style={{
                      background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '7px',
                      padding: '7px 13px', fontSize: '12.5px', fontWeight: 600, cursor: busy ? 'default' : 'pointer',
                      display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap',
                    }}
                  >
                    <Check size={13} /> Close {counted(g.issues.length, 'cell')}
                  </button>
                  <button onClick={() => { setExpanded(null); setResolution(''); }}
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '12.5px', cursor: 'pointer', padding: '7px 0' }}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => { setExpanded(g.key); setResolution(''); }}
                  style={{ background: 'none', border: 'none', padding: '6px 0 0', cursor: 'pointer', color: 'var(--primary)', fontSize: '12px', fontWeight: 600 }}
                >
                  Decide this
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
