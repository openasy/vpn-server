import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { createAgentHandler } from "./app.ts";
import { applyFiles, ensureNat } from "./apply.ts";
import { render, validate } from "./config.ts";
import { sendHeartbeat, type HeartbeatState } from "./heartbeat.ts";
import { parseListen, type Listen } from "./listen.ts";
import { log } from "./log.ts";
import { OpenVpn } from "./openvpn.ts";
import { fetchConfig } from "./sync.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const managerUrl = process.env.VPN_MANAGER_URL;
const token = process.env.VPN_SERVER_TOKEN;
if (!managerUrl || !token) {
  log("error", "VPN_MANAGER_URL and VPN_SERVER_TOKEN are required");
  process.exit(1);
}
const id = (process.env.VPN_SERVER_ID ?? hostname()).toLowerCase();
const stateDir = process.env.VPN_STATE_DIR ?? "/var/lib/openasy-vpn";
const managementSocket = process.env.OPENVPN_MANAGEMENT ?? "/run/openasy-vpn/management.sock";
const port = Number(process.env.PORT ?? 9100);
const interval = Number(process.env.HEARTBEAT_SECONDS ?? 15) * 1000;

let listen: Listen;
try {
  listen = parseListen(process.env.OPENVPN_PROTO, process.env.OPENVPN_PORT);
} catch (err) {
  log("error", (err as Error).message);
  process.exit(1);
}

mkdirSync(stateDir, { recursive: true, mode: 0o755 });
mkdirSync(dirname(managementSocket), { recursive: true });

const openvpn = new OpenVpn(process.env.OPENVPN_BIN ?? "openvpn", ["--config", `${stateDir}/server.conf`]);
const heartbeat: HeartbeatState = { ok: false, failures: 0 };
let applied: string | undefined;
let etag: string | undefined;
let configError: string | undefined;
let natFor: string | undefined;

/** Pulls the desired state, applies it, then reports. */
async function tick() {
  try {
    const fetched = await fetchConfig(managerUrl!, token!, id, etag);
    if (fetched.changed) {
      const config = validate(fetched.config);
      const { restart } = applyFiles(stateDir, render(config, listen, stateDir, managementSocket));
      if (natFor !== config.network) {
        await ensureNat(config.network);
        natFor = config.network;
      }
      if (restart || !openvpn.running) {
        log("info", applied ? "config changed, restarting OpenVPN" : "config received, starting OpenVPN", { version: config.version });
        await openvpn.restart();
      } else {
        log("info", "config updated without a restart", { version: config.version, clients: config.clients.length });
      }
      applied = config.version;
      etag = fetched.etag;
    }
    configError = undefined;
  } catch (err) {
    configError = (err as Error).message;
    log("warn", "could not apply the config; keeping the last good one", { error: configError });
  }
  await sendHeartbeat({ managerUrl: managerUrl!, token: token!, id, version, listen: listen.label, openvpnRunning: () => openvpn.running, configVersion: () => applied }, heartbeat);
}

let busy = false;
const loop = () => {
  if (busy) return;
  busy = true;
  void tick().finally(() => (busy = false));
};
loop();
const timer = setInterval(loop, interval);

const server = createServer(
  createAgentHandler({
    version,
    listen: listen.label,
    configVersion: () => applied,
    configError: () => configError,
    openvpnRunning: () => openvpn.running,
    openvpnRestarts: () => openvpn.restarts,
    heartbeat,
  }),
);
server.listen(port, () => log("info", "vpn-server started", { version, id, port, listen: listen.label, manager: managerUrl }));

async function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  clearInterval(timer);
  setTimeout(() => process.exit(1), 10_000).unref();
  await openvpn.stop();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
