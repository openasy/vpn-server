import { Resolver } from "node:dns/promises";
import { describe, expect, it } from "vitest";
import { render, tunnelAddress, validate, type ServerConfig } from "./config.ts";
import { answer, parseUpstream, serveDns, validRecord, type Zone } from "./dns.ts";
import { renderRules } from "./firewall.ts";
import { parseListen } from "./listen.ts";

const ZONE: Zone = {
  domain: "internal.yr",
  records: [
    { name: "web.internal.yr", type: "A", value: "172.16.20.5" },
    { name: "web.internal.yr", type: "AAAA", value: "fd00::5" },
    { name: "grafana.internal.yr", type: "CNAME", value: "web.internal.yr" },
    { name: "docs.internal.yr", type: "CNAME", value: "docs.example.com" },
  ],
  // The inside view alone; forwarding is tested below.
  forward: false,
};
/** answer() for a query this server answers itself. */
const ask = (q: Buffer, z: Zone = ZONE) => answer(q, z) as Buffer;

/** A standard query for one name, as a resolver sends it. */
function query(name: string, type: number, id = 0x1234, flags = 0x0100): Buffer {
  const labels = name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(flags, 2);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([head, ...labels, Buffer.from([0]), tail]);
}
const rcode = (b: Buffer) => b.readUInt16BE(2) & 0xf;
const count = (b: Buffer) => b.readUInt16BE(6);

