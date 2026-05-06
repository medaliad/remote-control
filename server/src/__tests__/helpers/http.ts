/**
 * Shared HTTP helpers for integration / e2e tests.
 *
 * These were previously duplicated inline in `http.test.ts` and `autopair.test.ts`.
 */

/** POST a JSON body. Optional headers are merged after Content-Type. */
export async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** GET a URL. */
export async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: "GET", headers });
}

/** Parse a JSON response body, typed loosely. */
export async function asJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

/**
 * Poll until the predicate returns true, or fail after `timeoutMs`.
 * Replaces brittle setTimeout-based waits in disconnect / cleanup tests.
 */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 2_000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}
