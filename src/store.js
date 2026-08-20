import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadOrCreateKey } from './crypto.js';
import { ensureResourceAllocations } from './resource-allocation.js';

const now = () => new Date().toISOString();

function emptyState() {
  return {
    version: 1,
    publicIps: [],
    proxies: [],
    l2tp: [],
    logs: [
      { id: crypto.randomUUID(), level: 'info', scope: 'system', message: '面板已初始化，等待连接 Linux 生产执行环境并检测真实网络', createdAt: now() }
    ],
    settings: {
      failClosed: true,
      panelAllowlist: '',
      probeUrl: 'https://api.ipify.org'
    }
  };
}

function isLegacyPreviewState(state) {
  const previewIds = new Set(['ip-a', 'ip-b', 'ip-c', 'proxy-a', 'proxy-b', 'l2tp-hk-01']);
  const resources = [...(state.publicIps || []), ...(state.proxies || []), ...(state.l2tp || [])];
  return resources.some((item) => previewIds.has(item.id))
    || (state.proxies || []).some((item) => item.name === '上海业务 A' || item.name === '上海业务 B');
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.key = loadOrCreateKey(dataDir);
    if (!fs.existsSync(this.file)) this.write(emptyState());
    this.state = this.read();
    if (isLegacyPreviewState(this.state)) {
      const archive = path.join(dataDir, `state.legacy-preview-${Date.now()}.json`);
      fs.copyFileSync(this.file, archive);
      this.state = emptyState();
      this.state.logs[0].message = '已归档并清除旧版本演示数据，等待检测真实服务器网络';
      this.write(this.state);
    }
    if (ensureResourceAllocations(this.state)) this.write(this.state);
  }

  read() {
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  write(next) {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  snapshot() {
    return structuredClone(this.state);
  }

  update(mutator) {
    const next = structuredClone(this.state);
    const result = mutator(next);
    this.write(next);
    this.state = next;
    return result;
  }

  log(level, scope, message) {
    this.update((state) => {
      state.logs.unshift({ id: crypto.randomUUID(), level, scope, message, createdAt: now() });
      state.logs = state.logs.slice(0, 500);
    });
  }
}

export function publicState(state, system) {
  const { allocations, ...safeState } = state;
  const proxies = state.proxies.map(({ passwordEnc, ...proxy }) => ({ ...proxy, hasPassword: Boolean(passwordEnc) }));
  const l2tp = state.l2tp.map(({ passwordEnc, pskEnc, ...connection }) => ({
    ...connection,
    hasPassword: Boolean(passwordEnc),
    hasPsk: Boolean(pskEnc)
  }));
  const onlineProxies = proxies.filter((item) => item.status === 'online').length;
  const onlineL2tp = l2tp.filter((item) => item.status === 'online').length;
  return {
    ...safeState,
    proxies,
    l2tp,
    system,
    overview: {
      onlineProxies,
      totalProxies: proxies.length,
      onlineL2tp,
      totalL2tp: l2tp.length,
      publicIpCount: state.publicIps.length,
      availableIpCount: state.publicIps.filter((item) => item.status === 'available').length
    }
  };
}
