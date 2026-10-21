# vpn-server

The [OpenAsy](https://github.com/openasy) VPN server: runs OpenVPN on a host and carries the VPN traffic. It takes its
config from [vpn](https://github.com/openasy/vpn) and reports to it; it has no database and talks only to the `vpn`
API. It always has the same version as `vpn` (ADR 0018, 0019).

## Run

Add the server under **Servers** in `vpn`, with the address clients connect to. You get a one-time enrolment token;
start vpn-server with it as `VPN_ENROLL_TOKEN`. The server trades it for its own secret, which it keeps in
`VPN_STATE_DIR`, so keep that directory on a volume. The token works once, for 7 days (ADR 0032).

```bash
docker run -d --name vpn-server --restart unless-stopped \
  --cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 \
  -p 1194:1194/udp -v vpn-server-data:/var/lib/openasy-vpn \
  -e VPN_URL=https://vpn.example.com -e VPN_ENROLL_TOKEN=ove_... \
  ghcr.io/openasy/vpn-server:0.6.0
```

Next to `vpn`, see [`compose.yaml` in vpn](https://github.com/openasy/vpn/blob/main/compose.yaml). The container
needs `NET_ADMIN`, `/dev/net/tun` and `--sysctl net.ipv4.ip_forward=1`.

vpn-server pulls its config from `vpn` (certificates, CRL, the devices allowed to connect and their
routes), checks it against a fixed shape, writes it under `VPN_STATE_DIR` and runs OpenVPN with it. OpenVPN drops to
`nobody` after start. New and revoked devices apply without a restart; certificate or server changes restart OpenVPN.
When `vpn` is unreachable, vpn-server keeps running with the last good config (ADR 0023).

Each device reaches only the networks and ports its groups allow: vpn-server keeps `iptables` chains `OPENASY-VPN`
(from devices), `OPENASY-VPN-TO` (only replies towards devices) and `OPENASY-VPN-LOCAL` (only replies and ICMP to this
server). Live sessions come from OpenVPN's management interface on a root-only Unix socket and are reported with each
heartbeat; sessions of devices that are no longer allowed, or that `vpn` asks to end, are disconnected.

| Variable | Default | |
| --- | --- | --- |
| `VPN_URL` | | `vpn` base URL (required). `VPN_MANAGER_URL` still works until 0.5.0 |
| `VPN_ENROLL_TOKEN` | | One-time token from Servers in `vpn` (required on first start). A new one enrols the server again |
| `VPN_SERVER_TOKEN` | | Deprecated: the token shared with `vpn`, for servers that never enrolled |
| `VPN_SERVER_ID` | host name | Deprecated, with `VPN_SERVER_TOKEN`: the name shown in `vpn`. An enrolled server has the name it was added with |
| `OPENVPN_PROTO` | `udp` | `udp` or `tcp` |
| `OPENVPN_PORT` | `1194` | `1`-`65535` |
| `VPN_STATE_DIR` | `/var/lib/openasy-vpn` | The server's secret and the config from `vpn`. Keep it on a volume |
| `HEARTBEAT_SECONDS` | `15` | |
| `PORT` | `9100` | `/healthz`, `/readyz`, `/metrics` |

`/readyz` is ready when a config from `vpn` is applied, OpenVPN runs and `vpn` accepts the heartbeat;
otherwise it lists the problems.

### Several servers

Each server is added under Servers with its own name and address, and enrols with its own token. Client configs list
every server that has reported, at its address: UDP first, then TCP. A client tries them in turn, so when one server or
location is down it connects to the next. Every server carries every device, with the same VPN address.

A client config lists the servers there were when it was made. A server added later reaches only devices added after
it; give locations DNS names from the start, so that moving a server does not need new client configs.

### Ports

One vpn-server listens on one protocol and port. To offer several, for example UDP 1194 and TCP 443, run one
container per port, each added and enrolled as its own server; `compose.yaml` in `vpn` does this.
TCP 443 gets through networks that allow only HTTPS. UDP is faster, so keep it as the default.
If a web server already uses 443 on the host, publish the TCP server on another host port.

## Verify an image

```bash
cosign verify ghcr.io/openasy/vpn-server:0.6.0 \
  --certificate-identity-regexp '^https://github.com/openasy/vpn-server/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Develop

```bash
npm ci
npm run typecheck && npm test
```

## Release

Release `vpn` first, then push the same tag here (`v0.1.0`). The workflow refuses to publish a version of
vpn-server for which no `vpn` image exists.

## Licence

[AGPL-3.0](./LICENSE). You may use, change and share it; if you run a changed version for others, including as a
hosted service, you must offer them your source code under the same licence. A commercial licence without these
obligations is available: see [ADR 0008](https://github.com/openasy/openasy.github.io/blob/main/docs/decisions/0008-open-source.md).
"OpenAsy" and its logo are trademarks and are not covered by the licence.
