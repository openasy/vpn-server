import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./log.ts";

/** Keeps one OpenVPN process running and restarts it with backoff when it exits. */
export class OpenVpn {
  private child?: ChildProcess;
  private stopping = false;
  private delay = 1000;
  private startedAt = 0;
  private readonly bin: string;
  private readonly args: string[];
  restarts = 0;

  constructor(bin: string, args: string[]) {
    this.bin = bin;
    this.args = args;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  start() {
    this.stopping = false;
    const child = spawn(this.bin, this.args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const forward = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) log("info", line, { source: "openvpn", stream });
    };
    child.stdout?.on("data", forward("stdout"));
    child.stderr?.on("data", forward("stderr"));
    child.on("spawn", () => {
      this.startedAt = Date.now();
      log("info", "openvpn started", { pid: child.pid });
    });
    child.on("error", (err) => log("error", "openvpn failed to start", { error: String(err) }));
    child.on("close", (code, signal) => {
      if (this.stopping) return;
      // Only a process that stayed up resets the backoff; a crash loop keeps backing off.
      if (Date.now() - this.startedAt > 30_000) this.delay = 1000;
      log("warn", "openvpn exited, restarting", { code, signal, inMs: this.delay });
      this.restarts++;
      setTimeout(() => !this.stopping && this.start(), this.delay).unref();
      this.delay = Math.min(this.delay * 2, 30_000);
    });
  }

  stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || !this.running) return Promise.resolve();
    return new Promise((resolve) => {
      child.once("close", () => resolve());
      child.kill("SIGTERM");
    });
  }
}
