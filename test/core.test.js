import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyIPv4 } from '../src/network.js';
import { decryptSecret, encryptSecret } from '../src/crypto.js';
import { Store, publicState } from '../src/store.js';
import { evaluateReadiness, requireProductionReady } from '../src/readiness.js';
import { SystemManager } from '../src/system-manager.js';
import { assertCidr, assertCredential, assertPort, assertPublicIPv4, isIPv4InCidr } from '../src/validators.js';
import { render3ProxyConfig } from '../src/proxy-config.js';
import { allocateL2tpNetwork, allocateProxyRouting, ensureResourceAllocations, namespaceNetwork } from '../src/resource-allocation.js';

test('classifies common IPv4 ranges', () => {
  assert.equal(classifyIPv4('10.1.2.3'), 'private');
  assert.equal(classifyIPv4('172.31.2.3'), 'private');
  assert.equal(classifyIPv4('192.168.1.2'), 'private');
  assert.equal(classifyIPv4('100.64.1.2'), 'cgnat');
  assert.equal(classifyIPv4('192.0.2.10'), 'reserved');
  assert.equal(classifyIPv4('198.51.100.10'), 'reserved');
  assert.equal(classifyIPv4('203.0.113.10'), 'reserved');
  assert.equal(classifyIPv4('198.18.0.1'), 'reserved');
  assert.equal(classifyIPv4('8.8.8.8'), 'public');
  assert.equal(classifyIPv4('999.1.1.1'), 'invalid');
});

test('encrypts secrets and decrypts them with the same key', () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptSecret('client-password', key);
  assert.notEqual(encrypted, 'client-password');
  assert.equal(decryptSecret(encrypted, key), 'client-password');
});

