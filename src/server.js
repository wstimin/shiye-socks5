import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, publicState } from './store.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { detectNetwork, probeSocks5 } from './network.js';
import { assertCidr, assertCredential, assertEnum, assertHost, assertIPv4, assertPort, assertPublicIPv4, assertString, isIPv4InCidr, sanitizeId } from './validators.js';
import { SystemManager } from './system-manager.js';
import { allocateL2tpNetwork, allocateProxyRouting } from './resource-allocation.js';
import { evaluateReadiness, requireProductionReady } from './readiness.js';
import { AuthManager, LoginLimiter, parseCookies, validateAdminUsername, validateNewAdminPassword } from './auth.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = process.env.SK5_PANEL_DATA || path.join(rootDir, 'data');
const store = new Store(dataDir);
const port = Number(process.env.PORT || 8787);
const systemManager = new SystemManager({ dataDir, applyMode: false });
const auth = new AuthManager(dataDir, {
  username: process.env.SK5_PANEL_ADMIN_USER || 'admin',
  password: process.env.SK5_PANEL_ADMIN_PASSWORD || 'admin'
});
const loginLimiter = new LoginLimiter();
let currentNetwork = await detectNetwork();
let currentReadiness = await evaluateReadiness({ network: currentNetwork });
systemManager.applyMode = currentReadiness.ready;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function sessionToken(request) {
  return parseCookies(request.headers.cookie).sk5_session || '';
}

function currentSession(request) {
  return auth.getSession(sessionToken(request));
}

function isSecureRequest(request) {
  return Boolean(request.socket.encrypted) || process.env.SK5_PANEL_SECURE_COOKIE === 'true';
}

function sessionCookie(request, token, maxAge = 12 * 60 * 60) {
  return `sk5_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecureRequest(request) ? '; Secure' : ''}`;
}

function requireCsrf(request, session) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const providedBuffer = Buffer.from(String(request.headers['x-csrf-token'] || ''));
  const expectedBuffer = Buffer.from(session?.csrf || '');
  if (!providedBuffer.length || providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    const error = new Error('安全令牌已失效，请刷新页面后重试');
    error.statusCode = 403;
    throw error;
  }
}

function requestIPv4(request) {
  const address = request.socket.remoteAddress || '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function isPanelIpAllowed(request) {
  const entries = String(store.snapshot().settings.panelAllowlist || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (!entries.length) return true;
  const address = requestIPv4(request);
  if (address === '127.0.0.1' || address === '::1') return true;
  return entries.some((cidr) => isIPv4InCidr(address, cidr));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON 格式无效');
  }
}

function systemInfo(network, readiness = currentReadiness) {
  return {
    platform: process.platform,
    applyMode: readiness.ready,
    ready: readiness.ready,
    mode: readiness.mode,
    modeLabel: readiness.modeLabel,
    readiness,
    networkSource: network.source,
    hostname: process.env.HOSTNAME || process.env.COMPUTERNAME || 'sk5-gateway',
    version: '0.1.0',
    uptime: process.uptime(),
    adminUser: auth.username
  };
}

async function refreshEnvironment({ scan = false } = {}) {
  if (scan) currentNetwork = await detectNetwork();
  currentReadiness = await evaluateReadiness({ network: currentNetwork });
  systemManager.applyMode = currentReadiness.ready;
  if (process.platform === 'linux' && currentNetwork.source === 'native') syncDetectedPublicIps(currentNetwork);
  return { network: currentNetwork, readiness: currentReadiness };
}

async function requireReadyEnvironment() {
  const { readiness } = await refreshEnvironment();
  requireProductionReady(readiness);
}

async function bootstrap() {
  const { network, readiness } = await refreshEnvironment({ scan: true });
  return publicState(store.snapshot(), { ...systemInfo(network, readiness), network });
}

function addLog(state, level, scope, message) {
  state.logs.unshift({ id: crypto.randomUUID(), level, scope, message, createdAt: new Date().toISOString() });
  state.logs = state.logs.slice(0, 500);
}

