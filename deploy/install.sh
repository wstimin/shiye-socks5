#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE="${SK5_PANEL_IMAGE:-ghcr.io/wstimin/shiye-socks5:latest}"
PORT="${SK5_PANEL_PORT:-8787}"
ADMIN_USER="${SK5_PANEL_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${SK5_PANEL_ADMIN_PASSWORD:-}"
DATA_DIR="/var/lib/sk5-panel"
CONFIG_DIR="/etc/sk5-panel"
SERVICE_DIR="/etc/systemd/system"
HELPER_PATH="/usr/local/libexec/sk5-panel-helper"
CONTAINER_UID=10001
CONTAINER_GID=10001
THREEPROXY_VERSION="0.9.5"

log() { printf '\033[1;36m[sk5面板]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail "请使用 root 运行：sudo bash deploy/install.sh"
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || fail "SK5_PANEL_PORT 必须是 1-65535 的端口"
[[ "$IMAGE" =~ ^[a-zA-Z0-9./:_@-]+$ ]] || fail "SK5_PANEL_IMAGE 格式无效"
[[ "$ADMIN_USER" =~ ^[a-zA-Z0-9._-]{1,64}$ ]] || fail "管理员用户名格式无效"
[[ "$ADMIN_PASSWORD" != *$'\n'* && "$ADMIN_PASSWORD" != *$'\r'* ]] || fail "管理员密码不能包含换行符"

[[ -r /etc/os-release ]] || fail "无法识别操作系统"
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "当前仅支持 Ubuntu 22.04/24.04 和 Debian 12" ;;
esac
if [[ "${ID:-}" == "debian" && "${VERSION_ID%%.*}" -lt 12 ]]; then
  fail "Debian 版本过低，最低支持 Debian 12"
fi
if [[ "${ID:-}" == "ubuntu" && "${VERSION_ID%%.*}" -lt 22 ]]; then
  fail "Ubuntu 版本过低，最低支持 Ubuntu 22.04"
fi

log "安装宿主机网络组件和 Docker"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl docker.io iproute2 jq nftables openssl ppp procps socat sudo util-linux xl2tpd

if ! command -v 3proxy >/dev/null 2>&1; then
  if apt-cache show 3proxy >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y 3proxy
  else
    log "当前软件源没有 3proxy，编译官方 ${THREEPROXY_VERSION} 版本"
    DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential
    BUILD_DIR="$(mktemp -d)"
    curl --fail --location --silent --show-error \
      "https://github.com/3proxy/3proxy/archive/refs/tags/${THREEPROXY_VERSION}.tar.gz" \
      -o "$BUILD_DIR/3proxy.tar.gz"
    tar -xzf "$BUILD_DIR/3proxy.tar.gz" -C "$BUILD_DIR"
    make -C "$BUILD_DIR/3proxy-${THREEPROXY_VERSION}" -f Makefile.Linux
    install -o root -g root -m 0755 "$BUILD_DIR/3proxy-${THREEPROXY_VERSION}/bin/3proxy" /usr/bin/3proxy
    rm -rf "$BUILD_DIR"
  fi
fi
systemctl enable --now docker nftables

log "拉取面板镜像：$IMAGE"
docker pull "$IMAGE"

install -d -o root -g root -m 0755 "$CONFIG_DIR" /usr/local/libexec
install -d -o "$CONTAINER_UID" -g "$CONTAINER_GID" -m 0750 "$DATA_DIR"
chown -R "$CONTAINER_UID:$CONTAINER_GID" "$DATA_DIR"

if [[ -f "$CONFIG_DIR/panel.env" ]]; then
  EXISTING_USER="$(sed -n 's/^SK5_PANEL_ADMIN_USER=//p' "$CONFIG_DIR/panel.env" | tail -n 1)"
  EXISTING_PASSWORD="$(sed -n 's/^SK5_PANEL_ADMIN_PASSWORD=//p' "$CONFIG_DIR/panel.env" | tail -n 1)"
  [[ -n "$EXISTING_USER" && "${SK5_PANEL_ADMIN_USER+x}" != x ]] && ADMIN_USER="$EXISTING_USER"
  [[ -n "$EXISTING_PASSWORD" && "${SK5_PANEL_ADMIN_PASSWORD+x}" != x ]] && ADMIN_PASSWORD="$EXISTING_PASSWORD"
fi
[[ -n "$ADMIN_PASSWORD" ]] || ADMIN_PASSWORD="$(openssl rand -hex 16)"

log "从镜像提取与当前版本匹配的宿主机组件"
TEMP_CONTAINER="$(docker create "$IMAGE")"
cleanup() { docker rm -f "$TEMP_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker cp "$TEMP_CONTAINER:/opt/sk5-panel/deploy/sk5-panel-helper" "$HELPER_PATH"
docker cp "$TEMP_CONTAINER:/opt/sk5-panel/deploy/sk5-proxy@.service" "$SERVICE_DIR/sk5-proxy@.service"
docker cp "$TEMP_CONTAINER:/opt/sk5-panel/deploy/sk5-l2tp@.service" "$SERVICE_DIR/sk5-l2tp@.service"
docker cp "$TEMP_CONTAINER:/opt/sk5-panel/deploy/sk5-relay@.service" "$SERVICE_DIR/sk5-relay@.service"
docker cp "$TEMP_CONTAINER:/opt/sk5-panel/deploy/docker/sk5-panel.service" "$SERVICE_DIR/sk5-panel.service"
chmod 0755 "$HELPER_PATH"
chmod 0644 "$SERVICE_DIR/sk5-panel.service" "$SERVICE_DIR/sk5-proxy@.service" "$SERVICE_DIR/sk5-l2tp@.service" "$SERVICE_DIR/sk5-relay@.service"
cleanup
trap - EXIT

cat >"$CONFIG_DIR/panel.env" <<EOF
PORT=$PORT
SK5_PANEL_DATA=$DATA_DIR
SK5_PANEL_APPLY=true
SK5_PANEL_ALLOW_PROBE=true
SK5_PANEL_HELPER=/usr/local/libexec/sk5-panel-host-exec
SK5_PANEL_ADMIN_USER=$ADMIN_USER
SK5_PANEL_ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF
chmod 0600 "$CONFIG_DIR/panel.env"

cat >"$CONFIG_DIR/service.env" <<EOF
SK5_PANEL_IMAGE=$IMAGE
EOF
chmod 0600 "$CONFIG_DIR/service.env"

log "启动 sk5面板"
systemctl daemon-reload
systemctl enable --now sk5-panel.service

READY="false"
for _ in $(seq 1 60); do
  READY="$(curl --silent --show-error --max-time 3 --user "$ADMIN_USER:$ADMIN_PASSWORD" \
    "http://127.0.0.1:$PORT/api/bootstrap" | jq -r '.system.ready // false' 2>/dev/null || true)"
  [[ "$READY" == "true" ]] && break
  sleep 1
done

if [[ "$READY" != "true" ]]; then
  printf '\n'
  systemctl status sk5-panel.service --no-pager -l || true
  fail "面板已安装，但生产就绪检查未通过。查看日志：journalctl -u sk5-panel.service -n 200 --no-pager"
fi

SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')"
[[ -n "$SERVER_IP" ]] || SERVER_IP="服务器IP"

cat >/root/sk5-panel-credentials.txt <<EOF
URL=http://$SERVER_IP:$PORT
Username=$ADMIN_USER
Password=$ADMIN_PASSWORD
Image=$IMAGE
EOF
chmod 0600 /root/sk5-panel-credentials.txt

printf '\n\033[1;32m安装完成，生产执行模式已通过检查。\033[0m\n'
printf '访问地址: http://%s:%s\n' "$SERVER_IP" "$PORT"
printf '用户名: %s\n' "$ADMIN_USER"
printf '密码: %s\n' "$ADMIN_PASSWORD"
printf '凭据备份: /root/sk5-panel-credentials.txt\n'
printf '请在对公网开放前配置防火墙、IP 白名单和 HTTPS。\n'
