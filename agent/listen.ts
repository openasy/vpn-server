export interface Listen {
  /** Extra OpenVPN arguments; they come after --config, so they override the file. */
  args: string[];
  /** "udp/1194", "tcp/443", or undefined when the config file decides. */
  label?: string;
}

/** Reads OPENVPN_PROTO and OPENVPN_PORT. Unset values leave the config file in charge. */
export function parseListen(proto: string | undefined, port: string | undefined): Listen {
  const args: string[] = [];
  if (proto !== undefined && proto !== "") {
    if (proto !== "udp" && proto !== "tcp") throw new Error(`OPENVPN_PROTO must be udp or tcp, not "${proto}"`);
    args.push("--proto", proto === "tcp" ? "tcp-server" : "udp");
  }
  if (port !== undefined && port !== "") {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`OPENVPN_PORT must be 1-65535, not "${port}"`);
    args.push("--port", String(n));
  }
  const label = proto && port ? `${proto}/${Number(port)}` : undefined;
  return { args, label };
}
