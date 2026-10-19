# vpn-server

The [OpenAsy](https://github.com/openasy) VPN server agent: runs OpenVPN on a host, keeps it running and reports to
[vpn-manager](https://github.com/openasy/vpn-manager). It has no database and talks only to the vpn-manager API.
It always has the same version as vpn-manager.

## Run

See [`compose.yaml` in vpn-manager](https://github.com/openasy/vpn-manager/blob/main/compose.yaml). The container needs
`NET_ADMIN` and `/dev/net/tun`, and reads its OpenVPN configuration from `/etc/openvpn/server.conf`.

| Variable | Default | |
| --- | --- | --- |
| `VPN_MANAGER_URL` | | vpn-manager base URL (required) |
| `VPN_SERVER_TOKEN` | | Same token as vpn-manager (required) |
| `VPN_SERVER_ID` | host name | Name shown in vpn-manager |
| `OPENVPN_CONFIG` | `/etc/openvpn/server.conf` | OpenVPN starts only when this file exists |
| `OPENVPN_PROTO` | from config | `udp` or `tcp`; overrides `proto` in the config |
| `OPENVPN_PORT` | from config | `1`-`65535`; overrides `port` in the config |
| `HEARTBEAT_SECONDS` | `15` | |
| `PORT` | `9100` | `/healthz`, `/readyz`, `/metrics` |

`/readyz` is ready when OpenVPN runs and vpn-manager accepts the heartbeat; otherwise it lists the problems.

### Ports

One vpn-server listens on one protocol and port. To offer several, for example UDP 1194 and TCP 443, run one
container per port with the same configuration and its own `VPN_SERVER_ID`; `compose.yaml` in vpn-manager does this.
TCP 443 gets through networks that allow only HTTPS. UDP is faster, so keep it as the default.
If a web server already uses 443 on the host, add `port-share <web-host> 443` to the config so OpenVPN forwards
HTTPS traffic to it, or use another port.
Remove `explicit-exit-notify` from a config you also use with TCP, because OpenVPN accepts it only with UDP.

## Verify an image

```bash
cosign verify ghcr.io/openasy/vpn-server:0.1.0 \
  --certificate-identity-regexp '^https://github.com/openasy/vpn-server/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Develop

```bash
npm ci
npm run typecheck && npm test
```

## Release

Release vpn-manager first, then push the same tag here (`v0.1.0`). The workflow refuses to publish a version of
vpn-server for which no vpn-manager image exists.

## Licence

[AGPL-3.0](./LICENSE). You may use, change and share it; if you run a changed version for others, including as a
hosted service, you must offer them your source code under the same licence. A commercial licence without these
obligations is available: see [ADR 0008](https://github.com/openasy/ui/blob/main/docs/decisions/0008-open-source.md).
"OpenAsy" and its logo are trademarks and are not covered by the licence.
