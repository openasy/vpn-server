import type { ServerConfig } from "./config.ts";

export type Fetched = { changed: true; config: unknown; etag: string } | { changed: false };

/** Pulls this server's desired state; with an ETag, an unchanged config costs one 304. */
export async function fetchConfig(managerUrl: string, token: string, id: string, etag?: string): Promise<Fetched> {
  const res = await fetch(new URL(`/api/v1/servers/${encodeURIComponent(id)}/config`, managerUrl), {
    headers: { authorization: `Bearer ${token}`, ...(etag && { "if-none-match": etag }) },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 304) return { changed: false };
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { detail?: string; title?: string };
    throw new Error(`config: ${res.status} ${problem.detail ?? problem.title ?? res.statusText}`);
  }
  return { changed: true, config: (await res.json()) as ServerConfig, etag: res.headers.get("etag") ?? "" };
}
