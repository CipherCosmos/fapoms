import 'reflect-metadata';
import {
  ALLOW_PERMISSION_FALLBACK_KEY, ROLES_FALLBACK_PERMISSIONS_KEY, ANY_AUTHENTICATED_KEY, ROLES_KEY,
} from './guards';
import { ReportsController } from '../reports/reports.controller';
import { AssayerController } from '../assayer/assayer.controller';
import { ProjectController } from '../project/project.controller';

/**
 * The buttons and layers on pages a custom role is offered, served to that role.
 *
 * /billing and /executive-map open for a role built in Admin → Roles (billing:view, planning:view),
 * but their Export buttons, the export poll/download, the map's assayer layer and the planning
 * page's project picker each answered 403 — RolesGuard refuses an unrecognised role name unless
 * the route opts in. Read from the handler metadata, so a dropped decorator fails here.
 */
const meta = (cls: any, handler: string, key: string) => Reflect.getMetadata(key, cls.prototype[handler]);

describe('custom-role fallbacks on export and map routes', () => {
  it('POST /reports/billing/jobs honours billing:view', () => {
    expect(meta(ReportsController, 'queueBilling', ALLOW_PERMISSION_FALLBACK_KEY)).toBe(true);
  });

  it('POST /reports/command-center/jobs honours planning:view', () => {
    expect(meta(ReportsController, 'queueCommandCenter', ROLES_FALLBACK_PERMISSIONS_KEY)).toEqual(['planning:view:organization']);
  });

  it.each(['reportJob', 'downloadReportJob'])('%s is gated by job ownership, not a role list', (h) => {
    expect(meta(ReportsController, h, ANY_AUTHENTICATED_KEY)).toBe(true);
    expect(meta(ReportsController, h, ROLES_KEY)).toBeUndefined();
  });

  it('GET /assayers/map-roster and GET /assayers honour assayer:view', () => {
    expect(meta(AssayerController, 'mapRoster', ALLOW_PERMISSION_FALLBACK_KEY)).toBe(true);
    expect(meta(AssayerController, 'findAll', ALLOW_PERMISSION_FALLBACK_KEY)).toBe(true);
  });

  it('GET /projects honours project:view', () => {
    expect(meta(ProjectController, 'findAll', ROLES_FALLBACK_PERMISSIONS_KEY)).toEqual(['project:view:organization']);
  });
});
