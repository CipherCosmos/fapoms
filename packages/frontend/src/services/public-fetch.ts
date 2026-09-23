import { fromNetwork, fromResponse } from './errors';
import { fetchWithTimeout, DEFAULT_TIMEOUT_MS, LONG_TIMEOUT_MS } from './http';

/**
 * The call a page with NO session makes — the candidate's registration link, the public ID card
 * check. Shared so the two cannot drift apart.
 *
 * `fetch`, a deadline, envelope-unwrapping and error translation — everything `ApiClient.send`
 * does, minus the auth header and the 401→refresh→redirect dance neither applies here.
 */
export async function publicCall<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const timeoutMs = init?.timeoutMs ?? (isForm ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {
    ...(isForm ? {} : { 'Content-Type': 'application/json' }),
    ...((init?.headers as Record<string, string>) || {}),
  };

  let response: Response;
  try {
    response = await fetchWithTimeout(path, { ...init, headers, timeoutMs });
  } catch (err) {
    throw fromNetwork(err);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw fromResponse(response.status, body);
  }

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as unknown as T;
  }

  const json = await response.json();
  const enveloped = json !== null && typeof json === 'object' && !Array.isArray(json)
    && 'success' in json && 'data' in json;
  return (enveloped ? json.data : json) as T;
}

