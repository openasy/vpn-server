import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHandler } from "./app.ts";
import { sendHeartbeat, type HeartbeatState } from "./heartbeat.ts";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFiles } from "./apply.ts";
import { render, validate, type ServerConfig } from "./config.ts";
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
    await sendHeartbeat({ managerUrl: url, token: "t", id: "edge-1", version: "1.2.3", listen: "tcp/443", openvpnRunning: () => true, configVersion: () => "abc" }, state);
    expect(state).toMatchObject({ ok: true, lastStatus: 202, failures: 0 });
    expect(received).toEqual({ auth: "Bearer t", body: { id: "edge-1", version: "1.2.3", listen: "tcp/443", openvpnRunning: true, configVersion: "abc" } });
  });

  it("keeps the manager's error when refused", async () => {
    const url = await listen((_req, res) => res.writeHead(409, { "content-type": "application/problem+json" }).end(JSON.stringify({ type: "https://openasy.github.io/problems/version-mismatch", title: "Version mismatch", status: 409, code: "version-mismatch", detail: "install vpn-server 1.2.4" })));
    const state: HeartbeatState = { ok: true, failures: 0 };
    await sendHeartbeat({ managerUrl: url, token: "t", id: "edge-1", version: "1.2.3", listen: "udp/1194", openvpnRunning: () => false, configVersion: () => undefined }, state);
    expect(state).toMatchObject({ ok: false, lastStatus: 409, lastError: "install vpn-server 1.2.4", failures: 1 });
  });
});

describe("health", () => {
  const base = { version: "1.2.3", openvpnRestarts: () => 2 };

  it("is not ready without config or manager", async () => {
    const url = await listen(createAgentHandler({ ...base, configVersion: () => undefined, configError: () => "config: 401 Send VPN_SERVER_TOKEN", openvpnRunning: () => false, heartbeat: { ok: false, failures: 3 } }));
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const res = await fetch(`${url}/readyz`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { problems: string[] }).problems).toEqual(["no config from vpn-manager yet: config: 401 Send VPN_SERVER_TOKEN", "vpn-manager unreachable"]);
  });

  it("is ready when OpenVPN runs and the manager answers", async () => {
    const url = await listen(createAgentHandler({ ...base, configVersion: () => "abc", configError: () => undefined, openvpnRunning: () => true, heartbeat: { ok: true, failures: 0 } }));
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
  it("defaults to UDP 1194", () => {
    expect(parseListen(undefined, undefined)).toEqual({ proto: "udp", port: 1194, label: "udp/1194" });
  });

  it("takes protocol and port from the environment", () => {
    expect(parseListen("tcp", "443")).toEqual({ proto: "tcp", port: 443, label: "tcp/443" });
  });

  it("rejects bad values", () => {
    expect(() => parseListen("sctp", "443")).toThrow("udp or tcp");
    expect(() => parseListen("tcp", "70000")).toThrow("1-65535");
  });
});

const PEM = (tag: string) => `-----BEGIN ${tag}-----\nAA==\n-----END ${tag}-----\n`;
const CONFIG: ServerConfig = {
  version: "v1",
  network: "10.8.0.0/24",
  ca: PEM("CERTIFICATE"),
  cert: PEM("CERTIFICATE"),
  key: PEM("PRIVATE KEY"),
  crl: PEM("X509 CRL"),
  tlsCrypt: PEM("OpenVPN Static key V1"),
  clients: [
    { cn: "3f2b8c1e-5d4a-4f6b-9c2e-7a1d0e9b8f64", ip: "10.8.0.2", routes: ["172.16.20.0/24", "172.16.40.12/32"], fullTunnel: false },
    { cn: "9a1d0e9b-8f64-4f6b-9c2e-3f2b8c1e5d4a", ip: "10.8.0.3", routes: [], fullTunnel: true },
  ],
};

describe("config from vpn-manager", () => {
  it("accepts a well-formed config", () => {
    expect(validate(structuredClone(CONFIG))).toEqual(CONFIG);
  });

  it("refuses device ids that could escape the ccd directory, and bad routes", () => {
    expect(() => validate({ ...CONFIG, clients: [{ ...CONFIG.clients[0]!, cn: "../../etc/passwd" }] })).toThrow("bad client");
    expect(() => validate({ ...CONFIG, clients: [{ ...CONFIG.clients[0]!, routes: ["10.0.0.0/33"] }] })).toThrow("bad client");
    expect(() => validate({ ...CONFIG, key: "nope" })).toThrow("key material");
  });

  it("renders the server config, and one ccd file per device with its address and routes", () => {
    const files = render(CONFIG, parseListen("tcp", "443"), "/state", "/run/m.sock");
    const conf = files.restart["server.conf"]!;
    expect(conf).toContain("server 10.8.0.0 255.255.255.0");
    expect(conf).toContain("proto tcp-server\nport 443");
    expect(conf).toContain("ccd-exclusive");
    expect(conf).toContain("user nobody");
    expect(conf).not.toContain("explicit-exit-notify");
    expect(files.ccd[CONFIG.clients[0]!.cn]).toBe('ifconfig-push 10.8.0.2 255.255.255.0\npush "route 172.16.20.0 255.255.255.0"\npush "route 172.16.40.12 255.255.255.255"\n');
    expect(files.ccd[CONFIG.clients[1]!.cn]).toContain("redirect-gateway def1");
  });

  it("restarts OpenVPN only when certificates or the server config change", () => {
    const dir = mkdtempSync(join(tmpdir(), "vpn-state-"));
    const listen = parseListen(undefined, undefined);
    expect(applyFiles(dir, render(CONFIG, listen, dir, "/m.sock")).restart).toBe(true);
    // A revoked device: new CRL, one ccd file fewer. OpenVPN reads both on the next connection.
    const fewer = { ...CONFIG, crl: PEM("X509 CRL") + "\n", clients: CONFIG.clients.slice(0, 1) };
    expect(applyFiles(dir, render(fewer, listen, dir, "/m.sock")).restart).toBe(false);
    expect(readdirSync(join(dir, "ccd"))).toEqual([CONFIG.clients[0]!.cn]);
    expect(statSync(join(dir, "server.key")).mode & 0o777).toBe(0o600);
    expect(applyFiles(dir, render({ ...fewer, cert: PEM("CERTIFICATE") + "\n" }, listen, dir, "/m.sock")).restart).toBe(true);
  });
});
