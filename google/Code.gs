// Отчётник — версия для Google Apps Script. Файл собран автоматически (npm run build:google), не редактируйте вручную.

const SECTIONS = ['done', 'blockers', 'progress', 'meetings'];
const SECTION_TITLES = {
  done: 'Завершено',
  blockers: 'Блокеры',
  progress: 'Что в работе',
  meetings: 'Важные встречи и обсуждения',
};
const LIMITS = {
  projects: 20,
  streamsPerProject: 30,
  tasksPerSection: 100,
  taskText: 2000,
  due: 120,
  name: 120,
  comment: 2000,
  commentsPerReport: 1000,
  removedLog: 100,
  planItems: 50,
};
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

class ValidationError extends Error {}


// Понедельник отчётной недели в формате YYYY-MM-DD.
function isWeekId(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value && d.getUTCDay() === 1;
}

function cleanMultiline(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
    .slice(0, max);
}

function cleanLine(value, max) {
  return cleanMultiline(value, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);
}

function takeId(candidate, used) {
  const id = typeof candidate === 'string' && ID_RE.test(candidate) && !used.has(candidate) ? candidate : newId();
  used.add(id);
  return id;
}

// Приводит присланную форму к хранимому виду: обрезает лишнее, выбрасывает пустые пункты,
// проверяет лимиты. Служебные поля (правки тимлида) клиент задать не может.
function sanitizeProjects(input) {
  if (!Array.isArray(input)) throw new ValidationError('Ожидается список проектов');
  if (input.length > LIMITS.projects) throw new ValidationError('Слишком много проектов в одном отчёте');
  const used = new Set();
  return input.map((p) => {
    const project = cleanLine(p && p.project, LIMITS.name);
    const streamsIn = Array.isArray(p && p.streams) ? p.streams : [];
    if (streamsIn.length > LIMITS.streamsPerProject) throw new ValidationError('Слишком много стримов в проекте');
    const streams = streamsIn.map((s) => {
      const sections = {};
      for (const key of SECTIONS) {
        const tasksIn = Array.isArray(s && s.sections && s.sections[key]) ? s.sections[key] : [];
        if (tasksIn.length > LIMITS.tasksPerSection) throw new ValidationError('Слишком много задач в разделе');
        sections[key] = tasksIn
          .map((t) => {
            const task = { id: takeId(t && t.id, used), text: cleanMultiline(t && t.text, LIMITS.taskText) };
            if (key === 'progress') task.due = cleanLine(t && t.due, LIMITS.due);
            return task;
          })
          .filter((t) => t.text);
      }
      return { id: takeId(s && s.id, used), name: cleanLine(s && s.name, LIMITS.name), sections };
    });
    const hasTasks = streams.some((s) => SECTIONS.some((k) => s.sections[k].length));
    if (!project && hasTasks) throw new ValidationError('Выберите проект для каждого заполненного блока');
    return { id: takeId(p && p.id, used), project, streams };
  });
}

function indexTasks(projects) {
  const map = new Map();
  for (const p of projects) {
    for (const s of p.streams) {
      for (const key of SECTIONS) {
        // В отчётах, сохранённых до появления раздела, его может не быть.
        for (const t of s.sections[key] || []) map.set(t.id, { task: t, section: key, project: p.project, stream: s.name });
      }
    }
  }
  return map;
}

// План на неделю: личные задачи райтера для календаря. В общий отчёт не попадают и видны только автору.
function sanitizePlan(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > LIMITS.planItems) throw new ValidationError('Слишком много задач в плане');
  const used = new Set();
  return input
    .map((t) => {
      const date = typeof (t && t.date) === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : '';
      return { id: takeId(t && t.id, used), text: cleanMultiline(t && t.text, LIMITS.taskText), date };
    })
    .filter((t) => t.text);
}

function reportHasTasks(report) {
  return (report.projects || []).some((p) => (p.streams || []).some((s) =>
    SECTIONS.some((k) => ((s.sections && s.sections[k]) || []).length)));
}

