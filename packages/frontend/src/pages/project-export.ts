/**
 * Every project in scope, for the Projects export — not just the pages the table has loaded.
 *
 * The export used to write `projects` (the table's rows so far: page one, 50 of them, until the
 * operator pressed "Load more") and called that the export. Anyone with more projects than one
 * page got a file that silently stopped at 50. This walks the list at the server's ceiling (200)
 * until it has the total the server reports, or a page comes back short.
 */
type WithMetaRequest = <T>(endpoint: string, options?: RequestInit & { withMeta?: boolean }) => Promise<T>;

interface Page<T> {
  data: T[];
  meta?: { pagination?: { total?: number } };
}

export const PROJECT_EXPORT_PAGE_SIZE = 200;
/** A backstop against a server that keeps answering full pages: 200 × 200 = 40,000 projects. */
const MAX_PAGES = 200;

export async function fetchAllProjectPages<T>(request: WithMetaRequest, scopeQuery: string): Promise<T[]> {
  const all: T[] = [];
  const scope = scopeQuery ? `&${scopeQuery}` : '';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await request<Page<T>>(
      `/projects?page=${page}&limit=${PROJECT_EXPORT_PAGE_SIZE}${scope}`,
      { method: 'GET', withMeta: true },
    );
    const rows = res?.data ?? [];
    all.push(...rows);
    const total = res?.meta?.pagination?.total;
    if (rows.length < PROJECT_EXPORT_PAGE_SIZE) break;
    if (total != null && all.length >= total) break;
  }
  return all;
}