describe("internal names (ADR 0054)", () => {
  it("answer names in the domain, authoritatively, and say a missing one does not exist", () => {
    const a = ask(query("WEB.internal.yr", 1), ZONE)!;
    expect(a.readUInt16BE(0)).toBe(0x1234);
    expect(a.readUInt16BE(2) & 0x8400).toBe(0x8400); // a response, authoritative
    expect(rcode(a)).toBe(0);
    expect([...a.subarray(-4)]).toEqual([172, 16, 20, 5]);
    expect(count(ask(query("web.internal.yr", 28), ZONE)!)).toBe(1);
    // A name with records of another type only: no data, not an error.
    expect(rcode(ask(query("web.internal.yr", 16), ZONE)!)).toBe(0);
    expect(count(ask(query("web.internal.yr", 16), ZONE)!)).toBe(0);
    expect(rcode(ask(query("missing.internal.yr", 1), ZONE)!)).toBe(3);
    // The domain itself exists, with no address.
    expect(rcode(ask(query("internal.yr", 1), ZONE)!)).toBe(0);
  });

  it("follow an alias to its target in the zone, and only point to one outside it", () => {
    const a = ask(query("grafana.internal.yr", 1), ZONE)!;
    expect(count(a)).toBe(2);
    expect([...a.subarray(-4)]).toEqual([172, 16, 20, 5]);
    expect(count(ask(query("docs.internal.yr", 1), ZONE)!)).toBe(1);
  });

  it("refuse every other domain and never forward, and refuse what is not a plain query", () => {
    expect(rcode(ask(query("example.com", 1), ZONE)!)).toBe(5);
    expect(rcode(ask(query("notinternal.yr", 1), ZONE)!)).toBe(5);
    expect(rcode(ask(query("web.internal.yr", 1, 1, 0x2800), ZONE)!)).toBe(4); // an update
    expect(answer(query("web.internal.yr", 1, 1, 0x8000), ZONE)).toBeUndefined(); // a response
    expect(answer(Buffer.alloc(5), ZONE)).toBeUndefined();
    const truncated = query("web.internal.yr", 1).subarray(0, 20);
    expect(rcode(ask(truncated, ZONE)!)).toBe(1);
    const pointer = Buffer.concat([query("x", 1).subarray(0, 12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1])]);
    expect(rcode(ask(pointer, ZONE)!)).toBe(1);
  });

  it("take only records in the domain, of their type", () => {
    expect(validRecord({ name: "a.internal.yr", type: "A", value: "10.0.0.1" }, "internal.yr")).toBe(true);
    expect(validRecord({ name: "a.example.com", type: "A", value: "10.0.0.1" }, "internal.yr")).toBe(false);
    expect(validRecord({ name: "a.internal.yr", type: "A", value: "fd00::1" }, "internal.yr")).toBe(false);
    expect(validRecord({ name: "a.internal.yr", type: "AAAA", value: "10.0.0.1" }, "internal.yr")).toBe(false);
    expect(validRecord({ name: "a.internal.yr", type: "CNAME", value: "a.internal.yr" }, "internal.yr")).toBe(false);
    expect(validRecord({ name: "a b.internal.yr", type: "A", value: "10.0.0.1" }, "internal.yr")).toBe(false);
  });

  it("leave a name they have no record for to the outside world: split-horizon", () => {
    const open = { ...ZONE, forward: true };
    expect(answer(query("www.internal.yr", 1), open)).toBe("forward");
    expect(answer(query("internal.yr", 15), open)).toBe("forward"); // the domain's own MX, and the like
    // A name with a record here is the inside view's alone, even for a type it lacks.
    expect(rcode(ask(query("web.internal.yr", 16), open))).toBe(0);
    expect(count(ask(query("web.internal.yr", 1), open))).toBe(1);
    // Another domain is still refused: the server is not an open resolver.
    expect(rcode(ask(query("example.com", 1), open))).toBe(5);
    expect(parseUpstream("1.1.1.1")).toEqual({ host: "1.1.1.1", port: 53 });
    expect(parseUpstream("127.0.0.11:5353")).toEqual({ host: "127.0.0.11", port: 5353 });
    expect(parseUpstream("[fd00::1]:53")).toEqual({ host: "fd00::1", port: 53 });
    expect(parseUpstream("fd00::1")).toEqual({ host: "fd00::1", port: 53 });
    expect(parseUpstream("dns.example.com")).toBeUndefined();
  });

  it("ask the upstream resolver for the domain's public names, over UDP and TCP, and fail plainly without one", async () => {
    // The outside view of the same domain, as public DNS would answer it.
    const outside = serveDns(
      () => ({ domain: "internal.yr", records: [{ name: "www.internal.yr", type: "A", value: "203.0.113.7" }], forward: false }),
      "127.0.0.1",
      15354,
    );
    await outside.start();
    const inside = serveDns(() => ({ ...ZONE, forward: true }), "127.0.0.1", 15355, [{ host: "127.0.0.1", port: 15354 }], 300);
    await inside.start();
    try {
      const r = new Resolver({ timeout: 4000, tries: 1 });
      r.setServers(["127.0.0.1:15355"]);
      expect(await r.resolve4("www.internal.yr")).toEqual(["203.0.113.7"]);
      expect(await r.resolve4("web.internal.yr")).toEqual(["172.16.20.5"]);
      await expect(r.resolve4("missing.internal.yr")).rejects.toMatchObject({ code: "ENOTFOUND" });
      await expect(r.resolve4("example.com")).rejects.toMatchObject({ code: "EREFUSED" });
      const { connect } = await import("node:net");
      const viaTcp = await new Promise<Buffer>((resolve, reject) => {
        const q = query("www.internal.yr", 1);
        const sock = connect(15355, "127.0.0.1", () => sock.write(Buffer.concat([Buffer.from([0, q.length]), q])));
        sock.once("data", (d: Buffer) => (sock.end(), resolve(d)));
        sock.once("error", reject);
      });
      expect([...viaTcp.subarray(-4)]).toEqual([203, 0, 113, 7]);
      outside.stop();
      await expect(r.resolve4("www.internal.yr")).rejects.toMatchObject({ code: "ESERVFAIL" });
    } finally {
      outside.stop();
      inside.stop();
    }
  }, 15_000);

  it("are served over UDP and TCP to a real resolver", async () => {
    const server = serveDns(() => ZONE, "127.0.0.1", 15353);
    await server.start();
    try {
      const r = new Resolver();
      r.setServers(["127.0.0.1:15353"]);
      expect(await r.resolve4("web.internal.yr")).toEqual(["172.16.20.5"]);
      expect(await r.resolve6("web.internal.yr")).toEqual(["fd00::5"]);
      expect(await r.resolveCname("grafana.internal.yr")).toEqual(["web.internal.yr"]);
      await expect(r.resolve4("missing.internal.yr")).rejects.toMatchObject({ code: "ENOTFOUND" });
      await expect(r.resolve4("example.com")).rejects.toMatchObject({ code: "EREFUSED" });
      // TCP, with its length prefix.
      const { connect } = await import("node:net");
      const reply = await new Promise<Buffer>((resolve, reject) => {
        const q = query("web.internal.yr", 1);
        const sock = connect(15353, "127.0.0.1", () => sock.write(Buffer.concat([Buffer.from([0, q.length]), q])));
        sock.once("data", (d: Buffer) => (sock.end(), resolve(d)));
        sock.once("error", reject);
      });
      expect([...reply.subarray(-4)]).toEqual([172, 16, 20, 5]);
    } finally {
      server.stop();
    }
  });
});

