# syntax=docker/dockerfile:1

# The agent has no runtime dependencies: Node runs the TypeScript sources directly.
FROM node:26.12.0-trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openvpn iptables ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY agent ./agent
ENV NODE_ENV=production PORT=9100 OPENVPN_CONFIG=/etc/openvpn/server.conf
# 1194/udp by default; set OPENVPN_PROTO and OPENVPN_PORT for others, such as tcp/443.
EXPOSE 1194/udp 443/tcp 9100
# OpenVPN needs root, NET_ADMIN and /dev/net/tun to create the tunnel; see compose.yaml in vpn-manager.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9100/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "agent/main.ts"]
