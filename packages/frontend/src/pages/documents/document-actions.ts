import { SystemRole } from '@fapoms/shared';
import { hasAnyRole } from '../../hooks/useCurrentRoles';

/**
 * Which paperwork actions the Branch Paperwork page may offer, one flag per server route.
 *
 * Every route below is a closed `@Roles(...)` list with no permission fallback, so these are role
 * NAMES (hierarchy-expanded: DEVELOPER passes wherever ADMIN is named, exactly as RolesGuard lets
 * it) and a custom role built in Admin → Roles gets none of them. The page is open to more people
 * than any of these — AUDITOR and DESK_OPERATOR read the book, CLIENT_USER reaches the Daily Run —
 * and each of them used to see buttons whose click could only answer 403.
 *
 * Kept in one place so the three panels on the page (daily run, branch view, flat list) cannot
 * disagree about the same button.
 */
export interface DocumentActions {
  /** `POST /documents/upload`, `…/upload/presign`, `…/upload/finalize`, `POST /customer-master/upload`, `POST /documents/upload-generated-batch`: ADMIN, OPERATIONS, DESK. */
  upload: boolean;
  /** `POST /documents/dispatch-batch`, `POST /documents/:id/dispatch`: ADMIN, OPERATIONS, DESK. */
  dispatch: boolean;
  /** `POST /documents/:id/receive`: ADMIN, OPERATIONS, DESK (and the field app's ASSAYER). */
  markReceived: boolean;
  /** `POST /documents/:id/send-external-ocr`: ADMIN, DESK — OPERATIONS dispatches but does not push to the OCR vendor. */
  sendToOcr: boolean;
  /** `POST /documents/upload-excel`: ADMIN, DESK. */
  uploadExcel: boolean;
  /**
   * `GET /documents/:id/download-token`: ADMIN, OPERATIONS, DESK, DESK_OPERATOR. AUDITOR reads the
   * paperwork trail but is deliberately not on the download list (minting the token IS the access
   * to bank customer paperwork), and CLIENT_USER is not either.
   */
  download: boolean;
}

/** For a caller that has not been updated to pass flags — renders as it always did. */
export const ALL_DOCUMENT_ACTIONS: DocumentActions = {
  upload: true, dispatch: true, markReceived: true, sendToOcr: true, uploadExcel: true, download: true,
};

export function documentActionsFor(roles: SystemRole[]): DocumentActions {
  const { ADMIN, OPERATIONS, DESK, DESK_OPERATOR } = SystemRole;
  const handlers = hasAnyRole(roles, [ADMIN, OPERATIONS, DESK]);
  const desk = hasAnyRole(roles, [ADMIN, DESK]);
  return {
    upload: handlers,
    dispatch: handlers,
    markReceived: handlers,
    sendToOcr: desk,
    uploadExcel: desk,
    download: hasAnyRole(roles, [ADMIN, OPERATIONS, DESK, DESK_OPERATOR]),
  };
}
