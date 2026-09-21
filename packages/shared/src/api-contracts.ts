/**
 * The response envelope, and the pagination inside it. Nothing else.
 *
 * This file used to hold twenty exported types under a header claiming they "ensure consistency
 * between backend and frontend". Sixteen of them had **no reference anywhere** — not in the
 * backend, the web app, the phone app or the rest of this package — so they ensured nothing.
 * Worse than idle, they were misleading in two specific ways:
 *
 *   - A SECOND ERROR CONTRACT. `ApiError` / `ApiErrorDetail` / `ApiErrorResponse` described a
 *     `{ code, message, details[], traceId }` body, while the error vocabulary this product
 *     actually speaks is `error-codes.ts` in this same package (`ApiErrorCode`, `FieldError`),
 *     wired through `infrastructure/http/api-error.ts`. Two error contracts in one package, one
 *     of them fiction.
 *   - A SEARCH SHAPE THE SERVER DOES NOT SERVE. `SearchResult` described a flat
 *     `{ entityType, entityId, title… }` row. `GET /search` returns results GROUPED by entity
 *     (`{ branches[], assayers[], projects[], clients[], assignments[] }`), which is what
 *     `useGlobalSearch.ts` declares for itself. Anyone who had trusted the shared type would
 *     have written code that could never run.
 *
 * Also deleted: a duplicate auth DTO set (`LoginRequest` / `LoginResponse` /
 * `RefreshTokenRequest` / `AuthenticatedUser`) beside the live `LoginDto` in
 * `auth/auth.controller.ts`, plus unused `PaginationParams`, `SortParams`, `FilterParams` and
 * the three `BulkOperation*` types.
 *
 * What remains is what is actually imported and enforced: `ApiResponse` by the response
 * interceptor, `PaginationMeta` by `buildPaginationMeta`. A type nobody imports does not
 * document a contract — it invents one.
 */

// ---------------------------------------------------------------------------
// Standard API Response Envelope
// ---------------------------------------------------------------------------

/** What `ResponseInterceptor` wraps every handler return value in. */
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: ApiMeta;
}

export interface ApiMeta {
  pagination?: PaginationMeta;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * The paginated envelope the API actually returns: `data` plus `meta.pagination`. It was previously
 * declared with a flat `meta: PaginationMeta`, which no controller emits — so every caller hand-cast an
 * inline shape and this type documented a contract that did not exist. Nesting under `meta.pagination`
 * matches the dominant real shape (clients, users, assayers, projects, branches, zones, holidays…).
 */
export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  meta: { pagination: PaginationMeta };
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
  nextCursor?: string;
}