// Применяет сохранение к отчёту. Если сохраняет тимлид чужой отчёт — помечаем
// добавленные и изменённые задачи и запоминаем удалённые, чтобы райтер увидел правки.
function applySave(report, projectsInput, editor, options = {}) {
  const now = options.now || new Date().toISOString();
  const projects = sanitizeProjects(projectsInput);
  // План меняет только автор; при сохранении тимлидом он остаётся как был.
  const plan = editor.email === report.author && options.plan !== undefined
    ? sanitizePlan(options.plan)
    : report.plan || [];
  const before = indexTasks(report.projects || []);
  const leadEdit = editor.role === 'lead' && editor.email !== report.author;
  const seen = new Set();

  for (const p of projects) {
    for (const s of p.streams) {
      for (const key of SECTIONS) {
        for (const t of s.sections[key]) {
          seen.add(t.id);
          const prev = before.get(t.id);
          const prevTask = prev && prev.task;
          const changed = !prevTask || prevTask.text !== t.text || (prevTask.due || '') !== (t.due || '');
          if (leadEdit) {
            if (!prevTask) {
              t.leadEdit = { by: editor.email, at: now, added: true };
            } else if (changed) {
              const base = prevTask.leadEdit;
              t.leadEdit = base && base.added
                ? { by: editor.email, at: now, added: true }
                : {
                    by: editor.email,
                    at: now,
                    prevText: base ? base.prevText : prevTask.text,
                    prevDue: base ? base.prevDue : prevTask.due || '',
                  };
            } else if (prevTask.leadEdit) {
              t.leadEdit = prevTask.leadEdit;
            }
          } else if (prevTask && !changed && prevTask.leadEdit) {
            // Райтер не трогал задачу — отметка о правке тимлида остаётся видимой.
            t.leadEdit = prevTask.leadEdit;
          }
        }
      }
    }
  }

  const removedByLead = (report.removedByLead || []).slice();
  if (leadEdit) {
    for (const [id, info] of before) {
      if (seen.has(id)) continue;
      removedByLead.push({
        text: info.task.text,
        section: info.section,
        project: info.project,
        stream: info.stream,
        by: editor.email,
        at: now,
      });
    }
  }

  return {
    ...report,
    projects,
    plan,
    removedByLead: removedByLead.slice(-LIMITS.removedLog),
    version: (report.version || 0) + 1,
    updatedAt: now,
    updatedBy: editor.email,
  };
}

function findTask(report, taskId) {
  const hit = indexTasks(report.projects || []).get(taskId);
  return hit ? hit.task : null;
}

function cleanComment(text) {
  return cleanMultiline(text, LIMITS.comment);
}

// ---------- Общий отчёт ----------

function streamKey(name) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function taskLine(task, section) {
  const text = task.text.trim();
  if (section === 'progress' && task.due && task.due.trim()) return `${text} (срок: ${task.due.trim()})`;
  return text;
}

// Объединяет отчёты недели по проектам и стримам. Пустые разделы, стримы и проекты не выводятся.
function buildSummary(reports, projectOrder = []) {
  const projects = new Map();
  for (const report of reports) {
    for (const p of report.projects || []) {
      const projectName = (p.project || '').trim();
      if (!projectName) continue;
      if (!projects.has(projectName)) projects.set(projectName, new Map());
      const streams = projects.get(projectName);
      for (const s of p.streams || []) {
        const key = streamKey(s.name || '');
        if (!streams.has(key)) {
          streams.set(key, { name: (s.name || '').trim(), ...Object.fromEntries(SECTIONS.map((k) => [k, []])) });
        }
        const target = streams.get(key);
        for (const section of SECTIONS) {
          for (const t of (s.sections && s.sections[section]) || []) {
            if (t.text && t.text.trim()) target[section].push(taskLine(t, section));
          }
        }
      }
    }
  }

  const order = (name) => {
    const i = projectOrder.indexOf(name);
    return i === -1 ? projectOrder.length : i;
  };
  return [...projects.entries()]
    .map(([project, streams]) => ({
      project,
      streams: [...streams.values()].filter((s) => SECTIONS.some((k) => s[k].length)),
    }))
    .filter((p) => p.streams.length)
    .sort((a, b) => order(a.project) - order(b.project) || a.project.localeCompare(b.project, 'ru'));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SUMMARY_TITLE = '🔹 UX Writers';

// HTML для вставки в Confluence: заголовки проектов и стримов, подзаголовки разделов, маркированные списки.
function summaryToHtml(tree) {
  const out = [`<h2>${escapeHtml(SUMMARY_TITLE)}</h2>`];
  for (const p of tree) {
    out.push(`<h3>${escapeHtml(p.project)}</h3>`);
    for (const s of p.streams) {
      if (s.name) out.push(`<h4>${escapeHtml(s.name)}</h4>`);
      for (const key of SECTIONS) {
        if (!s[key].length) continue;
        out.push(`<p><strong>${SECTION_TITLES[key]}</strong></p>`);
        out.push(`<ul>${s[key].map((line) => `<li>${escapeHtml(line).replace(/\n/g, '<br>')}</li>`).join('')}</ul>`);
      }
    }
  }
  return out.join('\n');
}

function summaryToText(tree) {
  const out = [SUMMARY_TITLE];
  for (const p of tree) {
    out.push('', p.project);
    for (const s of p.streams) {
      const indent = s.name ? '    ' : '  ';
      if (s.name) out.push(`  ${s.name}`);
      for (const key of SECTIONS) {
        if (!s[key].length) continue;
        out.push(`${indent}${SECTION_TITLES[key]}`);
        for (const line of s[key]) out.push(`${indent}  • ${line.replace(/\n/g, `\n${indent}    `)}`);
      }
    }
  }
  return out.join('\n');
}

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
  if (p === '/api/me' && method === 'GET') return { user, projects: team_().projects };

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
        return Object.assign({}, m, { reportId: r ? r.id : null, updatedAt: r ? r.updatedAt : null });
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