test('every new store starts empty without preview resources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk5-store-'));
  const store = new Store(root);
  const snapshot = store.snapshot();
  assert.equal(snapshot.publicIps.length, 0);
  assert.equal(snapshot.proxies.length, 0);
  assert.equal(snapshot.l2tp.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /demo-password|上海业务|203\.0\.113/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('public state never exposes encrypted password fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk5-public-'));
  const store = new Store(root);
  store.update((state) => {
    state.proxies.push({
      id: 'proxy-real',
      name: '业务线路',
      username: 'client_real',
      passwordEnc: encryptSecret('real-password', store.key),
      status: 'stopped',
      connections: 0,
      trafficIn: 0,
      trafficOut: 0
    });
  });
  const result = publicState(store.snapshot(), { network: { interfaces: [] } });
  assert.equal('passwordEnc' in result.proxies[0], false);
  assert.equal(result.proxies[0].hasPassword, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('validates credentials, CIDR and ports', () => {
  assert.equal(assertCredential('user_01', '用户名'), 'user_01');
  assert.throws(() => assertCredential('user\nallow *', '用户名'));
  assert.equal(assertCidr('1.1.1.8/32', '白名单'), '1.1.1.8/32');
  assert.throws(() => assertCidr('1.1.1.8/64'));
  assert.equal(isIPv4InCidr('1.1.1.8', '1.1.1.0/24'), true);
  assert.equal(isIPv4InCidr('1.1.2.8', '1.1.1.0/24'), false);
  assert.equal(assertPort(1080), 1080);
  assert.throws(() => assertPort(70000));
  assert.equal(assertPublicIPv4('8.8.8.8'), '8.8.8.8');
  assert.throws(() => assertPublicIPv4('10.0.0.1'));
  assert.throws(() => assertPublicIPv4('203.0.113.8'));
});

test('3proxy config binds internal and external addresses for direct IP mode', () => {
  const config = render3ProxyConfig({
    username: 'client_01',
    listenIp: '8.8.8.8',
    port: 1080,
    outboundType: 'public-ip',
    expectedIp: '8.8.8.8',
    allowlist: []
  }, 'StrongPass01!');
  assert.match(config, /internal 8\.8\.8\.8/);
  assert.match(config, /external 8\.8\.8\.8/);
  assert.match(config, /socks -p1080/);
  assert.match(config, /maxconn 500/);
  assert.match(config, /bandlimout 12500000 client_01/);
  assert.doesNotMatch(config, /^daemon$/m);
});

test('system manager rejects commands when production mode is unavailable', async () => {
  const manager = new SystemManager({ dataDir: os.tmpdir(), applyMode: false });
  await assert.rejects(() => manager.run('proxy', 'proxy-a', 'start'), /生产执行环境未就绪/);
});

test('production guard rejects read-only readiness with HTTP 503 semantics', () => {
  assert.throws(
    () => requireProductionReady({ ready: false }),
    (error) => error.statusCode === 503 && /禁止创建和系统操作/.test(error.message)
  );
});

test('readiness reports structured failures outside Linux', async () => {
  const readiness = await evaluateReadiness({
    platform: 'win32',
    env: {},
    network: { source: 'development', interfaces: [] },
    fileExists: () => false,
    canExecute: () => false
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.mode, 'readonly');
  assert.ok(readiness.checks.some((item) => item.key === 'linux' && item.ok === false));
  assert.ok(readiness.checks.every((item) => typeof item.label === 'string' && typeof item.detail === 'string'));
});

test('readiness becomes production only when every real prerequisite passes', async () => {
  const readiness = await evaluateReadiness({
    platform: 'linux',
    env: {
      SK5_PANEL_APPLY: 'true',
      SK5_PANEL_ALLOW_PROBE: 'true',
      SK5_PANEL_ADMIN_PASSWORD: 'strong-password'
    },
    network: {
      source: 'native',
      interfaces: [{ name: 'eth0', state: 'up', defaultRoute: true }]
    },
    fileExists: () => true,
    canExecute: () => true,
    runHelper: async () => ({ stdout: '{"ready":true}\n' })
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.modeLabel, '生产执行模式');
});

test('allocates unique persistent routing resources without hash collisions', () => {
  const state = { proxies: [], l2tp: [], allocations: {} };
  const first = allocateProxyRouting(state);
  state.proxies.push({ id: 'proxy-a', ...first });
  const second = allocateProxyRouting(state);
  assert.notEqual(first.routeTable, second.routeTable);
  assert.notEqual(first.routePriority, second.routePriority);
  ensureResourceAllocations(state);
  assert.ok(state.allocations.nextRouteTable > second.routeTable);
});

test('repairs duplicate resource identifiers in migrated state', () => {
  const state = {
    allocations: {},
    proxies: [
      { id: 'proxy-a', routeTable: 10001, routePriority: 20001 },
      { id: 'proxy-b', routeTable: 10001, routePriority: 20001 }
    ],
    l2tp: [
      { id: 'l2tp-a', namespaceIndex: 3 },
      { id: 'l2tp-b', namespaceIndex: 3 }
    ]
  };
  ensureResourceAllocations(state);
  assert.notEqual(state.proxies[0].routeTable, state.proxies[1].routeTable);
  assert.notEqual(state.proxies[0].routePriority, state.proxies[1].routePriority);
  assert.notEqual(state.l2tp[0].namespaceIndex, state.l2tp[1].namespaceIndex);
});

test('allocates non-overlapping L2TP namespace networks and valid veth names', () => {
  const state = { proxies: [], l2tp: [], allocations: {} };
  const first = allocateL2tpNetwork(state);
  state.l2tp.push({ id: 'l2tp-a', ...first });
  const second = allocateL2tpNetwork(state);
  assert.notEqual(first.hostIp, second.hostIp);
  assert.notEqual(first.namespace, second.namespace);
  assert.ok(first.hostVeth.length <= 15);
  assert.deepEqual(namespaceNetwork(16384), {
    namespaceIndex: 16384,
    namespace: 'sk5-l2tp-cn4',
    hostVeth: 'sk5hcn4',
    namespaceVeth: 'sk5ncn4',
    hostIp: '10.65.0.1',
    namespaceIp: '10.65.0.2',
    cidr: 30
  });
});

test('deployment helper persists enabled instances across server reboots', () => {
  const helper = fs.readFileSync(new URL('../deploy/sk5-panel-helper', import.meta.url), 'utf8');
  assert.match(helper, /service_action enable --now "sk5-proxy@\$ID\.service"/);
  assert.match(helper, /systemctl enable "sk5-l2tp@\$ID\.service"/);
  assert.match(helper, /autodial = yes/);
  assert.match(helper, /l2tp_exec\(\) \{[\s\S]*setup_l2tp_namespace[\s\S]*render_l2tp_config/);
});

test('container deployment keeps the panel unprivileged and delegates fixed host operations', () => {
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const hostExecutor = fs.readFileSync(new URL('../deploy/docker/sk5-panel-host-exec', import.meta.url), 'utf8');
  const sudoers = fs.readFileSync(new URL('../deploy/docker/sk5-panel-container.sudoers', import.meta.url), 'utf8');
  const service = fs.readFileSync(new URL('../deploy/docker/sk5-panel.service', import.meta.url), 'utf8');
  const installer = fs.readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');

  assert.match(dockerfile, /^USER sk5panel$/m);
  assert.match(hostExecutor, /nsenter --target 1 --mount --uts --ipc --net --pid/);
  assert.doesNotMatch(sudoers, /NOPASSWD:\s*ALL/);
  assert.match(sudoers, /system check readiness/);
  assert.match(service, /--network host --pid host --privileged/);
  assert.match(service, /--volume \/var\/lib\/sk5-panel:\/var\/lib\/sk5-panel:rw/);
  assert.match(installer, /ghcr\.io\/wstimin\/shiye-socks5:latest/);
  assert.match(installer, /system\.ready \/\/ false/);
});