function updateMeasuredPublicIp(state, proxy, actualIp) {
  if (proxy.outboundType !== 'public-ip') return;
  const publicIp = state.publicIps.find((item) => item.id === proxy.outboundId);
  if (publicIp) publicIp.measuredIp = actualIp;
}

async function createProxy(body) {
  await requireReadyEnvironment();
  const name = assertString(body.name, '实例名称', { max: 40 });
  const listenIp = assertIPv4(body.listenIp, '监听 IP');
  const portValue = assertPort(body.port);
  const username = assertCredential(body.username, '用户名', { min: 3, max: 32 });
  const password = assertCredential(body.password, '密码', { min: 8, max: 128 });
  const outboundType = assertEnum(body.outboundType, ['public-ip', 'l2tp'], '出口类型');
  const outboundId = assertString(body.outboundId, '出口资源', { max: 80 });
  const allowlist = Array.isArray(body.allowlist) ? body.allowlist.map((item) => assertCidr(item, '白名单')) : [];
  const maxConnections = Math.min(10000, Math.max(1, Number(body.maxConnections) || 500));
  const bandwidthMbps = Math.min(100000, Math.max(1, Number(body.bandwidthMbps) || 100));

  const proxy = store.update((state) => {
    if (state.proxies.some((proxy) => proxy.listenIp === listenIp && proxy.port === portValue)) {
      throw new Error(`${listenIp}:${portValue} 已被占用`);
    }
    const outbound = outboundType === 'public-ip'
      ? state.publicIps.find((item) => item.id === outboundId)
      : state.l2tp.find((item) => item.id === outboundId);
    if (!outbound) throw new Error('所选出口资源不存在');
    if (outboundType === 'l2tp' && (outbound.status !== 'online' || !outbound.actualIp)) throw new Error('所选 L2TP 出口尚未真实拨号并完成出口检测');
    if (outboundType === 'public-ip' && outbound.assignedTo) throw new Error('该公网 IP 已被其他实例专属占用');
    const listenResource = state.publicIps.find((item) => item.address === listenIp);
    if (!listenResource) throw new Error('监听 IP 必须来自服务器网卡自动检测结果');
    if (listenResource.assignedTo) throw new Error('该监听公网 IP 已被其他实例专属占用');
    if (outboundType === 'public-ip' && listenResource.id !== outbound.id) throw new Error('直连公网出口必须与监听公网 IP 一致');

    const id = `proxy-${crypto.randomUUID().slice(0, 8)}`;
    const expectedIp = outboundType === 'public-ip' ? outbound.address : outbound.actualIp;
    const routing = allocateProxyRouting(state);
    const proxy = {
      id, name, listenIp, listenIpId: listenResource.id, port: portValue, username,
      passwordEnc: encryptSecret(password, store.key),
      outboundType, outboundId,
      outboundLabel: outboundType === 'public-ip' ? outbound.address : outbound.name,
      expectedIp, actualIp: null,
      status: body.startNow === false ? 'stopped' : 'checking',
      allowlist, maxConnections, bandwidthMbps,
      ...routing,
      createdAt: new Date().toISOString(), lastCheckedAt: null
    };
    state.proxies.push(proxy);
    listenResource.assignedTo = id;
    listenResource.status = 'assigned';
    addLog(state, 'success', 'proxy', `已创建 ${name}，专属出口 ${proxy.outboundLabel}`);
    return proxy;
  });
  const snapshot = store.snapshot();
  const outbound = outboundType === 'public-ip'
    ? snapshot.publicIps.find((item) => item.id === outboundId)
    : snapshot.l2tp.find((item) => item.id === outboundId);
  systemManager.prepareProxy(proxy, password, outbound || {});
  if (body.startNow !== false) {
    try {
      await systemManager.run('proxy', proxy.id, 'start');
      const measured = await probeSocks5({
        listenIp: proxy.listenIp,
        port: proxy.port,
        username: proxy.username,
        password,
        url: snapshot.settings.probeUrl
      });
      const actualIp = measured;
      const matches = actualIp === proxy.expectedIp;
      if (!matches && snapshot.settings.failClosed) await systemManager.run('proxy', proxy.id, 'stop');
      store.update((state) => {
        const item = state.proxies.find((entry) => entry.id === proxy.id);
        if (!item) return;
        item.actualIp = actualIp;
        item.lastCheckedAt = new Date().toISOString();
        item.status = matches ? 'online' : 'mismatch';
        updateMeasuredPublicIp(state, item, actualIp);
        addLog(state, matches ? 'success' : 'error', 'proxy', `${proxy.name} 出口校验${matches ? '通过' : '失败'}：${actualIp || '无法连接'}`);
      });
    } catch (error) {
      try { await systemManager.run('proxy', proxy.id, 'delete'); } catch {}
      systemManager.removeRuntime('proxies', proxy.id);
      store.update((state) => {
        state.proxies = state.proxies.filter((entry) => entry.id !== proxy.id);
        const publicIp = state.publicIps.find((item) => item.assignedTo === proxy.id);
        if (publicIp) { publicIp.assignedTo = null; publicIp.status = 'available'; }
        addLog(state, 'error', 'proxy', `${proxy.name} 系统应用失败：${error.message}`);
      });
      throw error;
    }
  }
  return proxy;
}