describe("internal names in the config", () => {
  const PEM = (tag: string) => `-----BEGIN ${tag}-----\nAAAA\n-----END ${tag}-----`;
  const config = (over: Partial<ServerConfig> = {}): ServerConfig => ({
    version: "v1",
    network: "10.8.0.0/24",
    ca: PEM("CERTIFICATE"),
    cert: PEM("CERTIFICATE"),
    key: PEM("PRIVATE KEY"),
    crl: PEM("X509 CRL"),
    tlsCrypt: PEM("OpenVPN Static key V1"),
    clients: [
      { cn: "3f2b8c1e-5d4a-4f6b-9c2e-7a1d0e9b8f64", ip: "10.8.0.2", routes: [], fullTunnel: false, allow: [] },
      { cn: "9a1d0e9b-8f64-4f6b-9c2e-3f2b8c1e5d4a", ip: "10.8.0.3", routes: [], fullTunnel: false, allow: [], dns: false },
    ],
    ...over,
  });
  const ccd = (c: ServerConfig, i: number) => Object.values(render(c, parseListen("udp", "1194"), "/state", "/m.sock").ccd)[i]!;

  it("push the server as the resolver for the domain alone, to devices that keep it on", () => {
    expect(tunnelAddress("10.8.0.0/24")).toBe("10.8.0.1");
    const c = config({ dns: ZONE });
    expect(ccd(c, 0)).toContain('push "dhcp-option DNS 10.8.0.1"');
    expect(ccd(c, 0)).toContain('push "dhcp-option DOMAIN-ROUTE internal.yr"');
    expect(ccd(c, 0)).toContain('push "dns server 0 resolve-domains internal.yr"');
    // A device with the option off keeps the connection it has today.
    expect(ccd(c, 1)).not.toContain("dhcp-option DNS");
    // Without a domain, nothing is pushed.
    expect(ccd(config(), 0)).not.toContain("dhcp-option");
  });

  it("open only port 53 on the tunnel address, and only with a domain", () => {
    expect(renderRules(config().clients)).not.toContain("--dport 53");
    const rules = renderRules(config().clients, "10.8.0.1");
    expect(rules).toContain("-A OPENASY-VPN-LOCAL -d 10.8.0.1/32 -p udp --dport 53 -j ACCEPT");
    expect(rules).toContain("-A OPENASY-VPN-LOCAL -d 10.8.0.1/32 -p tcp --dport 53 -j ACCEPT");
    expect(rules.indexOf("--dport 53")).toBeLessThan(rules.indexOf("-A OPENASY-VPN-LOCAL -j DROP"));
  });

  it("are refused when out of shape, before anything is written", () => {
    expect(() => validate(config({ dns: ZONE }))).not.toThrow();
    expect(() => validate(config({ dns: { domain: "Internal YR", records: [] } }))).toThrow("bad dns domain");
    expect(() => validate(config({ dns: { domain: "internal.yr", records: [{ name: "x.example.com", type: "A", value: "1.2.3.4" }] } }))).toThrow(
      "bad dns record",
    );
    expect(() => validate({ ...config(), clients: [{ ...config().clients[0]!, dns: "yes" }] })).toThrow("bad client");
  });
});
