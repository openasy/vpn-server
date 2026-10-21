// Who this server is to vpn (ADR 0032): an admin adds it under Servers and gets a one-time enrolment token; the
// server trades it for its own secret once and keeps that under VPN_STATE_DIR. The state dir must be a volume.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Identity {
  serverId: string;
  secret: string;
  /** Hash of the enrolment token this secret came from: a different VPN_ENROLL_TOKEN means enrol again. */
  enrolledWith: string;
}

export class EnrollError extends Error {
  readonly status: number | undefined;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.status = status;
  }
}

const FILE = "server.json";
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export function loadIdentity(dir: string): Identity | undefined {
  try {
    const v = JSON.parse(readFileSync(join(dir, FILE), "utf8")) as Partial<Identity>;
    return typeof v.serverId === "string" && typeof v.secret === "string" && typeof v.enrolledWith === "string" ? (v as Identity) : undefined;
  } catch {
    return undefined;
  }
}

export function saveIdentity(dir: string, identity: Identity) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const path = join(dir, FILE);
  writeFileSync(`${path}.tmp`, JSON.stringify(identity), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** Trades the enrolment token for this server's id and secret. */
export async function enroll(vpnUrl: string, token: string): Promise<Identity> {
  let res: Response;
  try {
    res = await fetch(new URL("/api/v1/servers/enroll", vpnUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new EnrollError(undefined, `vpn at ${vpnUrl} is unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { detail?: string; title?: string };
    throw new EnrollError(res.status, problem.detail ?? problem.title ?? res.statusText);
  }
  const body = (await res.json()) as { serverId?: unknown; secret?: unknown };
  if (typeof body.serverId !== "string" || typeof body.secret !== "string") throw new EnrollError(res.status, "vpn answered without a server id and secret");
  return { serverId: body.serverId, secret: body.secret, enrolledWith: tokenHash(token) };
}
