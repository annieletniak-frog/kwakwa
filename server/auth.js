'use strict';

const crypto = require('node:crypto');

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_MS = 60 * 1000;
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Простой счётчик попыток в скользящем окне — защита от перебора кодов и спама письмами.
class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  take(key, now = Date.now()) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

class Auth {
  constructor({ sessions, team, sendCode }) {
    this.sessions = sessions; // JsonStore { sessions: { [tokenHash]: { email, createdAt, expiresAt } } }
    this.team = team;
    this.sendCode = sendCode;
    this.codes = new Map(); // email -> { hash, expiresAt, attempts, sentAt }
    this.requestsByIp = new RateLimiter(20, 15 * 60 * 1000);
    this.requestsByEmail = new RateLimiter(5, 60 * 60 * 1000);
    this.verifyByIp = new RateLimiter(30, 15 * 60 * 1000);
    this.pruneSessions();
  }

  // Ответ одинаковый для адресов из списка и вне его, чтобы по форме входа
  // нельзя было узнать состав команды.
  async requestCode(email, ip) {
    if (!this.requestsByIp.take(ip)) return { error: 'rate' };
    const user = this.team.findUser(email);
    if (!user) return { ok: true };
    const now = Date.now();
    const existing = this.codes.get(user.email);
    // Повторная отправка не чаще раза в минуту; ответ тот же, что и для чужих адресов.
    if (existing && now - existing.sentAt < CODE_RESEND_MS) return { ok: true };
    if (!this.requestsByEmail.take(user.email, now)) return { ok: true };
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.codes.set(user.email, {
      hash: sha256(`${user.email}:${code}`),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      sentAt: now,
    });
    await this.sendCode(user, code);
    return { ok: true };
  }

  verifyCode(email, code, ip) {
    if (!this.verifyByIp.take(ip)) return { error: 'rate' };
    const user = this.team.findUser(email);
    const entry = user && this.codes.get(user.email);
    if (!entry || Date.now() > entry.expiresAt) return { error: 'invalid' };
    entry.attempts += 1;
    if (entry.attempts > CODE_MAX_ATTEMPTS) {
      this.codes.delete(user.email);
      return { error: 'invalid' };
    }
    const candidate = sha256(`${user.email}:${String(code || '').trim()}`);
    if (!safeEqualHex(candidate, entry.hash)) return { error: 'invalid' };
    this.codes.delete(user.email);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.data.sessions[sha256(token)] = {
      email: user.email,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.save();
    return { token, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
  }

  // Роль всегда берём из актуального состава команды, а не из сессии.
  userForToken(token) {
    if (!token) return null;
    const key = sha256(token);
    const session = this.sessions.data.sessions[key];
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      delete this.sessions.data.sessions[key];
      this.sessions.save();
      return null;
    }
    return this.team.findUser(session.email);
  }

  logout(token) {
    if (!token) return;
    const key = sha256(token);
    if (this.sessions.data.sessions[key]) {
      delete this.sessions.data.sessions[key];
      this.sessions.save();
    }
  }

  pruneSessions() {
    const now = Date.now();
    let changed = false;
    for (const [key, s] of Object.entries(this.sessions.data.sessions)) {
      if (now > s.expiresAt) {
        delete this.sessions.data.sessions[key];
        changed = true;
      }
    }
    if (changed) this.sessions.save();
  }
}

module.exports = { Auth, RateLimiter };
