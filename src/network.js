import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function classifyIPv4(address) {
  const octets = String(address).split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return 'invalid';
  }
  const [a, b, c] = octets;
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 169 && b === 254) return 'link-local';
  if (
    a === 0
    || a >= 224
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
  ) return 'reserved';
  return 'public';
}

function fallbackInterfaces() {
  const interfaces = [];
  const raw = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(raw)) {
    const ipv4 = addresses.filter((entry) => entry.family === 'IPv4').map((entry) => ({
      address: entry.address,
      cidr: entry.cidr,
      type: classifyIPv4(entry.address)
    }));
    if (!ipv4.length) continue;
    interfaces.push({
      name,
      kind: name.startsWith('ppp') ? 'ppp' : name === 'lo' ? 'loopback' : 'ethernet',
      state: addresses.some((entry) => !entry.internal) ? 'up' : name === 'lo' ? 'up' : 'down',
      mac: addresses.find((entry) => entry.mac)?.mac || '-',
      mtu: null,
      defaultRoute: false,
      gateway: '',
      addresses: ipv4,
      rxBytes: 0,
      txBytes: 0
    });
  }
  return interfaces;
}

async function linuxInterfaces() {
  const [{ stdout: addressJson }, { stdout: routeJson }] = await Promise.all([
    execFileAsync('ip', ['-j', '-s', 'address', 'show']),
    execFileAsync('ip', ['-j', 'route', 'show', 'default'])
  ]);
  const links = JSON.parse(addressJson);
  const routes = JSON.parse(routeJson);
  const defaults = new Set(routes.map((route) => route.dev).filter(Boolean));

  return links.map((link) => ({
    name: link.ifname,
    kind: link.link_type === 'loopback' ? 'loopback' : link.ifname.startsWith('ppp') ? 'ppp' : link.linkinfo?.info_kind || 'ethernet',
    state: String(link.operstate || '').toLowerCase() === 'up' ? 'up' : 'down',
    mac: link.address || '-',
    mtu: link.mtu || null,
    defaultRoute: defaults.has(link.ifname),
    gateway: routes.find((route) => route.dev === link.ifname)?.gateway || '',
    addresses: (link.addr_info || [])
      .filter((entry) => entry.family === 'inet')
      .map((entry) => ({
        address: entry.local,
        cidr: `${entry.local}/${entry.prefixlen}`,
        type: classifyIPv4(entry.local)
      })),
    rxBytes: link.stats64?.rx?.bytes || link.stats?.rx?.bytes || 0,
    txBytes: link.stats64?.tx?.bytes || link.stats?.tx?.bytes || 0
  }));
}

export async function detectNetwork() {
  let interfaces;
  let source = 'native';
  if (process.platform === 'linux') {
    try {
      interfaces = await linuxInterfaces();
    } catch {
      interfaces = fallbackInterfaces();
      source = 'fallback';
    }
  } else {
    interfaces = fallbackInterfaces();
    source = 'development';
  }

  return {
    interfaces,
    source,
    privateIps: interfaces.flatMap((item) => item.addresses.filter((address) => address.type === 'private').map((address) => address.address)),
    detectedPublicIps: interfaces.flatMap((item) => item.addresses.filter((address) => address.type === 'public').map((address) => address.address))
  };
}

export async function probePublicIp(sourceIp = '') {
  if (process.env.SK5_PANEL_ALLOW_PROBE !== 'true') return null;
  const args = ['--silent', '--show-error', '--max-time', '5'];
  if (sourceIp) args.push('--interface', sourceIp);
  args.push('https://api.ipify.org');
  try {
    const { stdout } = await execFileAsync('curl', args);
    const ip = stdout.trim();
    return classifyIPv4(ip) === 'public' ? ip : null;
  } catch {
    return null;
  }
}

export async function probeSocks5({ listenIp, port, username, password, url = 'https://api.ipify.org' }) {
  if (process.env.SK5_PANEL_ALLOW_PROBE !== 'true') return null;
  const proxyUrl = `socks5h://${listenIp}:${port}`;
  try {
    const { stdout } = await execFileAsync('curl', [
      '--silent', '--show-error', '--max-time', '8',
      '--proxy', proxyUrl,
      '--proxy-user', `${username}:${password}`,
      url
    ]);
    const ip = stdout.trim();
    return classifyIPv4(ip) === 'public' ? ip : null;
  } catch {
    return null;
  }
}
