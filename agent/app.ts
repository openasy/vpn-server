import type { IncomingMessage, ServerResponse } from "node:http";
import type { HeartbeatState } from "./heartbeat.ts";

export interface AgentStatus {
  version: string;
  listen?: string;
  /** Version of the config from vpn-manager that is applied, if any. */
  configVersion: () => string | undefined;
  configError: () => string | undefined;
  openvpnRunning: () => boolean;
  openvpnRestarts: () => number;
  heartbeat: HeartbeatState;
}

function send(res: ServerResponse, status: number, body: string, type = "application/json") {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), "x-content-type-options": "nosniff" });
  res.end(body);
}

/** Health and metrics for the agent (ADR 0017). The agent has no API of its own. */
export function createAgentHandler(s: AgentStatus) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/healthz") return send(res, 200, JSON.stringify({ status: "ok" }));

    if (path === "/readyz") {
      const problems = [
        !s.configVersion() && `no config from vpn-manager yet${s.configError() ? `: ${s.configError()}` : ""}`,
        s.configVersion() && !s.openvpnRunning() && "OpenVPN not running",
        !s.heartbeat.ok && `vpn-manager unreachable${s.heartbeat.lastError ? `: ${s.heartbeat.lastError}` : ""}`,
      ].filter(Boolean);
      return send(res, problems.length ? 503 : 200, JSON.stringify(problems.length ? { status: "not ready", problems } : { status: "ready" }));
    }

    if (path === "/metrics") {
      const lines = [
        "# HELP openasy_build_info Build information.",
        "# TYPE openasy_build_info gauge",
        `openasy_build_info{product="vpn-server",version="${s.version}"} 1`,
        "# HELP openasy_openvpn_up Whether the OpenVPN process is running.",
        "# TYPE openasy_openvpn_up gauge",
        `openasy_openvpn_up${s.listen ? `{listen="${s.listen}"}` : ""} ${s.openvpnRunning() ? 1 : 0}`,
        "# HELP openasy_openvpn_restarts_total Times OpenVPN was restarted.",
        "# TYPE openasy_openvpn_restarts_total counter",
        `openasy_openvpn_restarts_total ${s.openvpnRestarts()}`,
        "# HELP openasy_heartbeat_failures_total Failed heartbeats to vpn-manager.",
        "# TYPE openasy_heartbeat_failures_total counter",
        `openasy_heartbeat_failures_total ${s.heartbeat.failures}`,
      ];
      return send(res, 200, lines.join("\n") + "\n", "text/plain; version=0.0.4");
    }

    send(res, 404, JSON.stringify({ error: "not found" }));
  };
}
