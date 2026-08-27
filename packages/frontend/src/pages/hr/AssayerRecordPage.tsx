import React from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { AssayerRecord } from './AssayerRecord';
import { EditAssayerModal } from './AssayerForms';
import { useCurrentRoles, canManageAssayers } from '../../hooks/useCurrentRoles';
import type { Assayer } from './assayer-shared';

/**
 * One person's whole record, at its own URL.
 *
 * This was a 560px drawer over the roster. That was the right shape when it held a summary and
 * some remarks; it now holds vetting, client standing, references, twenty-one documents and the
 * skills editor, and a narrow strip beside a list nobody is reading any more is the wrong place
 * for all of it.
 *
 * Its own URL also means the thing the drawer needed a `?assayer=` parameter for — global search
 * and the planning screen linking straight to a person — is just a link.
 */
export const AssayerRecordPage: React.FC = () => {
  const { assayerId = '' } = useParams();
  const navigate = useNavigate();
  const roles = useCurrentRoles();
  const canManage = canManageAssayers(roles);
  const [editing, setEditing] = React.useState<Assayer | null>(null);
  // Bumped after an edit so the record re-reads itself; without it a save landed in the database
  // and the screen behind went on showing the old values, which is indistinguishable from a save
  // that silently did nothing.
  const [version, setVersion] = React.useState(0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <Link
        to="/hr/roster"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px',
          color: 'var(--text-muted)', textDecoration: 'none', width: 'fit-content',
        }}
      >
        <ArrowLeft size={14} /> Back to People
      </Link>

      <AssayerRecord
        assayerId={assayerId}
        canManage={canManage}
        onClose={() => navigate('/hr/roster')}
        onEdit={(a) => setEditing(a)}
        onChanged={() => setVersion((v) => v + 1)}
        reloadKey={version}
      />

      {editing && (
        <EditAssayerModal
          assayer={editing}
          onClose={() => setEditing(null)}
          onUpdated={() => { setEditing(null); setVersion((v) => v + 1); }}
        />
      )}
    </div>
  );
};
