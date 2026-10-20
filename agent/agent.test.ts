import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHandler } from "./app.ts";
import { sendHeartbeat, type HeartbeatState } from "./heartbeat.ts";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createUnixServer } from "node:net";
import { applyFiles } from "./apply.ts";
import { renderRules } from "./firewall.ts";
import { disconnect, parseStatus, sessions } from "./management.ts";
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
  it("posts this server to vpn with the token", async () => {
    let received: { auth?: string; body?: unknown } = {};
    const url = await listen(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received = { auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(202).end(JSON.stringify({ status: "accepted", disconnect: ["dev-1"] }));
    });
    const state: HeartbeatState = { ok: false, failures: 0 };
    const disconnect = await sendHeartbeat({ vpnUrl: url, token: "t", id: "edge-1", version: "1.2.3", listen: "tcp/443", openvpnRunning: () => true, configVersion: () => "abc", sessions: () => [] }, state);
    expect(state).toMatchObject({ ok: true, lastStatus: 202, failures: 0 });
    expect(disconnect).toEqual(["dev-1"]);
    expect(received).toEqual({ auth: "Bearer t", body: { id: "edge-1", version: "1.2.3", listen: "tcp/443", openvpnRunning: true, configVersion: "abc", sessions: [] } });
  });

  it("keeps vpn's error when refused", async () => {
    const url = await listen((_req, res) => res.writeHead(409, { "content-type": "application/problem+json" }).end(JSON.stringify({ type: "https://openasy.github.io/problems/version-mismatch", title: "Version mismatch", status: 409, code: "version-mismatch", detail: "install vpn-server 1.2.4" })));
    const state: HeartbeatState = { ok: true, failures: 0 };
    await sendHeartbeat({ vpnUrl: url, token: "t", id: "edge-1", version: "1.2.3", listen: "udp/1194", openvpnRunning: () => false, configVersion: () => undefined, sessions: () => [] }, state);
    expect(state).toMatchObject({ ok: false, lastStatus: 409, lastError: "install vpn-server 1.2.4", failures: 1 });
  });
});

