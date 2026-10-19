import { log } from "./log.ts";

export interface HeartbeatOptions {
  managerUrl: string;
  token: string;
  id: string;
  version: string;
  /** "tcp/443" when set by environment. */
  listen?: string;
  openvpnRunning: () => boolean;
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
      body: JSON.stringify({ id: opts.id, version: opts.version, listen: opts.listen, openvpnRunning: opts.openvpnRunning() }),
      signal: AbortSignal.timeout(5000),
    });
    state.lastStatus = res.status;
    state.ok = res.ok;
    if (res.ok) {
      state.lastError = undefined;
      return;
    }
    state.lastError = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText;
  } catch (err) {
    state.ok = false;
    state.lastStatus = undefined;
    state.lastError = String(err);
  }
  state.failures++;
  log("warn", "heartbeat failed", { status: state.lastStatus, error: state.lastError });
}
