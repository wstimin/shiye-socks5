# sk5面板部署文档

## 1. 支持环境

- Ubuntu 24.04 LTS、Ubuntu 22.04 LTS 或 Debian 12
- systemd 作为 PID 1
- amd64 或 arm64
- 至少 1 核 CPU、512 MB 内存、2 GB 可用磁盘

不支持 Windows、缺少网络命名空间的 OpenVZ/受限容器、没有 systemd 的精简系统，以及不允许策略路由或 PPP 的宿主机。

服务器必须能访问 GitHub Raw、GHCR 和出口探测地址 `https://api.ipify.org`。

## 2. 安装前检查

公网 IP 直连模式要求地址真实出现在以下命令输出中：

```bash
ip -4 address
ip -4 route
```

如果云控制台显示多个 EIP，但 `ip -4 address` 看不到这些地址，它们通常是上游 NAT 地址，面板不会把它们伪装成本机可绑定 IP。

建议开放面板 TCP 端口（默认 `8787`，仅允许管理员 IP）、每个 SOCKS5 实例的 TCP 监听端口，以及 L2TP 服务商要求的出站 UDP 1701。

## 3. 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-socks5/main/deploy/install.sh | sudo bash
```

新安装的默认登录信息：

```text
用户名：admin
密码：admin
```

首次登录后必须进入“系统设置 -> 管理员账户”修改默认用户名和密码。保存后，除当前浏览器外的其他管理员会话会立即失效。
`/root/sk5-panel-credentials.txt` 只记录安装时的初始凭据，后台修改后的密码仅以 scrypt 哈希形式保存在 `/var/lib/sk5-panel/auth.json`。

安装器会：

1. 校验 Ubuntu/Debian 版本。
2. 安装 Docker 和宿主机网络依赖。
3. 拉取 `ghcr.io/wstimin/shiye-socks5:latest`。
4. 从镜像提取同版本的 root helper 和 systemd 实例模板。
5. 创建 `/var/lib/sk5-panel` 持久化目录。
6. 首次安装初始化管理员登录信息，默认 `admin/admin`。
7. 注册并启动 `sk5-panel.service`。
8. 调用 `/api/health`，只有生产就绪检查通过才报告安装成功。

## 4. 自定义参数

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-socks5/main/deploy/install.sh -o /tmp/sk5-install.sh
sudo env \
  SK5_PANEL_PORT=8787 \
  SK5_PANEL_ADMIN_USER=admin \
  SK5_PANEL_ADMIN_PASSWORD='Use-A-Long-Random-Password' \
  SK5_PANEL_IMAGE=ghcr.io/wstimin/shiye-socks5:latest \
  bash /tmp/sk5-install.sh
```

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SK5_PANEL_PORT` | `8787` | 面板监听端口 |
| `SK5_PANEL_ADMIN_USER` | `admin` | 首次启动时写入的管理员用户名；可在后台修改 |
| `SK5_PANEL_ADMIN_PASSWORD` | `admin` | 首次启动时写入的管理员密码；可在后台修改 |
| `SK5_PANEL_IMAGE` | `ghcr.io/wstimin/shiye-socks5:latest` | 要部署的镜像 |

重复运行安装脚本视为重装或升级。管理员凭据初始化后保存在 `/var/lib/sk5-panel/auth.json`，后台修改不会将明文密码写入面板状态；已有认证文件时会保留后台当前账户且不覆盖初始凭据文件，旧版本升级时则使用原环境变量凭据完成首次迁移。

## 5. 安装后的文件

| 路径 | 用途 |
| --- | --- |
| `/var/lib/sk5-panel` | 状态、加密主密钥和实例运行配置 |
| `/etc/sk5-panel/panel.env` | 面板环境变量和管理员凭据 |
| `/etc/sk5-panel/service.env` | 当前镜像地址 |
| `/root/sk5-panel-credentials.txt` | 安装时输出的凭据备份 |
| `/usr/local/libexec/sk5-panel-helper` | 固定宿主机系统操作 helper |
| `/etc/systemd/system/sk5-panel.service` | 面板容器服务 |
| `/etc/systemd/system/sk5-proxy@.service` | SOCKS5 实例模板 |
| `/etc/systemd/system/sk5-l2tp@.service` | L2TP 实例模板 |
| `/etc/systemd/system/sk5-relay@.service` | L2TP SOCKS5 转发模板 |

不要丢失 `/var/lib/sk5-panel/master.key`，否则已加密的 SOCKS5 和 L2TP 密码无法恢复。

## 6. 常用运维命令

```bash
systemctl status sk5-panel.service --no-pager
docker ps --filter name=sk5-panel
journalctl -u sk5-panel.service -n 200 --no-pager
docker logs --tail 200 sk5-panel
sudo systemctl restart sk5-panel.service
systemctl list-units 'sk5-proxy@*' 'sk5-l2tp@*' 'sk5-relay@*'
```

## 7. 升级

仓库已克隆到本机时：

```bash
sudo bash deploy/update.sh
```

没有仓库时，重新执行一键安装即可保留数据和原登录凭据并升级：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-socks5/main/deploy/install.sh | sudo bash
```

## 8. 备份与恢复

```bash
sudo systemctl stop sk5-panel.service
sudo tar -C / -czf /root/sk5-panel-backup.tar.gz var/lib/sk5-panel etc/sk5-panel
sudo systemctl start sk5-panel.service
```

恢复到新服务器时，应先安装同版本面板，再停止服务并恢复上述目录：

```bash
sudo chown -R 10001:10001 /var/lib/sk5-panel
sudo systemctl restart sk5-panel.service
```

公网 IP、接口名和网关可能因服务器变化而不同。跨服务器恢复后必须重新检测并逐项验证出口。

## 9. 卸载

```bash
sudo bash deploy/uninstall.sh
```

卸载脚本会停止并删除面板容器及服务文件，但故意保留 `/var/lib/sk5-panel`、`/etc/sk5-panel` 和 `/root/sk5-panel-credentials.txt`。确认不再需要后再由管理员手动删除。

## 10. HTTPS 与访问限制

不要直接把 8787 端口向全网开放。应在云防火墙或 nftables 中限制管理员来源 IP，并在面板设置中配置管理员 CIDR 白名单。

生产环境建议使用 Caddy/Nginx 反向代理到 `127.0.0.1:8787` 并启用 HTTPS。

## 11. 故障排查

### 面板显示只读模式

```bash
journalctl -u sk5-panel.service -n 200 --no-pager
docker exec sk5-panel sudo -n /usr/local/libexec/sk5-panel-host-exec system check readiness
```

常见原因：Docker 启动参数被修改、宿主机缺少依赖、没有默认路由、容器不能进入宿主机命名空间，或管理员密码/出口探测未启用。

### 检测不到多个公网 IP

```bash
ip -4 -o address show
```

只有真实配置在本机网卡上的公网 IPv4 才会被识别。云厂商 NAT EIP 不会出现在本机地址列表中。

### SOCKS5 创建后出口不匹配

```bash
ip -4 rule
ip -4 route show table all
journalctl -u 'sk5-proxy@实例ID.service' -n 100 --no-pager
```

检查云厂商是否允许从选定公网 IP 发包、网关是否正确，以及安全组/防火墙是否允许对应监听端口。

### L2TP 无法上线

```bash
systemctl status 'sk5-l2tp@实例ID.service' --no-pager
journalctl -u 'sk5-l2tp@实例ID.service' -n 200 --no-pager
ip netns list
```

确认服务商提供的是普通 L2TP，并允许 UDP 1701。当前版本不自动配置 L2TP/IPsec。
