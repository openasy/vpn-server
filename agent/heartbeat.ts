import { log } from "./log.ts";

export interface HeartbeatOptions {
  managerUrl: string;
  token: string;
  id: string;
  version: string;
  /** "udp/1194", "tcp/443". */
  listen: string;
  openvpnRunning: () => boolean;
  /** Version of the config this agent applied. */
  configVersion: () => string | undefined;
}

export interface HeartbeatState {
  ok: boolean;
  lastStatus?: number;
  lastError?: string;
  failures: number;
}

/** Reports this server to vpn-manager through its public API (ADR 0018). */
export async function sendHeartbeat(opts: HeartbeatOptions, state: HeartbeatState): Promise<void> {
  try {
    const res = await fetch(new URL("/api/v1/servers/heartbeat", opts.managerUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: opts.id, version: opts.version, listen: opts.listen, openvpnRunning: opts.openvpnRunning(), configVersion: opts.configVersion() ?? null }),
      signal: AbortSignal.timeout(5000),
    });
    state.lastStatus = res.status;
    state.ok = res.ok;
    if (res.ok) {
      state.lastError = undefined;
      return;
    }
    // vpn-manager answers with RFC 9457 Problem Details (ADR 0024).
    const problem = (await res.json().catch(() => ({}))) as { detail?: string; title?: string };
    state.lastError = problem.detail ?? problem.title ?? res.statusText;
  } catch (err) {
    state.ok = false;
    state.lastStatus = undefined;
    state.lastError = String(err);
  }
  state.failures++;
  log("warn", "heartbeat failed", { status: state.lastStatus, error: state.lastError });
}
