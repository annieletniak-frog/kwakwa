'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { JsonStore } = require('./store');
const { Team, normalizeEmail } = require('./team');
const { Auth } = require('./auth');
const R = require('./reports');

const MAX_BODY = 512 * 1024;
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // Приложение внутреннее: просим поисковики не индексировать ни одну страницу.
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const teamFile = options.teamFile || path.join(__dirname, '..', 'config', 'team.json');
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');
  const cookieSecure = Boolean(options.cookieSecure);
  const trustProxy = Boolean(options.trustProxy);
  const mailMode = options.mailMode || 'smtp';

  const team = new Team(teamFile);
  const db = new JsonStore(path.join(dataDir, 'reports.json'), { reports: {} });
  const sessions = new JsonStore(path.join(dataDir, 'sessions.json'), { sessions: {} });
  const auth = new Auth({ sessions, team, sendCode: options.sendCode });

  // ---------- helpers ----------

  function send(res, status, body, extraHeaders = {}) {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(JSON.stringify(body));
  }

  function clientIp(req) {
    if (trustProxy && req.headers['x-forwarded-for']) {
      return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function sessionCookie(token, maxAge) {
    const parts = [`sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
    if (cookieSecure) parts.push('Secure');
    return parts.join('; ');
  }

  // Изменяющие запросы принимаем только как JSON и только со своего origin (защита от CSRF
  // в дополнение к SameSite=Strict).
  // DELETE браузерная форма отправить не может, поэтому тело и тип для него не требуем.
  function checkMutation(req) {
    const type = req.headers['content-type'] || '';
    if (req.method !== 'DELETE' && !type.startsWith('application/json')) {
      throw new HttpError(415, 'Ожидается application/json');
    }
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers['x-forwarded-host'] && trustProxy ? req.headers['x-forwarded-host'] : req.headers.host;
      let originHost;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost !== host) throw new HttpError(403, 'Запрос с чужого адреса отклонён');
    }
  }

  function requireUser(req) {
    const user = auth.userForToken(parseCookies(req.headers.cookie).sid);
    if (!user) throw new HttpError(401, 'Нужно войти');
    return user;
  }

  function requireLead(user) {
    if (user.role !== 'lead') throw new HttpError(403, 'Доступно только тимлиду');
  }

  function requireWeek(value) {
    if (!R.isWeekId(value)) throw new HttpError(400, 'Неделя указывается датой понедельника: YYYY-MM-DD');
    return value;
  }

  function allReports() {
    return Object.values(db.data.reports);
  }

  function nameOf(email) {
    const u = team.findUser(email);
    return u ? u.name : email;
  }

  function canSee(user, report) {
    return user.role === 'lead' || report.author === user.email;
  }

  // План на неделю личный: его получает только автор отчёта.
  function present(report, viewer) {
    return {
      ...report,
      plan: viewer && viewer.email === report.author ? report.plan || [] : undefined,
      authorName: nameOf(report.author),
      updatedByName: report.updatedBy ? nameOf(report.updatedBy) : null,
      comments: (report.comments || []).map((c) => ({ ...c, authorName: nameOf(c.author) })),
      removedByLead: (report.removedByLead || []).map((r) => ({ ...r, byName: nameOf(r.by) })),
    };
  }

  function getVisibleReport(user, id) {
    const report = db.data.reports[id];
    // Для чужого отчёта отвечаем так же, как для несуществующего.
    if (!report || !canSee(user, report)) throw new HttpError(404, 'Отчёт не найден');
    return report;
  }

  function findOwnReport(email, week) {
    return allReports().find((r) => r.author === email && r.week === week) || null;
  }

  function weekReportsSorted(week) {
    const order = team.members().map((m) => m.email);
    const pos = (email) => {
      const i = order.indexOf(email);
      return i === -1 ? order.length : i;
    };
    return allReports()
      .filter((r) => r.week === week)
      .sort((a, b) => pos(a.author) - pos(b.author) || a.author.localeCompare(b.author));
  }

  function saveReport(report, input, user) {
    if (typeof input.version !== 'number' || input.version !== (report.version || 0)) {
      throw new HttpError(409, 'Отчёт уже изменили в другом окне или это сделал тимлид. Загрузите актуальную версию.');
    }
    let updated;
    try {
      updated = R.applySave(report, input.projects, user, { plan: input.plan });
    } catch (err) {
      if (err instanceof R.ValidationError) throw new HttpError(400, err.message);
      throw err;
    }
    db.data.reports[updated.id] = updated;
    db.save();
    return updated;
  }

  // ---------- routes ----------

  async function handleApi(req, res, url) {
    const method = req.method;
    const p = url.pathname;
    if (method !== 'GET' && method !== 'HEAD') checkMutation(req);

    if (p === '/api/auth/request' && method === 'POST') {
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      if (!email || email.length > 200) throw new HttpError(400, 'Укажите рабочую почту');
      const result = await auth.requestCode(email, clientIp(req));
      if (result.error === 'rate') throw new HttpError(429, 'Слишком много попыток. Попробуйте позже.');
      return send(res, 200, { ok: true });
    }

    if (p === '/api/auth/verify' && method === 'POST') {
      const body = await readBody(req);
      const result = auth.verifyCode(normalizeEmail(body.email), String(body.code || ''), clientIp(req));
      if (result.error === 'rate') throw new HttpError(429, 'Слишком много попыток. Попробуйте позже.');
      if (result.error) throw new HttpError(401, 'Неверный или устаревший код. Запросите новый.');
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(result.token, result.maxAgeSec) });
    }

    if (p === '/api/auth/logout' && method === 'POST') {
      auth.logout(parseCookies(req.headers.cookie).sid);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    if (p === '/api/config' && method === 'GET') {
      return send(res, 200, { devMail: mailMode === 'console' });
    }

    const user = requireUser(req);

    if (p === '/api/me' && method === 'GET') {
      return send(res, 200, { user, projects: team.projects() });
    }

    if (p === '/api/weeks' && method === 'GET') {
      const weeks = new Map();
      for (const r of allReports()) {
        if (!canSee(user, r)) continue;
        weeks.set(r.week, (weeks.get(r.week) || 0) + 1);
      }
      const list = [...weeks.entries()]
        .map(([week, count]) => ({ week, count }))
        .sort((a, b) => b.week.localeCompare(a.week));
      return send(res, 200, { weeks: list });
    }

    if (p === '/api/reports' && method === 'GET') {
      const week = requireWeek(url.searchParams.get('week'));
      const reports = weekReportsSorted(week).filter((r) => canSee(user, r)).map((r) => present(r, user));
      const body = { week, reports };
      if (user.role === 'lead') {
        body.team = team.members().map((m) => {
          // Отчёт с одним только планом не считается заполненным.
          const r = reports.find((x) => x.author === m.email && R.reportHasTasks(x));
          return { ...m, reportId: r ? r.id : null, updatedAt: r ? r.updatedAt : null };
        });
      }
      return send(res, 200, body);
    }

    if (p === '/api/my-report') {
      const week = requireWeek(url.searchParams.get('week'));
      const existing = findOwnReport(user.email, week);
      if (method === 'GET') return send(res, 200, { report: existing ? present(existing, user) : null });
      if (method === 'PUT') {
        const body = await readBody(req);
        const now = new Date().toISOString();
        const base = existing || {
          id: R.newId(),
          week,
          author: user.email,
          createdAt: now,
          version: 0,
          projects: [],
          comments: [],
          removedByLead: [],
        };
        const saved = saveReport(base, body, user);
        return send(res, 200, { report: present(saved, user) });
      }
    }

    if (p === '/api/summary' && method === 'GET') {
      requireLead(user);
      const week = requireWeek(url.searchParams.get('week'));
      const reports = weekReportsSorted(week);
      const tree = R.buildSummary(reports, team.projects());
      return send(res, 200, {
        week,
        reportCount: reports.length,
        tree,
        html: tree.length ? R.summaryToHtml(tree) : '',
        text: tree.length ? R.summaryToText(tree) : '',
      });
    }

    let m = p.match(/^\/api\/reports\/([A-Za-z0-9_-]+)$/);
    if (m) {
      const report = getVisibleReport(user, m[1]);
      if (method === 'GET') return send(res, 200, { report: present(report, user) });
      if (method === 'PUT') {
        const body = await readBody(req);
        return send(res, 200, { report: present(saveReport(report, body, user), user) });
      }
    }

    m = p.match(/^\/api\/reports\/([A-Za-z0-9_-]+)\/comments$/);
    if (m && method === 'POST') {
      const report = getVisibleReport(user, m[1]);
      const body = await readBody(req);
      const task = R.findTask(report, body.taskId);
      if (!task) throw new HttpError(400, 'Задача не найдена — сохраните отчёт и попробуйте снова');
      const text = R.cleanComment(body.text);
      if (!text) throw new HttpError(400, 'Комментарий пустой');
      report.comments = report.comments || [];
      if (report.comments.length >= R.LIMITS.commentsPerReport) throw new HttpError(400, 'Слишком много комментариев');
      report.comments.push({
        id: R.newId(),
        taskId: task.id,
        taskText: task.text.slice(0, 300),
        author: user.email,
        text,
        createdAt: new Date().toISOString(),
      });
      db.save();
      return send(res, 200, { report: present(report, user) });
    }

    m = p.match(/^\/api\/reports\/([A-Za-z0-9_-]+)\/comments\/([A-Za-z0-9_-]+)$/);
    if (m && method === 'DELETE') {
      const report = getVisibleReport(user, m[1]);
      const comment = (report.comments || []).find((c) => c.id === m[2]);
      if (!comment) throw new HttpError(404, 'Комментарий не найден');
      if (comment.author !== user.email) throw new HttpError(403, 'Удалить можно только свой комментарий');
      report.comments = report.comments.filter((c) => c.id !== m[2]);
      db.save();
      return send(res, 200, { report: present(report, user) });
    }

    throw new HttpError(404, 'Не найдено');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS);
      return res.end();
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    const type = STATIC_TYPES[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      return res.end();
    }
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Ошибка сервера. Попробуйте ещё раз.' });
    }
  }

  return {
    handler,
    server: () => http.createServer(handler),
    team,
    db,
  };
}

module.exports = { createApp };
