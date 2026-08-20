import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { render3ProxyConfig } from './proxy-config.js';

const execFileAsync = promisify(execFile);

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

export class SystemManager {
  constructor({ dataDir, applyMode }) {
    this.runtimeDir = path.join(dataDir, 'runtime');
    this.applyMode = applyMode;
    this.helper = process.env.SK5_PANEL_HELPER || '/usr/local/libexec/sk5-panel-helper';
  }

  prepareProxy(proxy, password, outbound) {
    const instanceDir = path.join(this.runtimeDir, 'proxies', proxy.id);
    const manifest = {
      version: 1,
      id: proxy.id,
      name: proxy.name,
      listenIp: proxy.listenIp,
      port: proxy.port,
      username: proxy.username,
      password,
      outboundType: proxy.outboundType,
      outboundId: proxy.outboundId,
      expectedIp: proxy.expectedIp,
      interface: outbound.interface || '',
      gateway: outbound.gateway || '',
      pppInterface: outbound.interface || '',
      l2tpNamespace: proxy.outboundType === 'l2tp' ? outbound.namespace : '',
      l2tpProxyIp: proxy.outboundType === 'l2tp' ? outbound.namespaceIp : '',
      routeTable: proxy.routeTable,
      routePriority: proxy.routePriority,
      failClosed: true
    };
    writePrivate(path.join(instanceDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writePrivate(path.join(instanceDir, '3proxy.cfg'), render3ProxyConfig({
      ...proxy,
      listenIp: proxy.outboundType === 'l2tp' ? manifest.l2tpProxyIp : proxy.listenIp
    }, password));
    return manifest;
  }

  prepareL2tp(connection, password, psk) {
    const instanceDir = path.join(this.runtimeDir, 'l2tp', connection.id);
    const manifest = {
      version: 1,
      id: connection.id,
      name: connection.name,
      server: connection.server,
      username: connection.username,
      password,
      ipsec: connection.ipsec,
      psk,
      mtu: connection.mtu,
      namespaceIndex: connection.namespaceIndex,
      namespace: connection.namespace,
      hostVeth: connection.hostVeth,
      namespaceVeth: connection.namespaceVeth,
      hostIp: connection.hostIp,
      namespaceIp: connection.namespaceIp,
      cidr: connection.cidr
    };
    writePrivate(path.join(instanceDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  async run(resource, id, action) {
    if (!this.applyMode) throw new Error('Linux 生产执行环境未就绪');
    const { stdout, stderr } = await execFileAsync('sudo', [this.helper, resource, action, id], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, SK5_RUNTIME_ROOT: this.runtimeDir }
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  }

  removeRuntime(resource, id) {
    const target = path.resolve(this.runtimeDir, resource, id);
    const root = path.resolve(this.runtimeDir, resource) + path.sep;
    if (!target.startsWith(root)) throw new Error('Invalid runtime path');
    fs.rmSync(target, { recursive: true, force: true });
  }
}
