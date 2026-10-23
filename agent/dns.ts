// The install's internal names (ADR 0054): a DNS server for one domain, on the tunnel's own address. It answers names
// in the domain from the records vpn sends: split-horizon, the inside view of the domain. A name it has no record for
// is asked of the upstream resolver, so the domain's public names keep working on the VPN, or, with forwarding off,
// does not exist. Every other domain is refused: devices keep their own resolver for it, and the server is never an
// open resolver.
import { createSocket, type Socket } from "node:dgram";
import { connect, createServer, isIPv4, isIPv6, type Server } from "node:net";

export interface DnsRecord {
  /** Fully qualified, lower case, without the trailing dot: web.internal.yr. */
  name: string;
  type: "A" | "AAAA" | "CNAME";
  value: string;
}
export interface Zone {
  domain: string;
  records: DnsRecord[];
  /** Ask the upstream resolver for names in the domain that have no record here; on unless false. */
  forward?: boolean;
}

const TYPE = { A: 1, CNAME: 5, AAAA: 28 } as const;
const RCODE = { ok: 0, formErr: 1, servFail: 2, nxDomain: 3, notImp: 4, refused: 5 } as const;
const TTL = 60;
const CLASS_IN = 1;

/** A query's name as labels, or undefined when it is malformed or compressed (queries are not). */
function readName(msg: Buffer, at: number): { labels: string[]; end: number } | undefined {
  const labels: string[] = [];
  let i = at;
  let length = 0;
  for (;;) {
    if (i >= msg.length) return undefined;
    const n = msg[i]!;
    if (n === 0) return { labels, end: i + 1 };
    if (n > 63 || i + 1 + n > msg.length) return undefined;
    length += n + 1;
    if (length > 254) return undefined;
    labels.push(msg.toString("latin1", i + 1, i + 1 + n));
    i += 1 + n;
  }
}

function writeName(name: string): Buffer {
  const parts = name.split(".").filter(Boolean);
  return Buffer.concat([...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, "latin1")])), Buffer.from([0])]);
}

function rdata(r: DnsRecord): Buffer {
  if (r.type === "A") return Buffer.from(r.value.split(".").map(Number));
  if (r.type === "AAAA") {
    const [head, tail] = r.value.includes("::") ? r.value.split("::") : [r.value, undefined];
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
    const out = Buffer.alloc(16);
    groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || "0", 16), i * 2));
    return out;
  }
  return writeName(r.value);
}

