import { api } from './api';

/**
 * Name-only list of active internal staff, from `GET /users/directory`.
 *
 * Not `GET /users` — that route is `@Roles(ADMIN)` plus `user:view:organization`, which the HR
 * desk clerk filling in "who in HR looks after this person" does not hold, and it hands back
 * email, lockout state and every role held for someone who only needs to be found by name. The
 * directory route exists for exactly this picker: it is gated the same way `/hr` itself is
 * (`assayer:view:organization`), and returns nothing but an id and a display name.
 */
export interface StaffDirectoryRow {
  id: string;
  displayName: string;
}

interface DirectoryEnvelope {
  data?: StaffDirectoryRow[];
  meta?: { pagination?: { total?: number } };
}

/**
 * One request, not a page walk like `fetchWholeAssayerRoster`: the directory is internal staff,
 * not an 11,000-row assayer roster, and the server itself caps at 5,000 rather than paging.
 * `total` is still returned so a caller can tell a genuinely complete list from one that hit
 * that ceiling.
 */
export async function fetchStaffDirectory(
  options?: { signal?: AbortSignal },
): Promise<{ people: StaffDirectoryRow[]; total: number }> {
  const res = await api.request<DirectoryEnvelope>('/users/directory', {
    withMeta: true,
    signal: options?.signal,
  });
  const people = Array.isArray(res?.data) ? res.data : [];
  return { people, total: res?.meta?.pagination?.total ?? people.length };
}
