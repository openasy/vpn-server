import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { digest, type Files } from "./config.ts";
import { log } from "./log.ts";

const run = promisify(execFile);

// Keys only root reads (OpenVPN reads them before dropping to nobody); the rest is world-readable
// because OpenVPN re-reads the CRL and ccd files as nobody.
const SECRET = new Set(["server.key", "tls-crypt.key"]);

function writeAtomic(path: string, content: string, mode: number) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

/** Writes the files and says whether OpenVPN must restart to pick them up. */
export function applyFiles(dir: string, files: Files): { restart: boolean } {
  mkdirSync(join(dir, "ccd"), { recursive: true, mode: 0o755 });
  const stamp = join(dir, ".restart-digest");
  const wanted = digest(files.restart);
  let current = "";
  try {
    current = readFileSync(stamp, "utf8");
  } catch {
    // First run.
  }
  for (const [name, content] of Object.entries({ ...files.restart, ...files.live })) writeAtomic(join(dir, name), content, SECRET.has(name) ? 0o600 : 0o644);
  for (const [cn, content] of Object.entries(files.ccd)) writeAtomic(join(dir, "ccd", cn), content, 0o644);
  for (const cn of readdirSync(join(dir, "ccd"))) if (!(cn in files.ccd) && !cn.endsWith(".tmp")) rmSync(join(dir, "ccd", cn));
  writeFileSync(stamp, wanted);
  return { restart: wanted !== current };
}

/** NAT for client traffic leaving the container. Idempotent; logs instead of failing when not permitted. */
export async function ensureNat(network: string) {
  try {
    if (readFileSync("/proc/sys/net/ipv4/ip_forward", "utf8").trim() !== "1") {
      log("warn", "IP forwarding is off; clients reach only this server. Run the container with --sysctl net.ipv4.ip_forward=1");
    }
  } catch {
    // Not Linux, for example in tests.
  }
  const rule = ["-t", "nat", "POSTROUTING", "-s", network, "-j", "MASQUERADE"];
  try {
    await run("iptables", [rule[0]!, rule[1]!, "-C", ...rule.slice(2)]);
  } catch {
    try {
      await run("iptables", [rule[0]!, rule[1]!, "-A", ...rule.slice(2)]);
      log("info", "NAT enabled for clients", { network });
    } catch (err) {
      log("warn", "could not add the NAT rule; clients reach only this server", { error: String(err) });
    }
  }
}