function record(name: Buffer, r: DnsRecord): Buffer {
  const data = rdata(r);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(TYPE[r.type], 0);
  head.writeUInt16BE(CLASS_IN, 2);
  head.writeUInt32BE(TTL, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([name, head, data]);
}

/** A record's shape is checked before it is served: a name in the domain and a value of its type. */
export function validRecord(r: DnsRecord, domain: string): boolean {
  const NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
  if (!r || typeof r.name !== "string" || !NAME.test(r.name) || !(r.name === domain || r.name.endsWith(`.${domain}`))) return false;
  if (r.type === "A") return isIPv4(r.value);
  if (r.type === "AAAA") return isIPv6(r.value) && !r.value.includes(".");
  if (r.type === "CNAME") return typeof r.value === "string" && NAME.test(r.value) && r.value !== r.name;
  return false;
}

/**
 * The answer to one query; "forward" for a name in the domain this server has no record for, when forwarding is on;
 * or undefined when the message is too short to answer at all. Pure, so the whole behaviour is tested without a socket.
 */
export function answer(query: Buffer, zone: Zone): Buffer | "forward" | undefined {
  if (query.length < 12) return undefined;
  const id = query.readUInt16BE(0);
  const flags = query.readUInt16BE(2);
  // A response, or anything but a standard query with one question, is not ours to answer in full.
  if (flags & 0x8000) return undefined;
  const opcode = (flags >> 11) & 0xf;
  const rd = flags & 0x0100;
  const qdcount = query.readUInt16BE(4);
  const reply = (rcode: number, question: Buffer, answers: Buffer[] = [], authoritative = false) => {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(id, 0);
    head.writeUInt16BE(0x8000 | (opcode << 11) | (authoritative ? 0x0400 : 0) | rd | rcode, 2);
    head.writeUInt16BE(question.length ? 1 : 0, 4);
    head.writeUInt16BE(answers.length, 6);
    return Buffer.concat([head, question, ...answers]);
  };
  if (opcode !== 0) return reply(RCODE.notImp, Buffer.alloc(0));
  if (qdcount !== 1) return reply(RCODE.formErr, Buffer.alloc(0));
  const name = readName(query, 12);
  if (!name || name.end + 4 > query.length) return reply(RCODE.formErr, Buffer.alloc(0));
  const question = query.subarray(12, name.end + 4);
  const qtype = query.readUInt16BE(name.end);
  const qclass = query.readUInt16BE(name.end + 2);
  const asked = name.labels.join(".").toLowerCase();
  const domain = zone.domain.toLowerCase();
  if (qclass !== CLASS_IN || !(asked === domain || asked.endsWith(`.${domain}`))) return reply(RCODE.refused, question);

  // The question's name is at offset 12: answers point to it rather than repeat it.
  const here = Buffer.from([0xc0, 0x0c]);
  const byName = (n: string) => zone.records.filter((r) => r.name === n);
  const own = byName(asked);
  // A name with a record here is answered from the inside view alone; any other is the outside world's.
  if (own.length === 0) {
    if (zone.forward !== false) return "forward";
    if (asked !== domain) return reply(RCODE.nxDomain, question, [], true);
  }
  const answers: Buffer[] = [];
  const alias = own.find((r) => r.type === "CNAME");
  if (alias && qtype !== TYPE.CNAME) {
    answers.push(record(here, alias));
    // A target in the zone is answered too, so a device needs one round trip.
    for (const r of byName(alias.value)) if (TYPE[r.type] === qtype) answers.push(record(writeName(alias.value), r));
  } else {
    for (const r of own) if (TYPE[r.type] === qtype || qtype === 255) answers.push(record(here, r));
  }
  return reply(RCODE.ok, question, answers, true);
}

/** "1.1.1.1", "1.1.1.1:5353" or "[fd00::1]:53" as a host and port. */
export function parseUpstream(s: string): { host: string; port: number } | undefined {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  const host = m?.[1] ?? (isIPv6(s) ? s : undefined);
  if (!host || !(isIPv4(host) || isIPv6(host))) return undefined;
  const port = m?.[2] ? Number(m[2]) : 53;
  return port >= 1 && port <= 65535 ? { host, port } : undefined;
}

/** Asks one upstream resolver over UDP; the answer only if it is the reply to this query. */
function askUdp(query: Buffer, up: { host: string; port: number }, timeoutMs: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const sock = createSocket(isIPv6(up.host) ? "udp6" : "udp4");
    let settled = false;
    // Once: an error and the timeout may both come.
    const done = (b?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.close();
      resolve(b);
    };
    const timer = setTimeout(() => done(), timeoutMs);
    sock.on("error", () => done());
    sock.on("message", (msg) => {
      if (msg.length >= 12 && msg.readUInt16BE(0) === query.readUInt16BE(0) && msg.readUInt16BE(2) & 0x8000) done(msg);
    });
    sock.send(query, up.port, up.host);
  });
}

/** Asks one upstream resolver over TCP, for an answer too long for UDP. */
function askTcp(query: Buffer, up: { host: string; port: number }, timeoutMs: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const sock = connect(up.port, up.host, () => sock.write(Buffer.concat([Buffer.from([query.length >> 8, query.length & 255]), query])));
    let settled = false;
    const done = (b?: Buffer) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(b);
    };
    sock.setTimeout(timeoutMs, () => done());
    sock.on("error", () => done());
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const msg = buf.subarray(2, 2 + buf.readUInt16BE(0));
        done(msg.length >= 12 && msg.readUInt16BE(0) === query.readUInt16BE(0) ? msg : undefined);
      }
    });
  });
}

