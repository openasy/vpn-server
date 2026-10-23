// Per-device firewall: a device reaches only the networks and ports its groups allow (ADR 0022).
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ServerConfig } from "./config.ts";

const run = promisify(execFile);

export const CHAINS = {
  /** Traffic from devices to anywhere. */
  from: "OPENASY-VPN",
  /** Traffic towards devices: only replies. */
  to: "OPENASY-VPN-TO",
  /** Traffic from devices to this server itself. */
  local: "OPENASY-VPN-LOCAL",
} as const;

// iptables' multiport match takes at most 15 ports.
const chunks = (ports: number[]) => Array.from({ length: Math.ceil(ports.length / 15) }, (_, i) => ports.slice(i * 15, i * 15 + 15));

/** The whole rule set as iptables-restore input. Declaring a chain flushes it, so each apply replaces the rules at once. */
export function renderRules(clients: ServerConfig["clients"]): string {
  const lines = ["*filter", `:${CHAINS.from} - [0:0]`, `:${CHAINS.to} - [0:0]`, `:${CHAINS.local} - [0:0]`];
  lines.push(`-A ${CHAINS.from} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`);
  for (const c of clients) {
    for (const a of c.allow) {
      const base = `-A ${CHAINS.from} -s ${c.ip}/32 -d ${a.cidr}`;
      if (a.proto === "any") lines.push(`${base} -j ACCEPT`);
      else if (a.ports.length === 0) lines.push(`${base} -p ${a.proto} -j ACCEPT`);
      else for (const ports of chunks(a.ports)) lines.push(`${base} -p ${a.proto} -m multiport --dports ${ports.join(",")} -j ACCEPT`);
    }
  }
  lines.push(`-A ${CHAINS.from} -j DROP`);
  lines.push(`-A ${CHAINS.to} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`, `-A ${CHAINS.to} -j DROP`);
  lines.push(`-A ${CHAINS.local} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`, `-A ${CHAINS.local} -p icmp -j ACCEPT`, `-A ${CHAINS.local} -j DROP`);
  lines.push("COMMIT", "");
  return lines.join("\n");
}

/** The jumps from the built-in chains; added once. */
export function jumps(dev = "tun0"): string[][] {
  return [
    ["FORWARD", "-i", dev, "-j", CHAINS.from],
    ["FORWARD", "-o", dev, "-j", CHAINS.to],
    ["INPUT", "-i", dev, "-j", CHAINS.local],
  ];
}

function restore(input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("iptables-restore", ["--noflush"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`iptables-restore: ${err.trim() || code}`))));
    child.stdin.end(input);
  });
}

/** Replaces the device rules and makes sure traffic is sent through them. */
export async function applyFirewall(clients: ServerConfig["clients"], dev = "tun0") {
  await restore(renderRules(clients));
  for (const [chain, ...rule] of jumps(dev)) {
    try {
      await run("iptables", ["-C", chain!, ...rule]);
    } catch {
      await run("iptables", ["-I", chain!, "1", ...rule]);
    }
  }
}
