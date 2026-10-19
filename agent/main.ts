import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { createAgentHandler } from "./app.ts";
import { sendHeartbeat, type HeartbeatState } from "./heartbeat.ts";
import { parseListen, type Listen } from "./listen.ts";
import { log } from "./log.ts";
import { OpenVpn } from "./openvpn.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const managerUrl = process.env.VPN_MANAGER_URL;
const token = process.env.VPN_SERVER_TOKEN;
if (!managerUrl || !token) {
  log("error", "VPN_MANAGER_URL and VPN_SERVER_TOKEN are required");
  process.exit(1);
}
const id = process.env.VPN_SERVER_ID ?? hostname().toLowerCase();
const config = process.env.OPENVPN_CONFIG ?? "/etc/openvpn/server.conf";
const port = Number(process.env.PORT ?? 9100);
const interval = Number(process.env.HEARTBEAT_SECONDS ?? 15) * 1000;

let listen: Listen;
try {
  listen = parseListen(process.env.OPENVPN_PROTO, process.env.OPENVPN_PORT);
} catch (err) {
  log("error", (err as Error).message);
  process.exit(1);
}

const configured = existsSync(config);
const openvpn = new OpenVpn(process.env.OPENVPN_BIN ?? "openvpn", ["--config", config, ...listen.args]);
if (configured) openvpn.start();
else log("warn", "no OpenVPN config, not starting OpenVPN", { config });

const heartbeat: HeartbeatState = { ok: false, failures: 0 };
const beat = () => sendHeartbeat({ managerUrl, token, id, version, listen: listen.label, openvpnRunning: () => openvpn.running }, heartbeat);
void beat();
const timer = setInterval(beat, interval);

const server = createServer(
  createAgentHandler({ version, listen: listen.label, configured, openvpnRunning: () => openvpn.running, openvpnRestarts: () => openvpn.restarts, heartbeat }),
);
server.listen(port, () => log("info", "vpn-server started", { version, id, port, listen: listen.label ?? "from config", manager: managerUrl, configured }));

async function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  clearInterval(timer);
  setTimeout(() => process.exit(1), 10_000).unref();
  await openvpn.stop();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