/** SERVFAIL for a query no upstream answered. */
function servFail(query: Buffer): Buffer | undefined {
  const name = readName(query, 12);
  if (!name || name.end + 4 > query.length) return undefined;
  const head = Buffer.from(query.subarray(0, 12));
  head.writeUInt16BE(0x8000 | (query.readUInt16BE(2) & 0x7900) | RCODE.servFail, 2);
  head.writeUInt16BE(0, 6);
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(0, 10);
  return Buffer.concat([head, query.subarray(12, name.end + 4)]);
}

/**
 * Serves the zone on one address over UDP and TCP. The zone can change while it runs. `upstream` are the resolvers
 * asked for the domain's other names, in order.
 */
export function serveDns(
  zone: () => Zone | undefined,
  address: string,
  port = 53,
  upstream: Array<{ host: string; port: number }> = [],
  /** How long one upstream resolver is waited for. */
  timeoutMs = 2000,
) {
  let udp: Socket | undefined;
  let tcp: Server | undefined;
  // Never itself: a loop would answer nothing.
  const ups = upstream.filter((u) => !(u.host === address && u.port === port));
  const respond = async (msg: Buffer, over: "udp" | "tcp") => {
    const z = zone();
    const out = z ? answer(msg, z) : undefined;
    if (out !== "forward") return out;
    for (const up of ups) {
      const got = await (over === "udp" ? askUdp(msg, up, timeoutMs) : askTcp(msg, up, timeoutMs));
      if (got) return got;
    }
    return servFail(msg);
  };
  return {
    get listening() {
      return !!udp && !!tcp;
    },
    /** Binds once the address exists, which is after OpenVPN brings the tunnel up; fails until then. */
    async start(): Promise<void> {
      if (udp && tcp) return;
      const u = createSocket(address.includes(":") ? "udp6" : "udp4");
      u.on("message", (msg, from) => {
        void respond(msg, "udp").then((out) => {
          if (out) u.send(out.length > 512 && !(out.readUInt16BE(2) & 0x0200) ? truncated(out) : out, from.port, from.address);
        });
      });
      await new Promise<void>((resolve, reject) => {
        u.once("error", reject);
        u.bind(port, address, () => resolve());
      });
      const t = createServer((sock) => {
        let buf = Buffer.alloc(0);
        sock.setTimeout(10_000, () => sock.destroy());
        sock.on("error", () => sock.destroy());
        sock.on("data", (d: Buffer) => {
          buf = Buffer.concat([buf, d]);
          while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
            const msg = Buffer.from(buf.subarray(2, 2 + buf.readUInt16BE(0)));
            buf = buf.subarray(2 + buf.readUInt16BE(0));
            void respond(msg, "tcp").then((out) => {
              if (out && !sock.destroyed) sock.write(Buffer.concat([Buffer.from([out.length >> 8, out.length & 255]), out]));
            });
          }
          if (buf.length > 4096) sock.destroy();
        });
      });
      await new Promise<void>((resolve, reject) => {
        t.once("error", (err) => {
          u.close();
          reject(err);
        });
        t.listen(port, address, () => resolve());
      });
      udp = u;
      tcp = t;
    },
    stop() {
      udp?.close();
      tcp?.close();
      udp = undefined;
      tcp = undefined;
    },
  };
}

/** Over UDP an answer longer than 512 bytes goes out with only its header and question, marked truncated. */
function truncated(out: Buffer): Buffer {
  const name = readName(out, 12)!;
  const head = Buffer.from(out.subarray(0, 12));
  head.writeUInt16BE(head.readUInt16BE(2) | 0x0200, 2);
  head.writeUInt16BE(0, 6);
  return Buffer.concat([head, out.subarray(12, name.end + 4)]);
}