function syncDetectedPublicIps(network) {
  const detected = network.interfaces.flatMap((networkInterface) => networkInterface.addresses
    .filter((address) => address.type === 'public')
    .map((address) => ({ address: address.address, interface: networkInterface.name, gateway: networkInterface.gateway || '' })));
  store.update((state) => {
    for (const entry of detected) {
      const current = state.publicIps.find((item) => item.address === entry.address);
      if (current) {
        current.interface = entry.interface;
        current.gateway = entry.gateway;
        current.detected = true;
        continue;
      }
      state.publicIps.push({
        id: `ip-${crypto.randomUUID().slice(0, 8)}`,
        address: entry.address,
        interface: entry.interface,
        gateway: entry.gateway,
        provider: '服务器网卡自动检测',
        status: 'available', assignedTo: null, measuredIp: null,
        detected: true
      });
    }
    for (const item of state.publicIps) item.detected = detected.some((entry) => entry.address === item.address);
    state.publicIps = state.publicIps.filter((item) => item.detected || item.assignedTo);
  });
}

async function createL2tp(body) {
  await requireReadyEnvironment();
  const name = assertString(body.name, '连接名称', { max: 40 });
  const server = assertHost(body.server, 'L2TP 服务器');
  const username = assertCredential(body.username, 'L2TP 用户名', { max: 80 });
  const password = assertCredential(body.password, 'L2TP 密码', { min: 1, max: 128 });
  const ipsec = Boolean(body.ipsec);
  if (ipsec) throw new Error('当前版本暂不支持自动配置 L2TP/IPsec，请使用普通 L2TP 或等待接入服务商专用 IPsec 配置');
  const psk = ipsec ? assertCredential(body.psk, 'IPsec PSK', { min: 1, max: 128 }) : '';
  const mtu = Math.min(1500, Math.max(1200, Number(body.mtu) || 1400));
  const connection = store.update((state) => {
    const id = `l2tp-${crypto.randomUUID().slice(0, 8)}`;
    const network = allocateL2tpNetwork(state);
    const connection = {
      id, name, server, username,
      passwordEnc: encryptSecret(password, store.key), ipsec,
      pskEnc: encryptSecret(psk, store.key), mtu,
      status: 'stopped', interface: null, localIp: null, actualIp: null,
      latency: null, reconnects: 0, createdAt: new Date().toISOString(), lastCheckedAt: null,
      ...network
    };
    state.l2tp.push(connection);
    addLog(state, 'success', 'l2tp', `已添加 L2TP 连接 ${name}`);
    return connection;
  });
  systemManager.prepareL2tp(connection, password, psk);
  return connection;
}

