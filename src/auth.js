import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function decodePasswordHash(encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return null;
  try {
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    if (salt.length !== 16 || expected.length !== 64) return null;
    if (salt.toString('base64') !== parts[1] || expected.toString('base64') !== parts[2]) return null;
    return { salt, expected };
  } catch {
    return null;
  }
}

function verifyPassword(password, encoded) {
  const decoded = decodePasswordHash(encoded);
  if (!decoded) return false;
  try {
    const actual = crypto.scryptSync(password, decoded.salt, decoded.expected.length, SCRYPT_OPTIONS);
    return crypto.timingSafeEqual(actual, decoded.expected);
  } catch {
    return false;
  }
}

function sessionKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const entry of String(header).split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    if (!key) continue;
    try { cookies[key] = decodeURIComponent(entry.slice(separator + 1).trim()); } catch {}
  }
  return cookies;
}

export function validateAdminUsername(value) {
  const username = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username)) throw new Error('管理员用户名仅支持字母、数字、点、下划线和短横线');
  return username;
}

export function validateNewAdminPassword(value) {
  const password = String(value || '');
  if (password.length < 8 || password.length > 128) throw new Error('新密码长度必须为 8-128 个字符');
  if (/\r|\n/.test(password)) throw new Error('新密码不能包含换行符');
  return password;
}

export class AuthManager {
  constructor(dataDir, { username = 'admin', password = 'admin', now = () => Date.now() } = {}) {
    this.file = path.join(dataDir, 'auth.json');
    this.now = now;
    this.sessions = new Map();
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.write({
        version: 1,
        username: validateAdminUsername(username || 'admin'),
        passwordHash: hashPassword(String(password || 'admin')),
        updatedAt: new Date(this.now()).toISOString()
      });
    }
    this.credentials = this.read();
  }

  read() {
    const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    validateAdminUsername(value.username);
    if (!decodePasswordHash(value.passwordHash)) throw new Error('管理员凭据文件无效');
    return value;
  }

  write(value) {
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  get username() {
    return this.credentials.username;
  }

  verify(username, password) {
    return safeEqual(username, this.credentials.username) && verifyPassword(String(password || ''), this.credentials.passwordHash);
  }

  createSession() {
    this.prune();
    const token = crypto.randomBytes(32).toString('base64url');
    const session = {
      csrf: crypto.randomBytes(24).toString('base64url'),
      username: this.credentials.username,
      expiresAt: this.now() + SESSION_TTL_MS
    };
    this.sessions.set(sessionKey(token), session);
    return { token, ...session };
  }

  getSession(token) {
    if (!token) return null;
    const key = sessionKey(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  revoke(token) {
    if (token) this.sessions.delete(sessionKey(token));
  }

  revokeAll() {
    this.sessions.clear();
  }

  updateCredentials({ currentPassword, username, newPassword }) {
    if (!this.verify(this.credentials.username, currentPassword)) throw new Error('当前密码错误');
    const next = {
      version: 1,
      username: validateAdminUsername(username),
      passwordHash: hashPassword(validateNewAdminPassword(newPassword)),
      updatedAt: new Date(this.now()).toISOString()
    };
    this.write(next);
    this.credentials = next;
    this.revokeAll();
    return this.createSession();
  }

  prune() {
    const current = this.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= current) this.sessions.delete(key);
    }
  }
}

export class LoginLimiter {
  constructor({ now = () => Date.now(), maxAttempts = 5, windowMs = 10 * 60 * 1000, lockMs = 15 * 60 * 1000 } = {}) {
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.entries = new Map();
  }

  assertAllowed(key) {
    const entry = this.entries.get(key);
    if (!entry?.lockedUntil || entry.lockedUntil <= this.now()) return;
    const error = new Error(`登录尝试过多，请在 ${Math.ceil((entry.lockedUntil - this.now()) / 60000)} 分钟后重试`);
    error.statusCode = 429;
    throw error;
  }

  failure(key) {
    const current = this.now();
    const existing = this.entries.get(key) || { attempts: [], lockedUntil: 0 };
    existing.attempts = existing.attempts.filter((time) => current - time < this.windowMs);
    existing.attempts.push(current);
    if (existing.attempts.length >= this.maxAttempts) existing.lockedUntil = current + this.lockMs;
    this.entries.set(key, existing);
  }

  success(key) {
    this.entries.delete(key);
  }
}
