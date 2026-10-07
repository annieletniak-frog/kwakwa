'use strict';

const fs = require('node:fs');

const DEFAULT_PROJECTS = ['{brand} Main', 'WL', 'Side Project', 'W.tv', 'CDP', 'Landings'];
// Роль дизайнера зарезервирована на будущее: в этой версии такие записи не получают доступа.
const ROLES = new Set(['writer', 'lead']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseTeam(raw, file) {
  if (!raw || !Array.isArray(raw.users)) {
    throw new Error(`${file}: ожидается объект с массивом "users"`);
  }
  const users = new Map();
  for (const entry of raw.users) {
    const email = normalizeEmail(entry && entry.email);
    if (!EMAIL_RE.test(email)) throw new Error(`${file}: некорректный адрес "${entry && entry.email}"`);
    if (!ROLES.has(entry.role)) {
      console.warn(`[team] ${email}: роль "${entry.role}" не поддерживается в этой версии — доступ не выдан`);
      continue;
    }
    if (users.has(email)) throw new Error(`${file}: адрес ${email} указан дважды`);
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : email;
    users.set(email, { email, name, role: entry.role });
  }
  const projects = Array.isArray(raw.projects) && raw.projects.length
    ? raw.projects.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
    : DEFAULT_PROJECTS;
  const allowedDomains = Array.isArray(raw.allowedDomains)
    ? raw.allowedDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
    : [];
  return { users, projects, allowedDomains };
}

// Состав команды перечитывается при изменении файла: удалённый из списка
// человек теряет доступ сразу, без перезапуска сервера.
class Team {
  constructor(file) {
    this.file = file;
    this.mtime = 0;
    this.current = null;
    this.reload();
  }

  reload() {
    const stat = fs.statSync(this.file);
    if (this.current && stat.mtimeMs === this.mtime) return;
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.current = parseTeam(raw, this.file);
    this.mtime = stat.mtimeMs;
  }

  get() {
    try {
      this.reload();
    } catch (err) {
      // Если файл сломали при редактировании, работаем на последней корректной версии.
      if (!this.current) throw err;
      console.error(`[team] не удалось перечитать ${this.file}: ${err.message}`);
    }
    return this.current;
  }

  findUser(email) {
    const team = this.get();
    const normalized = normalizeEmail(email);
    const user = team.users.get(normalized);
    if (!user) return null;
    if (team.allowedDomains.length) {
      const domain = normalized.split('@')[1];
      if (!team.allowedDomains.includes(domain)) return null;
    }
    return user;
  }

  members() {
    return [...this.get().users.values()];
  }

  projects() {
    return this.get().projects;
  }
}

module.exports = { Team, normalizeEmail, DEFAULT_PROJECTS, EMAIL_RE };
