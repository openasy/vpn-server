# vpn-server

The [OpenAsy](https://github.com/openasy) VPN server: runs OpenVPN on a host and carries the VPN traffic. It takes its
config from [vpn](https://github.com/openasy/vpn) and reports to it; it has no database and talks only to the `vpn`
API. It always has the same version as `vpn` (ADR 0018, 0019).

## Run

See [`compose.yaml` in vpn](https://github.com/openasy/vpn/blob/main/compose.yaml). The container needs
`NET_ADMIN`, `/dev/net/tun` and `--sysctl net.ipv4.ip_forward=1`.

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
| `VPN_SERVER_TOKEN` | | Same token as `vpn` (required) |
| `VPN_SERVER_ID` | host name | Name shown in `vpn` |
| `OPENVPN_PROTO` | `udp` | `udp` or `tcp` |
| `OPENVPN_PORT` | `1194` | `1`-`65535` |
| `VPN_STATE_DIR` | `/var/lib/openasy-vpn` | Where the config from `vpn` is written |
| `HEARTBEAT_SECONDS` | `15` | |
| `PORT` | `9100` | `/healthz`, `/readyz`, `/metrics` |

`/readyz` is ready when a config from `vpn` is applied, OpenVPN runs and `vpn` accepts the heartbeat;
otherwise it lists the problems.

### Ports

One vpn-server listens on one protocol and port. To offer several, for example UDP 1194 and TCP 443, run one
container per port with the same configuration and its own `VPN_SERVER_ID`; `compose.yaml` in `vpn` does this.
TCP 443 gets through networks that allow only HTTPS. UDP is faster, so keep it as the default.
If a web server already uses 443 on the host, publish the TCP server on another host port.

## Verify an image

```bash
cosign verify ghcr.io/openasy/vpn-server:0.4.0 \
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
