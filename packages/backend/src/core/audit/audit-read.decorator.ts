import { SetMetadata } from '@nestjs/common';

export const AUDIT_READ_KEY = 'audit:read';

export interface AuditReadOptions {
  /**
   * The resource being read, e.g. `ASSAYER_PROFILE`, `CUSTOMER_RECORD`, `DOCUMENT`. Used to build
   * the event type (`<resource>_VIEWED`) and stored as the entity type.
   */
  resource: string;
  /**
   * Route param naming the specific record read (e.g. `id`, `assayerId`). Omit for a list/search
   * read that is not about one record — the event is then recorded against the not-a-record
   * sentinel, still capturing who searched what (from the scrubbed query) and when.
   */
  idParam?: string;
  /** Override the derived `<resource>_VIEWED` event type when a better verb exists. */
  eventType?: string;
}

/**
 * Marks a read (GET) handler as an access to personal / sensitive data that must be logged.
 *
 * DPDP Rules 2025 and the RBI IT-Governance direction want the trail to answer "who accessed this
 * person's data, and when" — not only who changed it. Today only the sensitive-field *unmask* is
 * logged; ordinary views of an appraiser profile, a customer record or a document leave no trace,
 * so a breach could not be scoped after the fact. This decorator, read by `AuditReadInterceptor`,
 * records one access event per successful sensitive read — the actor, session, IP and target come
 * from the ambient request context; the VALUE that was read is never stored (same discipline as the
 * unmask audit), so the access log cannot itself become a second copy of the data.
 *
 * Apply it only to genuinely sensitive reads. Logging every list endpoint would drown the signal
 * and inflate the trail without compliance benefit.
 */
export const AuditRead = (options: AuditReadOptions) => SetMetadata(AUDIT_READ_KEY, options);
