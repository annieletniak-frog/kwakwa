// ---------- Google Apps Script: хранение в Google Таблице и обработка запросов ----------
// Приложение разворачивается как веб-приложение «от имени владельца», доступное только сотрудникам домена.
// Google сам проверяет вход, а скрипт сверяет адрес с листом «Команда» и выдаёт роль.

const SHEET_TEAM = 'Команда';
const SHEET_PROJECTS = 'Проекты';
const SHEET_REPORTS = 'Отчёты';
const DEFAULT_PROJECTS = ['{brand} Main', 'WL', 'Side Project', 'W.tv', 'CDP', 'Landings'];
const ROLE_ALIASES = { 'тимлид': 'lead', lead: 'lead', 'райтер': 'writer', writer: 'writer' };
const MAX_CELL = 49000;

// Публичная, но безвредная: нужна общей логике отчётов (takeId).
function newId() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 18);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function doGet() {
  ensureSheets_();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Отчётник')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function book_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

// Создаёт недостающие листы при первом открытии, чтобы ничего не настраивать вручную.
function ensureSheets_() {
  const ss = book_();
  if (!ss.getSheetByName(SHEET_TEAM)) {
    const sh = ss.insertSheet(SHEET_TEAM);
    const owner = Session.getEffectiveUser().getEmail();
    sh.getRange(1, 1, 1, 3).setValues([['Почта', 'Имя', 'Роль (райтер или тимлид)']]).setFontWeight('bold');
    sh.getRange(2, 1, 1, 3).setValues([[owner, 'Тимлид', 'тимлид']]);
    sh.setColumnWidth(1, 260);
    sh.setColumnWidth(2, 220);
    sh.setColumnWidth(3, 200);
    sh.setFrozenRows(1);
  }
  if (!ss.getSheetByName(SHEET_PROJECTS)) {
    const sh = ss.insertSheet(SHEET_PROJECTS);
    sh.getRange(1, 1).setValue('Проект').setFontWeight('bold');
    sh.getRange(2, 1, DEFAULT_PROJECTS.length, 1).setValues(DEFAULT_PROJECTS.map((p) => [p]));
    sh.setFrozenRows(1);
  }
  if (!ss.getSheetByName(SHEET_REPORTS)) {
    const sh = ss.insertSheet(SHEET_REPORTS);
    sh.getRange(1, 1, 1, 5).setValues([['ID', 'Неделя', 'Автор', 'Обновлён', 'Данные (не редактировать)']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  ensureSettingsSheet_();
}

function sheetRows_(name) {
  const sh = book_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
}

let teamCache = null;
function team_() {
  if (teamCache) return teamCache;
  const users = [];
  const seen = new Set();
  for (const row of sheetRows_(SHEET_TEAM)) {
    const email = String(row[0] || '').trim().toLowerCase();
    const role = ROLE_ALIASES[String(row[2] || '').trim().toLowerCase()];
    if (!email || !role || seen.has(email)) continue;
    seen.add(email);
    users.push({ email, name: String(row[1] || '').trim() || email, role });
  }
  const projects = sheetRows_(SHEET_PROJECTS).map((r) => String(r[0] || '').trim()).filter(Boolean);
  teamCache = { users, projects: projects.length ? projects : DEFAULT_PROJECTS };
  return teamCache;
}

function findUser_(email) {
  return team_().users.find((u) => u.email === email) || null;
}

function nameOf_(email) {
  const u = findUser_(email);
  return u ? u.name : email;
}

// ---------- Хранилище: одна строка листа «Отчёты» на отчёт ----------

let reportsCache = null;
function loadReports_() {
  if (reportsCache) return reportsCache;
  reportsCache = new Map();
  sheetRows_(SHEET_REPORTS).forEach((row, i) => {
    if (!row[4]) return;
    try {
      reportsCache.set(String(row[0]), { report: JSON.parse(row[4]), row: i + 2 });
    } catch (e) {
      console.error(`Строка ${i + 2} листа «Отчёты» повреждена: ${e}`);
    }
  });
  return reportsCache;
}

function allReports_() {
  return [...loadReports_().values()].map((x) => x.report);
}

function writeReport_(report) {
  const json = JSON.stringify(report);
  if (json.length > MAX_CELL) throw new HttpError(400, 'Отчёт слишком большой. Сократите текст или удалите лишние комментарии.');
  const sh = book_().getSheetByName(SHEET_REPORTS);
  const values = [[report.id, report.week, report.author, report.updatedAt, json]];
  const existing = loadReports_().get(report.id);
  if (existing) {
    sh.getRange(existing.row, 1, 1, 5).setValues(values);
  } else {
    sh.appendRow(values[0]);
    loadReports_().set(report.id, { report, row: sh.getLastRow() });
  }
  loadReports_().get(report.id).report = report;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    reportsCache = null; // перечитываем данные под блокировкой, чтобы не затереть чужое сохранение
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------- Обработка запросов ----------

function currentUser_() {
  const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) {
    throw new HttpError(401, 'Google не сообщил ваш адрес. Откройте приложение под рабочим Google-аккаунтом.');
  }
  const user = findUser_(email);
  if (!user) throw new HttpError(403, `У адреса ${email} нет доступа к Отчётнику.`);
  return user;
}

function canSee_(user, report) {
  return user.role === 'lead' || report.author === user.email;
}

// План на неделю личный: его получает только автор отчёта.
function present_(report, viewer) {
  return Object.assign({}, report, {
    plan: viewer && viewer.email === report.author ? report.plan || [] : undefined,
    authorName: nameOf_(report.author),
    updatedByName: report.updatedBy ? nameOf_(report.updatedBy) : null,
    comments: (report.comments || []).map((c) => Object.assign({}, c, { authorName: nameOf_(c.author) })),
    removedByLead: (report.removedByLead || []).map((r) => Object.assign({}, r, { byName: nameOf_(r.by) })),
  });
}

function getVisible_(user, id) {
  const hit = loadReports_().get(id);
  if (!hit || !canSee_(user, hit.report)) throw new HttpError(404, 'Отчёт не найден');
  return hit.report;
}

function requireWeek_(value) {
  if (!isWeekId(value)) throw new HttpError(400, 'Неделя указывается датой понедельника: YYYY-MM-DD');
  return value;
}

function weekReportsSorted_(week) {
  const order = team_().users.map((m) => m.email);
  const pos = (email) => (order.indexOf(email) === -1 ? order.length : order.indexOf(email));
  return allReports_()
    .filter((r) => r.week === week)
    .sort((a, b) => pos(a.author) - pos(b.author) || a.author.localeCompare(b.author));
}

function saveReport_(report, input, user) {
  if (!input || typeof input.version !== 'number' || input.version !== (report.version || 0)) {
    throw new HttpError(409, 'Отчёт уже изменили в другом окне или это сделал тимлид. Загрузите актуальную версию.');
  }
  let updated;
  try {
    updated = applySave(report, input.projects, user, { plan: input.plan });
  } catch (err) {
    if (err instanceof ValidationError) throw new HttpError(400, err.message);
    throw err;
  }
  writeReport_(updated);
  return updated;
}

function parseUrl_(url) {
  const [path, query] = String(url).split('?');
  const params = {};
  for (const part of (query || '').split('&')) {
    if (!part) continue;
    const [k, v] = part.split('=');
    params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return { path, params };
}

// Единая точка входа для интерфейса: google.script.run.api(method, url, body).
function api(method, url, body) {
  teamCache = null;
  reportsCache = null;
  try {
    return { status: 200, data: route_(method, url, body || {}) };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, error: err.message };
    console.error(err && err.stack ? err.stack : err);
    return { status: 500, error: 'Ошибка сервера. Попробуйте ещё раз.' };
  }
}

function route_(method, url, body) {
  const { path: p, params } = parseUrl_(url);
  const user = currentUser_();

  if (p === '/api/config') return { devMail: false };
  if (p === '/api/me' && method === 'GET') return { user, projects: team_().projects, slack: slackConfigured_() };

  if (p === '/api/weeks' && method === 'GET') {
    const weeks = new Map();
    for (const r of allReports_()) if (canSee_(user, r)) weeks.set(r.week, (weeks.get(r.week) || 0) + 1);
    return {
      weeks: [...weeks.entries()].map(([week, count]) => ({ week, count })).sort((a, b) => b.week.localeCompare(a.week)),
    };
  }

  if (p === '/api/reports' && method === 'GET') {
    const week = requireWeek_(params.week);
    const reports = weekReportsSorted_(week).filter((r) => canSee_(user, r)).map((r) => present_(r, user));
    const out = { week, reports };
    if (user.role === 'lead') {
      out.team = team_().users.map((m) => {
        // Отчёт с одним только планом не считается заполненным.
        const r = reports.find((x) => x.author === m.email && reportHasTasks(x));
        return Object.assign({}, m, {
          reportId: r ? r.id : null,
          updatedAt: r ? r.updatedAt : null,
          notifiedAt: r && r.reviewNotified ? r.reviewNotified.at : null,
        });
      });
    }
    return out;
  }

  if (p === '/api/my-report') {
    const week = requireWeek_(params.week);
    const find = () => allReports_().find((r) => r.author === user.email && r.week === week) || null;
    if (method === 'GET') {
      const existing = find();
      return { report: existing ? present_(existing, user) : null };
    }
    if (method === 'PUT') {
      return withLock_(() => {
        const now = new Date().toISOString();
        const base = find() || {
          id: newId(), week, author: user.email, createdAt: now, version: 0, projects: [], comments: [], removedByLead: [],
        };
        return { report: present_(saveReport_(base, body, user), user) };
      });
    }
  }

  if (p === '/api/summary' && method === 'GET') {
    if (user.role !== 'lead') throw new HttpError(403, 'Доступно только тимлиду');
    const week = requireWeek_(params.week);
    const reports = weekReportsSorted_(week);
    const tree = buildSummary(reports, team_().projects);
    return {
      week,
      reportCount: reports.length,
      tree,
      html: tree.length ? summaryToHtml(tree) : '',
      text: tree.length ? summaryToText(tree) : '',
    };
  }

  let m = p.match(/^\/api\/reports\/([A-Za-z0-9_-]+)$/);
  if (m) {
    if (method === 'GET') return { report: present_(getVisible_(user, m[1]), user) };
    if (method === 'PUT') return withLock_(() => ({ report: present_(saveReport_(getVisible_(user, m[1]), body, user), user) }));
  }

  m = p.match(/^\/api\/reports\/([A-Za-z0-9_-]+)\/comments$/);
  if (m && method === 'POST') {
    return withLock_(() => {
      const report = getVisible_(user, m[1]);
      const task = findTask(report, body.taskId);
      if (!task) throw new HttpError(400, 'Задача не найдена — сохраните отчёт и попробуйте снова');
      const text = cleanComment(body.text);
      if (!text) throw new HttpError(400, 'Комментарий пустой');
      report.comments = report.comments || [];
      if (report.comments.length >= LIMITS.commentsPerReport) throw new HttpError(400, 'Слишком много комментариев');
      report.comments.push({
        id: newId(), taskId: task.id, taskText: task.text.slice(0, 300), author: user.email, text, createdAt: new Date().toISOString(),
      });
      writeReport_(report);
      return { report: present_(report, user) };
    });
  }

  m = p.match(/^\/api\/reports\/([A-Za-z0-9_-]+)\/notify$/);
  if (m && method === 'POST') {
    if (user.role !== 'lead') throw new HttpError(403, 'Доступно только тимлиду');
    if (!slackConfigured_()) throw new HttpError(400, 'Slack не настроен: на листе «Настройки» нет токена бота');
    const report = getVisible_(user, m[1]);
    const result = notifyWriter_(report, user);
    return withLock_(() => {
      const fresh = getVisible_(user, m[1]);
      fresh.reviewNotified = { at: result.at, by: result.by };
      writeReport_(fresh);
      return { report: present_(fresh, user), warnings: result.warnings };
    });
  }

  m = p.match(/^\/api\/reports\/([A-Za-z0-9_-]+)\/comments\/([A-Za-z0-9_-]+)$/);
  if (m && method === 'DELETE') {
    return withLock_(() => {
      const report = getVisible_(user, m[1]);
      const comment = (report.comments || []).find((c) => c.id === m[2]);
      if (!comment) throw new HttpError(404, 'Комментарий не найден');
      if (comment.author !== user.email) throw new HttpError(403, 'Удалить можно только свой комментарий');
      report.comments = report.comments.filter((c) => c.id !== m[2]);
      writeReport_(report);
      return { report: present_(report, user) };
    });
  }

  throw new HttpError(404, 'Не найдено');
}
