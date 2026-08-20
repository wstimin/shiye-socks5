# sk5面板

sk5面板是在单台 Linux 服务器上管理真实 SOCKS5 实例、公网 IP 专属出口和 L2TP 出口的 Web 面板。

它不会导入或生成演示资源。面板只读取服务器真实网卡、地址和路由；每个 SOCKS5 实例都由独立的 3proxy 配置及 systemd 服务承载，创建后还会通过代理检测真实公网出口。

## 主要能力

- 自动检测 Linux 网卡、内网 IPv4、本机公网 IPv4、默认网关和路由。
- 公网 IP 和实例数量不设置应用层上限。
- 一个 SOCKS5 实例可以独占一个本机公网 IPv4。
- 使用源策略路由固定公网出口，防止流量走错 IP。
- 每条普通 L2TP 连接使用独立 Linux 网络命名空间。
- PPP 断开后保持不可达默认路由，避免静默回落到服务器主出口。
- 通过 SOCKS5 实际访问外部探测地址，出口不匹配时自动停止实例。
- 密码使用 AES-256-GCM 加密保存，可在面板中按需查看和复制。
- 提供独立管理员登录页，默认账号密码为 `admin/admin`，可在后台修改。
- 管理员密码使用 scrypt 哈希保存，登录使用 HttpOnly 会话 Cookie、CSRF 校验和失败限速。
- 面板进程使用非 root 用户；系统操作通过固定 root helper 完成。
- 支持 Ubuntu 22.04/24.04 和 Debian 12。
- 提供 amd64、arm64 Docker 镜像及一键安装脚本。

## 一键安装

使用全新的 Ubuntu 22.04/24.04 或 Debian 12 服务器，以 root 执行：

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-socks5/main/deploy/install.sh | sudo bash
```

脚本会自动安装 Docker、3proxy、iproute2、nftables、xl2tpd、pppd 等宿主机依赖，拉取：

```text
ghcr.io/wstimin/shiye-socks5:latest
```

安装完成后会输出面板地址和默认登录凭据：

```text
用户名：admin
密码：admin
```

首次登录后请立即进入“系统设置 -> 管理员账户”修改用户名和密码。安装时的初始凭据同时保存在仅 root 可读的：

```text
/root/sk5-panel-credentials.txt
```

该文件只记录安装时的初始凭据；从后台修改登录信息后不会向磁盘写入新的明文密码。服务器已有 `/var/lib/sk5-panel/auth.json` 时，重装或升级会保留后台当前账户，也不会覆盖该初始凭据文件。

详细的部署、升级、备份、卸载和故障排查说明见 [部署文档](docs/DEPLOYMENT.md)。

## 自定义安装

```bash
curl -fsSL https://raw.githubusercontent.com/wstimin/shiye-socks5/main/deploy/install.sh -o /tmp/sk5-install.sh
sudo env \
  SK5_PANEL_PORT=8787 \
  SK5_PANEL_ADMIN_USER=admin \
  SK5_PANEL_ADMIN_PASSWORD='ChangeThisPassword' \
  bash /tmp/sk5-install.sh
```

固定镜像版本：

```bash
sudo env SK5_PANEL_IMAGE=ghcr.io/wstimin/shiye-socks5:1.0.0 bash /tmp/sk5-install.sh
```

## 运行结构

面板应用运行在容器中，但 3proxy 实例、策略路由、nftables、L2TP 和 systemd 实例服务运行在宿主机。

这是有意的混合部署：公网源地址、Linux 网络命名空间和 PPP 接口必须直接作用于宿主机网络。容器使用 host network、host PID 和受控的宿主机 helper；不能替换成普通 bridge 网络容器，否则无法可靠绑定服务器真实公网出口。

## 生产就绪保护

只有以下检查全部通过，面板才进入“生产执行模式”：

- Linux 系统及生产执行开关已启用。
- 配置了管理员密码和真实出口探测。
- 通过 iproute2 读取到 UP 状态网卡及默认路由。
- 3proxy、curl、jq、socat、nft、xl2tpd、pppd、systemctl、sudo 可执行。
- 容器可以通过固定 helper 调用宿主机 systemd 和网络能力。

任一条件失败时面板进入只读模式，创建、启动、停止、删除和设置修改接口返回 HTTP 503，不会模拟成功。

## 网络前提

直连公网 IP 必须真实配置在服务器 Linux 网卡上，并且云厂商允许该地址作为源地址发包。仅存在于云厂商上游 NAT 的 EIP 不能直接绑定到本机 socket，需要该云厂商专用的 EIP 映射支持。

当前自动部署支持普通 L2TP，不自动配置 L2TP/IPsec。不同服务商的 strongSwan proposal、身份、transport mode 和防火墙参数不同，不能用一套通用参数安全替代。

## 本地开发

```bash
npm start
```

打开 `http://127.0.0.1:8787`。Windows 和依赖不完整的 Linux 环境会显示空白只读状态，不创建示例资源。

```bash
npm test
npm run check
```

## 镜像发布

推送到默认分支后，[GitHub Actions](.github/workflows/docker-publish.yml) 会构建 amd64/arm64 镜像并发布到 GHCR。推送 `v1.2.3` 形式的标签还会生成 `1.2.3` 和 `1.2` 镜像标签。

首次发布后，请在 GitHub Package 设置中确认 `ghcr.io/wstimin/shiye-socks5` 为 Public，否则未登录服务器无法直接拉取镜像。
