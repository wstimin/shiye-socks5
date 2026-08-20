FROM debian:bookworm-slim AS threeproxy-builder

ARG THREEPROXY_VERSION=0.9.5

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl \
    && curl --fail --location --silent --show-error \
      "https://github.com/3proxy/3proxy/archive/refs/tags/${THREEPROXY_VERSION}.tar.gz" \
      -o /tmp/3proxy.tar.gz \
    && tar -xzf /tmp/3proxy.tar.gz -C /tmp \
    && make -C "/tmp/3proxy-${THREEPROXY_VERSION}" -f Makefile.Linux

FROM node:20-bookworm-slim

LABEL org.opencontainers.image.title="sk5面板"
LABEL org.opencontainers.image.description="Dedicated public IP and L2TP SOCKS5 management panel"
LABEL org.opencontainers.image.source="https://github.com/wstimin/shiye-socks5"

ENV NODE_ENV=production \
    PORT=8787 \
    SK5_PANEL_DATA=/var/lib/sk5-panel \
    SK5_PANEL_HELPER=/usr/local/libexec/sk5-panel-host-exec

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      curl iproute2 jq nftables ppp socat sudo systemd util-linux xl2tpd \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sk5panel \
    && useradd --uid 10001 --gid 10001 --home-dir /var/lib/sk5-panel --shell /usr/sbin/nologin sk5panel \
    && install -d -o sk5panel -g sk5panel -m 0750 /var/lib/sk5-panel /usr/local/libexec

COPY --from=threeproxy-builder /tmp/3proxy-0.9.5/bin/3proxy /usr/bin/3proxy

WORKDIR /opt/sk5-panel

COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public
COPY --chown=root:root deploy ./deploy
COPY --chown=root:root deploy/docker/sk5-panel-host-exec /usr/local/libexec/sk5-panel-host-exec
COPY --chown=root:root deploy/docker/sk5-panel-container.sudoers /etc/sudoers.d/sk5-panel-container

RUN chmod 0755 /usr/local/libexec/sk5-panel-host-exec \
    && chmod 0440 /etc/sudoers.d/sk5-panel-container \
    && visudo -cf /etc/sudoers.d/sk5-panel-container \
    && chmod -R go-w /opt/sk5-panel

USER sk5panel

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --silent --fail "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "src/server.js"]
