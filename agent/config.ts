// Turns the desired state from vpn into OpenVPN files (ADR 0022: the agent validates what it applies).
import { createHash } from "node:crypto";

export interface ServerConfig {
  version: string;
  network: string;
  ca: string;
  cert: string;
  key: string;
  crl: string;
  tlsCrypt: string;
  clients: Array<{ cn: string; ip: string; routes: string[]; fullTunnel: boolean; allow: Allow[] }>;
}

export interface Allow {
  cidr: string;
  proto: "tcp" | "udp" | "any";
  ports: number[];
}

const validAllow = (a: Allow) =>
  CIDR.test(a?.cidr) &&
  (a.proto === "tcp" || a.proto === "udp" || a.proto === "any") &&
  Array.isArray(a.ports) &&
  a.ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535);

const IP = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/;
// Device ids are UUIDs; anything else could be a path in the ccd directory.
const CN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const mask = (prefix: number) => {
  const m = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [m >>> 24, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join(".");
};

/** Refuses anything outside the expected shape before a byte reaches the disk. */
export function validate(c: unknown): ServerConfig {
  const v = c as ServerConfig;
  const pem = (s: unknown, tag: string) => typeof s === "string" && s.includes(`-----BEGIN ${tag}`);
  if (!v || typeof v.version !== "string" || !CIDR.test(v.network)) throw new Error("config: bad version or network");
  if (!pem(v.ca, "CERTIFICATE") || !pem(v.cert, "CERTIFICATE") || !pem(v.key, "PRIVATE KEY") || !pem(v.crl, "X509 CRL") || !pem(v.tlsCrypt, "OpenVPN Static key")) {
    throw new Error("config: missing or malformed key material");
  }
  if (!Array.isArray(v.clients)) throw new Error("config: clients must be a list");
  for (const cl of v.clients) {
    if (
      !CN.test(cl.cn) ||
      !IP.test(cl.ip) ||
      typeof cl.fullTunnel !== "boolean" ||
      !Array.isArray(cl.routes) ||
      cl.routes.some((r) => !CIDR.test(r)) ||
      !Array.isArray(cl.allow) ||
      !cl.allow.every(validAllow)
    ) {
      throw new Error(`config: bad client ${JSON.stringify(cl).slice(0, 80)}`);
    }
  }
  return v;
}

export interface Listen {
  proto: "udp" | "tcp";
  port: number;
}

export interface Files {
  /** Changing any of these needs an OpenVPN restart. */
  restart: Record<string, string>;
  /** Read by OpenVPN on every new connection: no restart. */
  live: Record<string, string>;
  /** ccd/<cn> files, one per allowed device. */
  ccd: Record<string, string>;
}

export function render(c: ServerConfig, listen: Listen, dir: string, managementSocket: string): Files {
  const [net, prefix] = c.network.split("/");
  const conf = [
    "# Written by vpn-server from vpn's config; changes here are overwritten.",
    // A fixed name, because the firewall rules refer to it.
    "dev tun0",
    "dev-type tun",
    "topology subnet",
    `server ${net} ${mask(Number(prefix))}`,
    `proto ${listen.proto === "tcp" ? "tcp-server" : "udp"}`,
    `port ${listen.port}`,
    `ca ${dir}/ca.crt`,
    `cert ${dir}/server.crt`,
    `key ${dir}/server.key`,
    `crl-verify ${dir}/crl.pem`,
    `tls-crypt ${dir}/tls-crypt.key`,
    "dh none",
    "ecdh-curve prime256v1",
    "data-ciphers AES-256-GCM:CHACHA20-POLY1305",
    "tls-version-min 1.2",
    "remote-cert-tls client",
    // Only devices vpn lists may connect, each with its fixed address.
    `client-config-dir ${dir}/ccd`,
    "ccd-exclusive",
    "keepalive 10 60",
    "persist-key",
    "persist-tun",
    // Drop root once the tunnel exists (ADR 0022).
    "user nobody",
    "group nogroup",
    `management ${managementSocket} unix`,
    "verb 3",
    ...(listen.proto === "udp" ? ["explicit-exit-notify 1"] : []),
    "",
  ].join("\n");

  const ccd: Record<string, string> = {};
  for (const cl of c.clients) {
    ccd[cl.cn] = [
      `ifconfig-push ${cl.ip} ${mask(Number(prefix))}`,
      ...(cl.fullTunnel ? ['push "redirect-gateway def1 bypass-dhcp"'] : []),
      ...cl.routes.map((r) => {
        const [n, p] = r.split("/");
        return `push "route ${n} ${mask(Number(p))}"`;
      }),
      "",
    ].join("\n");
  }

  return {
    restart: { "server.conf": conf, "ca.crt": c.ca, "server.crt": c.cert, "server.key": c.key, "tls-crypt.key": c.tlsCrypt },
    live: { "crl.pem": c.crl },
    ccd,
  };
}

export const digest = (files: Record<string, string>) =>
  createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
