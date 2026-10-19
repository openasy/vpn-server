import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHandler } from "./app.ts";
import { sendHeartbeat, type HeartbeatState } from "./heartbeat.ts";
import { parseListen } from "./listen.ts";
import { OpenVpn } from "./openvpn.ts";

const servers: Server[] = [];
afterEach(() => Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))));

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

describe("heartbeat", () => {
  it("posts this server to vpn-manager with the token", async () => {
    let received: { auth?: string; body?: unknown } = {};
    const url = await listen(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received = { auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(202).end("{}");
    });
    const state: HeartbeatState = { ok: false, failures: 0 };
    await sendHeartbeat({ managerUrl: url, token: "t", id: "edge-1", version: "1.2.3", listen: "tcp/443", openvpnRunning: () => true }, state);
    expect(state).toMatchObject({ ok: true, lastStatus: 202, failures: 0 });
    expect(received).toEqual({ auth: "Bearer t", body: { id: "edge-1", version: "1.2.3", listen: "tcp/443", openvpnRunning: true } });
  });

  it("keeps the manager's error when refused", async () => {
    const url = await listen((_req, res) => res.writeHead(409).end(JSON.stringify({ error: "install vpn-server 1.2.4" })));
    const state: HeartbeatState = { ok: true, failures: 0 };
    await sendHeartbeat({ managerUrl: url, token: "t", id: "edge-1", version: "1.2.3", openvpnRunning: () => false }, state);
    expect(state).toMatchObject({ ok: false, lastStatus: 409, lastError: "install vpn-server 1.2.4", failures: 1 });
  });
});

describe("health", () => {
  const base = { version: "1.2.3", openvpnRestarts: () => 2 };

  it("is not ready without config or manager", async () => {
    const url = await listen(createAgentHandler({ ...base, configured: false, openvpnRunning: () => false, heartbeat: { ok: false, failures: 3 } }));
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const res = await fetch(`${url}/readyz`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { problems: string[] }).problems).toEqual(["no OpenVPN config", "vpn-manager unreachable"]);
  });

  it("is ready when OpenVPN runs and the manager answers", async () => {
    const url = await listen(createAgentHandler({ ...base, configured: true, openvpnRunning: () => true, heartbeat: { ok: true, failures: 0 } }));
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toContain('openasy_build_info{product="vpn-server",version="1.2.3"} 1');
    expect(metrics).toContain("openasy_openvpn_up 1");
    expect(metrics).toContain("openasy_openvpn_restarts_total 2");
  });
});

describe("OpenVpn supervisor", () => {
  it("starts, reports running and stops", async () => {
    const vpn = new OpenVpn("sleep", ["30"]);
    vpn.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(vpn.running).toBe(true);
    await vpn.stop();
    expect(vpn.running).toBe(false);
  });

  it("restarts a process that exits, backing off while it keeps crashing", async () => {
    const vpn = new OpenVpn("true", []);
    vpn.start();
    await new Promise((r) => setTimeout(r, 2500));
    // Restarts at 0 s and 1 s, then waits 2 s: 2 restarts in 2.5 s, where a constant 1 s delay would give 3.
    expect(vpn.restarts).toBe(2);
    await vpn.stop();
  }, 10_000);
});

describe("listen", () => {
  it("leaves the config file in charge when unset", () => {
    expect(parseListen(undefined, undefined)).toEqual({ args: [], label: undefined });
  });

  it("overrides protocol and port, TCP as a server", () => {
    expect(parseListen("tcp", "443")).toEqual({ args: ["--proto", "tcp-server", "--port", "443"], label: "tcp/443" });
    expect(parseListen("udp", "1194").args).toEqual(["--proto", "udp", "--port", "1194"]);
  });

  it("rejects bad values", () => {
    expect(() => parseListen("sctp", "443")).toThrow("udp or tcp");
    expect(() => parseListen("tcp", "70000")).toThrow("1-65535");
  });
});
