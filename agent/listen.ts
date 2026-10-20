export interface Listen {
  proto: "udp" | "tcp";
  port: number;
  /** "udp/1194", "tcp/443": reported to vpn, which lists it in client configs. */
  label: string;
}

/** Reads OPENVPN_PROTO and OPENVPN_PORT; the default is UDP 1194. */
export function parseListen(proto: string | undefined, port: string | undefined): Listen {
  const p = proto === undefined || proto === "" ? "udp" : proto;
  if (p !== "udp" && p !== "tcp") throw new Error(`OPENVPN_PROTO must be udp or tcp, not "${proto}"`);
  const n = port === undefined || port === "" ? 1194 : Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`OPENVPN_PORT must be 1-65535, not "${port}"`);
  return { proto: p, port: n, label: `${p}/${n}` };
}
