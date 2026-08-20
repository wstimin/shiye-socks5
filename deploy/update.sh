#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "请使用 root 运行" >&2; exit 1; }
[[ -f /etc/sk5-panel/service.env ]] || { echo "未找到已安装的 sk5面板" >&2; exit 1; }

. /etc/sk5-panel/service.env
[[ -n "${SK5_PANEL_IMAGE:-}" ]] || { echo "镜像地址为空" >&2; exit 1; }

echo "拉取镜像：$SK5_PANEL_IMAGE"
docker pull "$SK5_PANEL_IMAGE"

TEMP_CONTAINER="$(docker create "$SK5_PANEL_IMAGE")"
cleanup() { docker rm -f "$TEMP_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker cp "$TEMP_CONTAINER:/opt/sk5-panel/deploy/sk5-panel-helper" /usr/local/libexec/sk5-panel-helper
docker cp "$TEMP_CONTAINER:/opt/sk5-panel/deploy/sk5-proxy@.service" /etc/systemd/system/sk5-proxy@.service
docker cp "$TEMP_CONTAINER:/opt/sk5-panel/deploy/sk5-l2tp@.service" /etc/systemd/system/sk5-l2tp@.service
docker cp "$TEMP_CONTAINER:/opt/sk5-panel/deploy/sk5-relay@.service" /etc/systemd/system/sk5-relay@.service
docker cp "$TEMP_CONTAINER:/opt/sk5-panel/deploy/docker/sk5-panel.service" /etc/systemd/system/sk5-panel.service
chmod 0755 /usr/local/libexec/sk5-panel-helper
chmod 0644 /etc/systemd/system/sk5-panel.service /etc/systemd/system/sk5-proxy@.service /etc/systemd/system/sk5-l2tp@.service /etc/systemd/system/sk5-relay@.service
cleanup
trap - EXIT

systemctl daemon-reload
systemctl restart sk5-panel.service
echo "升级完成。查看状态：systemctl status sk5-panel.service --no-pager"
