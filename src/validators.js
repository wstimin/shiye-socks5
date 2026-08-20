import { classifyIPv4 } from './network.js';

export function assertString(value, field, { min = 1, max = 128 } = {}) {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max) throw new Error(`${field} 长度必须为 ${min}-${max} 个字符`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${field} 不能包含控制字符`);
  return text;
}

export function assertCredential(value, field, { min = 1, max = 128 } = {}) {
  const text = assertString(value, field, { min, max });
  if (!/^[A-Za-z0-9_.@#%+=!?-]+$/.test(text)) {
    throw new Error(`${field} 只能包含字母、数字和 _.@#%+=!?-`);
  }
  return text;
}

export function assertHost(value, field = '服务器地址') {
  const host = assertString(value, field, { max: 253 });
  if (!/^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/.test(host)) {
    throw new Error(`${field} 格式无效`);
  }
  return host;
}

export function assertCidr(value, field = 'CIDR') {
  const text = assertString(value, field, { max: 64 });
  const [ip, prefix] = text.split('/');
  const prefixValue = Number(prefix);
  if (classifyIPv4(ip) === 'invalid' || !Number.isInteger(prefixValue) || prefixValue < 0 || prefixValue > 32) {
    throw new Error(`${field} 格式无效`);
  }
  return text;
}

export function isIPv4InCidr(address, cidr) {
  const ipToInteger = (ip) => ip.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
  const [network, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (classifyIPv4(address) === 'invalid' || classifyIPv4(network) === 'invalid' || !Number.isInteger(prefix)) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipToInteger(address) & mask) === (ipToInteger(network) & mask);
}

export function assertIPv4(value, field = 'IP 地址') {
  const ip = String(value || '').trim();
  if (classifyIPv4(ip) === 'invalid') throw new Error(`${field} 格式无效`);
  return ip;
}

export function assertPublicIPv4(value, field = '公网 IP') {
  const ip = String(value || '').trim();
  if (classifyIPv4(ip) !== 'public') throw new Error(`${field} 不是可用的公网 IPv4 地址`);
  return ip;
}

export function assertPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1-65535 之间');
  return port;
}

export function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} 无效`);
  return value;
}

export function sanitizeId(value) {
  const id = String(value || '');
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('资源 ID 无效');
  return id;
}
