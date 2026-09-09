import React from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { AssayerRecord } from './AssayerRecord';
import { NotFound } from '../NotFound';
import { defaultRouteFor } from '../../config/route-permissions';
import { useCurrentRoles, useCurrentPermissions, canManageAssayers } from '../../hooks/useCurrentRoles';

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
  const permissions = useCurrentPermissions();
  const canManage = canManageAssayers(roles);
  // Bumped after an edit so the record re-reads itself; without it a save landed in the database
  // and the screen behind went on showing the old values, which is indistinguishable from a save
  // that silently did nothing.
  const [version, setVersion] = React.useState(0);

  /**
   * The id whose record the server says does not exist.
   *
   * Held as the id rather than a boolean so it resets itself: navigating from a missing record to
   * a real one changes `assayerId` while this component stays mounted (React Router reuses the
   * element when only a param changes), and a boolean would have to be cleared by hand in an
   * effect — which is exactly the sort of forgotten reset that leaves a valid person showing a
   * 404. Comparing the two makes the stale value harmless.
   */
  const [missingId, setMissingId] = React.useState<string | null>(null);

  /**
   * A URL that addresses nobody is a URL this application has no page for, and it already has an
   * answer for that.
   *
   * `/hr/roster/<id>` used to render loading skeletons for ever when `<id>` was unknown or
   * malformed: `AssayerRecord` treated "no record yet" and "no such record" as one state. Both
   * `GET /assayers/:id` (404, or 400 for a malformed uuid) and the not-found page existed the
   * whole time — the route simply never joined them up. It does now, and reuses `NotFound` rather
   * than growing a second, differently-worded 404: the URL stays in the address bar for a bug
   * report, and the way out is the same link every other dead URL offers.
   *
   * Only ABSENCE lands here. A 500, a timeout or a dropped connection leaves the record component
   * mounted to show its own failure panel with a retry, because telling somebody a person was
   * deleted when the server merely stumbled is a worse lie than a spinner.
   */
  if (missingId === assayerId) {
    return <NotFound landing={defaultRouteFor(roles, permissions)} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <Link
        to="/hr/roster"
        onClick={(e) => {
          if (window.history.state && window.history.state.idx > 0) {
            e.preventDefault();
            void navigate(-1);
          }
        }}
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
        onClose={() => {
          if (window.history.state && window.history.state.idx > 0) {
            void navigate(-1);
          } else {
            void navigate('/hr/roster');
          }
        }}
        onChanged={() => setVersion((v) => v + 1)}
        onMissing={setMissingId}
        reloadKey={version}
      />
    </div>
  );
};
