#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "请使用 root 运行" >&2; exit 1; }

systemctl disable --now sk5-panel.service >/dev/null 2>&1 || true
docker rm -f sk5-panel >/dev/null 2>&1 || true

rm -f /etc/systemd/system/sk5-panel.service
rm -f /etc/systemd/system/sk5-proxy@.service
rm -f /etc/systemd/system/sk5-l2tp@.service
rm -f /etc/systemd/system/sk5-relay@.service
rm -f /usr/local/libexec/sk5-panel-helper
systemctl daemon-reload

echo "面板程序和服务已卸载。"
echo "数据、密钥和凭据仍保留在 /var/lib/sk5-panel、/etc/sk5-panel 和 /root/sk5-panel-credentials.txt。"
echo "确认不再需要后，可由管理员手动删除这些目录。"