async function handleApi(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    return sendJson(response, 200, await bootstrap());
  }
  if (request.method === 'PUT' && url.pathname === '/api/auth/credentials') {
    const body = await readJson(request);
    const currentPassword = String(body.currentPassword || '');
    const username = validateAdminUsername(body.username);
    const newPassword = validateNewAdminPassword(body.newPassword);
    if (newPassword !== String(body.confirmPassword || '')) throw new Error('两次输入的新密码不一致');
    const session = auth.updateCredentials({ currentPassword, username, newPassword });
    store.log('warning', 'audit', `管理员登录账号已修改为 ${username}`);
    response.setHeader('Set-Cookie', sessionCookie(request, session.token));
    return sendJson(response, 200, { ok: true, username, csrfToken: session.csrf });
  }
  if (request.method === 'POST' && url.pathname === '/api/network/scan') {
    const { network, readiness } = await refreshEnvironment({ scan: true });
    store.log('info', 'network', `网络扫描完成，识别到 ${network.interfaces.length} 个接口`);
    return sendJson(response, 200, { network, system: systemInfo(network, readiness), state: publicState(store.snapshot(), { ...systemInfo(network, readiness), network }) });
  }
  if (request.method === 'POST' && url.pathname === '/api/proxies') {
    const proxy = await createProxy(await readJson(request));
    return sendJson(response, 201, { proxy });
  }
  if (request.method === 'POST' && url.pathname === '/api/l2tp') {
    const connection = await createL2tp(await readJson(request));
    return sendJson(response, 201, { connection });
  }
  if (request.method === 'PUT' && url.pathname === '/api/settings') {
    await requireReadyEnvironment();
    const body = await readJson(request);
    const panelAllowlist = String(body.panelAllowlist || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map((item) => assertCidr(item, '管理员 IP 白名单')).join('\n');
    const currentIp = requestIPv4(request);
    if (panelAllowlist && currentIp !== '127.0.0.1' && currentIp !== '::1' && !panelAllowlist.split('\n').some((cidr) => isIPv4InCidr(currentIp, cidr))) {
      throw new Error(`新的管理员白名单必须包含当前访问 IP：${currentIp}`);
    }
    store.update((state) => {
      state.settings = {
        ...state.settings,
        failClosed: Boolean(body.failClosed),
        panelAllowlist
      };
      addLog(state, 'info', 'system', '系统设置已更新');
    });
    return sendJson(response, 200, { ok: true });
  }
  if (parts[1] === 'proxies' && parts[2]) {
    const id = sanitizeId(parts[2]);
    if (request.method === 'DELETE' && parts.length === 3) {
      await requireReadyEnvironment();
      const current = store.snapshot().proxies.find((item) => item.id === id);
      if (!current) throw new Error('代理实例不存在');
      await systemManager.run('proxy', id, 'delete');
      store.update((state) => {
        const index = state.proxies.findIndex((item) => item.id === id);
        if (index < 0) throw new Error('代理实例不存在');
        const [proxy] = state.proxies.splice(index, 1);
        const publicIp = state.publicIps.find((item) => item.assignedTo === id);
        if (publicIp) { publicIp.assignedTo = null; publicIp.status = 'available'; }
        addLog(state, 'warning', 'proxy', `已删除 ${proxy.name}`);
      });
      systemManager.removeRuntime('proxies', id);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === 'POST' && ['start', 'stop', 'restart', 'check'].includes(parts[3])) {
      await requireReadyEnvironment();
      const action = parts[3];
      let result;
      if (action === 'check') {
        const state = store.snapshot();
        const current = state.proxies.find((item) => item.id === id);
        if (!current) throw new Error('代理实例不存在');
        const measured = await probeSocks5({
          listenIp: current.listenIp,
          port: current.port,
          username: current.username,
          password: decryptSecret(current.passwordEnc, store.key),
          url: state.settings.probeUrl
        });
        const effectiveIp = measured;
        const mismatch = effectiveIp !== current.expectedIp;
        if (mismatch && state.settings.failClosed) {
          await systemManager.run('proxy', id, 'stop');
        }
        result = store.update((next) => {
          const proxy = next.proxies.find((item) => item.id === id);
          proxy.actualIp = effectiveIp;
          proxy.lastCheckedAt = new Date().toISOString();
          proxy.status = !effectiveIp || mismatch ? 'mismatch' : 'online';
          updateMeasuredPublicIp(next, proxy, effectiveIp);
          addLog(next, proxy.status === 'online' ? 'success' : 'error', 'proxy', `${proxy.name} 出口校验${proxy.status === 'online' ? '通过' : '失败'}：${proxy.actualIp || '无法连接'}`);
          return proxy;
        });
      } else {
        await systemManager.run('proxy', id, action);
        if (action === 'stop') {
          result = store.update((state) => {
            const proxy = state.proxies.find((item) => item.id === id);
            if (!proxy) throw new Error('代理实例不存在');
            proxy.status = 'stopped';
            proxy.actualIp = null;
            addLog(state, 'info', 'proxy', `${proxy.name} 已停止`);
            return proxy;
          });
        } else {
          const snapshot = store.snapshot();
          const current = snapshot.proxies.find((item) => item.id === id);
          if (!current) throw new Error('代理实例不存在');
          const measured = await probeSocks5({
            listenIp: current.listenIp,
            port: current.port,
            username: current.username,
            password: decryptSecret(current.passwordEnc, store.key),
            url: snapshot.settings.probeUrl
          });
          const matches = measured === current.expectedIp;
          if (!matches && snapshot.settings.failClosed) await systemManager.run('proxy', id, 'stop');
          result = store.update((state) => {
            const proxy = state.proxies.find((item) => item.id === id);
            proxy.actualIp = measured;
            proxy.lastCheckedAt = new Date().toISOString();
            proxy.status = matches ? 'online' : 'mismatch';
            updateMeasuredPublicIp(state, proxy, measured);
            addLog(state, matches ? 'success' : 'error', 'proxy', `${proxy.name} ${action === 'start' ? '启动' : '重启'}后出口校验${matches ? '通过' : '失败'}：${measured || '无法连接'}`);
            return proxy;
          });
        }
      }
      return sendJson(response, 200, { proxy: result });
    }
    if (request.method === 'POST' && parts[3] === 'reveal-password') {
      const state = store.snapshot();
      const proxy = state.proxies.find((item) => item.id === id);
      if (!proxy) throw new Error('代理实例不存在');
      const password = decryptSecret(proxy.passwordEnc, store.key);
      store.log('warning', 'audit', `查看了 SOCKS5 实例 ${proxy.name} 的密码`);
      return sendJson(response, 200, { password });
    }
  }
  if (parts[1] === 'l2tp' && parts[2]) {
    const id = sanitizeId(parts[2]);
    if (request.method === 'DELETE' && parts.length === 3) {
      await requireReadyEnvironment();
      const snapshot = store.snapshot();
      if (snapshot.proxies.some((item) => item.outboundType === 'l2tp' && item.outboundId === id)) throw new Error('该连接正被 SOCKS5 实例使用');
      if (!snapshot.l2tp.some((item) => item.id === id)) throw new Error('L2TP 连接不存在');
      await systemManager.run('l2tp', id, 'delete');
      store.update((state) => {
        if (state.proxies.some((item) => item.outboundType === 'l2tp' && item.outboundId === id)) throw new Error('该连接正被 SOCKS5 实例使用');
        const index = state.l2tp.findIndex((item) => item.id === id);
        if (index < 0) throw new Error('L2TP 连接不存在');
        const [connection] = state.l2tp.splice(index, 1);
        addLog(state, 'warning', 'l2tp', `已删除 ${connection.name}`);
      });
      systemManager.removeRuntime('l2tp', id);
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === 'POST' && ['connect', 'disconnect', 'reconnect'].includes(parts[3])) {
      await requireReadyEnvironment();
      const action = parts[3];
      const operation = await systemManager.run('l2tp', id, action);
      let detected = {};
      if (operation.stdout) {
        try { detected = JSON.parse(operation.stdout.split(/\r?\n/).at(-1)); } catch { detected = {}; }
      }
      if (action !== 'disconnect') {
        if (!detected.interface || !detected.localIp || !detected.actualIp) {
          try { await systemManager.run('l2tp', id, 'disconnect'); } catch {}
          throw new Error('L2TP 已执行拨号，但未取得完整的真实 PPP 接口、本地地址和公网出口');
        }
        assertIPv4(detected.localIp, 'L2TP 本地 IP');
        assertPublicIPv4(detected.actualIp, 'L2TP 实际出口 IP');
      }
      const connection = store.update((state) => {
        const item = state.l2tp.find((entry) => entry.id === id);
        if (!item) throw new Error('L2TP 连接不存在');
        if (action === 'disconnect') {
          item.status = 'stopped'; item.interface = null; item.localIp = null; item.actualIp = null; item.latency = null;
        } else {
          item.status = 'online';
          item.interface = assertString(detected.interface, 'PPP 接口', { max: 32 });
          item.localIp = detected.localIp;
          item.actualIp = detected.actualIp;
          item.latency = null;
          if (action === 'reconnect') item.reconnects += 1;
          item.lastCheckedAt = new Date().toISOString();
        }
        addLog(state, 'info', 'l2tp', `${item.name} 已${action === 'connect' ? '连接' : action === 'disconnect' ? '断开' : '重拨'}`);
        return item;
      });
      return sendJson(response, 200, { connection });
    }
    if (request.method === 'POST' && parts[3] === 'reveal-secret') {
      const state = store.snapshot();
      const connection = state.l2tp.find((item) => item.id === id);
      if (!connection) throw new Error('L2TP 连接不存在');
      store.log('warning', 'audit', `查看了 L2TP 连接 ${connection.name} 的凭据`);
      return sendJson(response, 200, {
        password: decryptSecret(connection.passwordEnc, store.key),
        psk: connection.pskEnc ? decryptSecret(connection.pskEnc, store.key) : ''
      });
    }
  }
  return sendJson(response, 404, { error: '接口不存在' });
}