describe("health", () => {
  const base = { version: "1.2.3", openvpnRestarts: () => 2 };

  it("is not ready without config or vpn", async () => {
    const url = await listen(createAgentHandler({ ...base, configVersion: () => undefined, configError: () => "config: 401 Send VPN_SERVER_TOKEN", openvpnRunning: () => false, heartbeat: { ok: false, failures: 3 } }));
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const res = await fetch(`${url}/readyz`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { problems: string[] }).problems).toEqual(["no config from vpn yet: config: 401 Send VPN_SERVER_TOKEN", "vpn unreachable"]);
  });

  it("is ready when OpenVPN runs and vpn answers", async () => {
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
    {
      cn: "3f2b8c1e-5d4a-4f6b-9c2e-7a1d0e9b8f64",
      ip: "10.8.0.2",
      routes: ["172.16.20.0/24", "172.16.40.12/32"],
      fullTunnel: false,
      allow: [
        { cidr: "172.16.20.0/24", proto: "tcp", ports: [5432, 6432] },
        { cidr: "172.16.40.12/32", proto: "any", ports: [] },
      ],
    },
    { cn: "9a1d0e9b-8f64-4f6b-9c2e-3f2b8c1e5d4a", ip: "10.8.0.3", routes: [], fullTunnel: true, allow: [{ cidr: "0.0.0.0/0", proto: "any", ports: [] }] },
  ],
};

describe("config from vpn", () => {
  it("accepts a well-formed config", () => {
    expect(validate(structuredClone(CONFIG))).toEqual(CONFIG);
  });

  it("refuses device ids that could escape the ccd directory, and bad routes", () => {
    expect(() => validate({ ...CONFIG, clients: [{ ...CONFIG.clients[0]!, cn: "../../etc/passwd" }] })).toThrow("bad client");
    expect(() => validate({ ...CONFIG, clients: [{ ...CONFIG.clients[0]!, routes: ["10.0.0.0/33"] }] })).toThrow("bad client");
    expect(() => validate({ ...CONFIG, key: "nope" })).toThrow("key material");
    expect(() => validate({ ...CONFIG, clients: [{ ...CONFIG.clients[0]!, allow: [{ cidr: "1.2.3.0/24", proto: "tcp", ports: [0] }] }] })).toThrow("bad client");
    expect(() => validate({ ...CONFIG, clients: [{ ...CONFIG.clients[0]!, allow: [{ cidr: "1.2.3.0/24; rm -rf /", proto: "any", ports: [] }] }] })).toThrow("bad client");
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

describe("firewall", () => {
  it("lets each device reach only its networks and ports, and drops the rest", () => {
    const rules = renderRules(CONFIG.clients).split("\n");
    expect(rules).toContain("-A OPENASY-VPN -s 10.8.0.2/32 -d 172.16.20.0/24 -p tcp -m multiport --dports 5432,6432 -j ACCEPT");
    expect(rules).toContain("-A OPENASY-VPN -s 10.8.0.2/32 -d 172.16.40.12/32 -j ACCEPT");
    expect(rules).toContain("-A OPENASY-VPN -s 10.8.0.3/32 -d 0.0.0.0/0 -j ACCEPT");
    // Replies come back; nothing else starts a connection to a device or to this server.
    expect(rules.at(-3)).toBe("-A OPENASY-VPN-LOCAL -j DROP");
    expect(rules).toContain("-A OPENASY-VPN -j DROP");
    expect(rules).toContain("-A OPENASY-VPN-TO -j DROP");
    expect(rules.indexOf("-A OPENASY-VPN -j DROP")).toBeGreaterThan(rules.findLastIndex((r) => r.startsWith("-A OPENASY-VPN -s")));
  });

  it("splits long port lists, as multiport takes at most 15", () => {
    const ports = Array.from({ length: 20 }, (_, i) => 8000 + i);
    const rules = renderRules([{ ...CONFIG.clients[0]!, allow: [{ cidr: "10.0.0.0/8", proto: "udp", ports }] }]);
    expect(rules.match(/--dports/g)).toHaveLength(2);
  });
});

// OpenVPN 2.6 `status 3` output, abridged.
const STATUS = [
  "TITLE\tOpenVPN 2.6.14 aarch64-unknown-linux-gnu [SSL (OpenSSL)]",
  "TIME\t2026-10-19 18:21:33\t1760898093",
  "HEADER\tCLIENT_LIST\tCommon Name\tReal Address\tVirtual Address\tVirtual IPv6 Address\tBytes Received\tBytes Sent\tConnected Since\tConnected Since (time_t)\tUsername\tClient ID\tPeer ID\tData Channel Cipher",
  "CLIENT_LIST\tdev-1\t203.0.113.24:51820\t10.8.0.2\t\t1200\t34000\t2026-10-19 18:00:00\t1760896800\tUNDEF\t7\t0\tAES-256-GCM",
  "CLIENT_LIST\tdev-2\t198.51.100.7:40000\t\t\t10\t20\t2026-10-19 18:21:30\t1760898090\tUNDEF\t8\t1\tAES-256-GCM",
  "HEADER\tROUTING_TABLE\tVirtual Address\tCommon Name\tReal Address\tLast Ref\tLast Ref (time_t)",
  "GLOBAL_STATS\tMax bcast/mcast queue length\t0",
  "END",
];

describe("OpenVPN management", () => {
  it("parses connected clients and skips ones without an address yet", () => {
    expect(parseStatus(STATUS)).toEqual([
      { cn: "dev-1", realAddress: "203.0.113.24:51820", vpnIp: "10.8.0.2", bytesIn: 1200, bytesOut: 34000, connectedAt: "2025-10-19T18:00:00.000Z", clientId: "7" },
    ]);
  });

  it("talks the management protocol over a Unix socket", async () => {
    const socket = join(mkdtempSync(join(tmpdir(), "mgmt-")), "m.sock");
    const seen: string[] = [];
    const fake = createUnixServer((c) => {
      c.write(">INFO:OpenVPN Management Interface Version 5 -- type 'help' for more info\r\n");
      c.on("data", (d) => {
        const cmd = d.toString().trim();
        seen.push(cmd);
        c.write(cmd === "status 3" ? STATUS.join("\r\n") + "\r\n" : "SUCCESS: client-kill command succeeded\r\n");
      });
    });
    await new Promise<void>((r) => fake.listen(socket, r));
    expect((await sessions(socket)).map((s) => s.cn)).toEqual(["dev-1"]);
    await disconnect(socket, "7");
    expect(seen).toEqual(["status 3", "client-kill 7"]);
    await new Promise((r) => fake.close(r));
  });
});
