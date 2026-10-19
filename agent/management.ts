// OpenVPN's management interface, on a Unix socket only root can reach: live sessions and disconnects.
import { createConnection } from "node:net";

export interface LiveSession {
  cn: string;
  realAddress: string;
  vpnIp: string;
  bytesIn: number;
  bytesOut: number;
  connectedAt: string;
  /** OpenVPN's id for the connection, used to end it. */
  clientId: string;
}

/** Sends one command and returns the reply lines, up to END or the SUCCESS/ERROR line. */
export function command(socket: string, cmd: string, timeoutMs = 5000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket);
    let buffer = "";
    let sent = false;
    const done = (err?: Error, lines?: string[]) => {
      clearTimeout(timer);
      conn.destroy();
      if (err) reject(err);
      else resolve(lines!);
    };
    const timer = setTimeout(() => done(new Error(`management: no answer to "${cmd}"`)), timeoutMs);
    conn.on("error", (err) => done(err));
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n").map((l) => l.replace(/\r$/, ""));
      // The interface greets with an >INFO line before it takes commands.
      if (!sent && lines.some((l) => l.startsWith(">INFO"))) {
        sent = true;
        buffer = "";
        conn.write(`${cmd}\n`);
        return;
      }
      if (!sent) return;
      const end = lines.findIndex((l) => l === "END" || l.startsWith("SUCCESS:") || l.startsWith("ERROR:"));
      if (end >= 0) {
        if (lines[end]!.startsWith("ERROR:")) done(new Error(`management: ${lines[end]}`));
        else done(undefined, lines.slice(0, end + 1).filter((l) => !l.startsWith(">")));
      }
    });
  });
}

/** Parses `status 3`: tab-separated, with a HEADER line naming the CLIENT_LIST columns. */
export function parseStatus(lines: string[]): LiveSession[] {
  const header = lines.find((l) => l.startsWith("HEADER\tCLIENT_LIST"))?.split("\t").slice(2);
  if (!header) return [];
  const col = (row: string[], name: string) => row[header.indexOf(name)] ?? "";
  return lines
    .filter((l) => l.startsWith("CLIENT_LIST\t"))
    .map((l) => l.split("\t").slice(1))
    .map((row) => ({
      cn: col(row, "Common Name"),
      realAddress: col(row, "Real Address"),
      vpnIp: col(row, "Virtual Address"),
      bytesIn: Number(col(row, "Bytes Received")) || 0,
      bytesOut: Number(col(row, "Bytes Sent")) || 0,
      connectedAt: new Date(Number(col(row, "Connected Since (time_t)")) * 1000).toISOString(),
      clientId: col(row, "Client ID"),
    }))
    // A client is listed before it has an address; it is not connected yet.
    .filter((s) => s.cn && s.vpnIp);
}

export const sessions = async (socket: string) => parseStatus(await command(socket, "status 3"));

export async function disconnect(socket: string, clientId: string) {
  await command(socket, `client-kill ${clientId}`);
}