function serveStatic(response, url) {
  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.resolve(publicDir, `.${requestPath}`);
  if (!(filePath === publicDir || filePath.startsWith(`${publicDir}${path.sep}`)) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404); response.end('Not found'); return;
  }
  response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, { ok: true, ready: currentReadiness.ready, mode: currentReadiness.mode });
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      if (!isPanelIpAllowed(request)) return sendJson(response, 403, { error: '当前 IP 不在管理员白名单中' });
      const key = requestIPv4(request);
      loginLimiter.assertAllowed(key);
      const body = await readJson(request);
      if (!auth.verify(String(body.username || ''), String(body.password || ''))) {
        loginLimiter.failure(key);
        store.log('warning', 'audit', `管理员登录失败：${key}`);
        return sendJson(response, 401, { error: '用户名或密码错误' });
      }
      loginLimiter.success(key);
      const session = auth.createSession();
      response.setHeader('Set-Cookie', sessionCookie(request, session.token));
      store.log('info', 'audit', `管理员已登录：${key}`);
      return sendJson(response, 200, { ok: true, username: session.username, csrfToken: session.csrf });
    }

    const session = currentSession(request);
    if (request.method === 'GET' && url.pathname === '/api/auth/session') {
      if (!session) return sendJson(response, 401, { authenticated: false });
      return sendJson(response, 200, { authenticated: true, username: session.username, csrfToken: session.csrf });
    }
    if (!session) {
      if (!url.pathname.startsWith('/api/') && !['/', '/index.html'].includes(url.pathname)) return serveStatic(response, url);
      if (!url.pathname.startsWith('/api/')) {
        response.writeHead(302, { Location: '/login.html' });
        response.end();
        return;
      }
      return sendJson(response, 401, { error: '登录已失效，请重新登录' });
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      requireCsrf(request, session);
      auth.revoke(sessionToken(request));
      response.setHeader('Set-Cookie', sessionCookie(request, '', 0));
      return sendJson(response, 200, { ok: true });
    }
    requireCsrf(request, session);
    if (!isPanelIpAllowed(request)) {
      sendJson(response, 403, { error: '当前 IP 不在管理员白名单中' });
      return;
    }
    if (url.pathname === '/login.html') {
      response.writeHead(302, { Location: '/' });
      response.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else serveStatic(response, url);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message || '请求失败' });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`sk5面板 running at http://localhost:${port}`);
  console.log(`Mode: ${currentReadiness.ready ? 'production' : 'read-only'}`);
});
