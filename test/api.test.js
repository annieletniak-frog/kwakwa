'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server/app');

const WEEK = '2026-10-05';
const TEAM = {
  allowedDomains: ['example.com'],
  users: [
    { email: 'lead@example.com', name: 'Тимлид', role: 'lead' },
    { email: 'anna@example.com', name: 'Анна', role: 'writer' },
    { email: 'boris@example.com', name: 'Борис', role: 'writer' },
    { email: 'des@example.com', name: 'Дизайнер', role: 'designer' },
  ],
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otchetnik-'));
  const teamFile = path.join(dir, 'team.json');
  fs.writeFileSync(teamFile, JSON.stringify(TEAM));
  const codes = new Map();
  const start = () => {
    const app = createApp({
      dataDir: path.join(dir, 'data'),
      teamFile,
      mailMode: 'console',
      sendCode: async (user, code) => codes.set(user.email, code),
    });
    const server = app.server();
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      resolve({ app, server, base: `http://127.0.0.1:${server.address().port}` });
    }));
  };
  return { dir, teamFile, codes, start };
}

function client(base) {
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    return { status: res.status, data, headers: res.headers };
  }
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

async function login(env, base, email) {
  const c = client(base);
  const r = await c.call('POST', '/api/auth/request', { email });
  assert.equal(r.status, 200);
  const v = await c.call('POST', '/api/auth/verify', { email, code: env.codes.get(email) });
  assert.equal(v.status, 200, `login ${email}`);
  return c;
}

const sampleProjects = (text = 'Тексты онбординга') => [
  {
    project: '{brand} Main',
    streams: [{
      name: 'Покер',
      sections: {
        done: [{ text }, { text: '   ' }],
        blockers: [],
        progress: [{ text: 'Микрокопи кэш-игр', due: '15.10' }],
      },
    }],
  },
];

test('вход: код получает только участник команды, неверный код не пускает', async () => {
  const env = setup();
  const { server, base } = await env.start();
  try {
    const c = client(base);
    assert.equal((await c.call('GET', '/api/me')).status, 401);

    const stranger = await c.call('POST', '/api/auth/request', { email: 'someone@example.com' });
    assert.equal(stranger.status, 200, 'ответ не раскрывает, есть ли адрес в списке');
    assert.equal(env.codes.has('someone@example.com'), false);

    await c.call('POST', '/api/auth/request', { email: 'des@example.com' });
    assert.equal(env.codes.has('des@example.com'), false, 'роль дизайнера пока без доступа');

    await c.call('POST', '/api/auth/request', { email: 'Anna@Example.com ' });
    const code = env.codes.get('anna@example.com');
    assert.match(code, /^\d{6}$/);
    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await c.call('POST', '/api/auth/verify', { email: 'anna@example.com', code: wrong })).status, 401);

    const ok = await c.call('POST', '/api/auth/verify', { email: 'anna@example.com', code });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
    assert.match(ok.headers.get('set-cookie'), /SameSite=Strict/);
    const me = await c.call('GET', '/api/me');
    assert.equal(me.data.user.role, 'writer');

    assert.equal((await c.call('POST', '/api/auth/verify', { email: 'anna@example.com', code })).status, 401, 'код одноразовый');
  } finally {
    server.close();
  }
});

test('код блокируется после 5 неверных попыток', async () => {
  const env = setup();
  const { server, base } = await env.start();
  try {
    const c = client(base);
    await c.call('POST', '/api/auth/request', { email: 'anna@example.com' });
    const code = env.codes.get('anna@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await c.call('POST', '/api/auth/verify', { email: 'anna@example.com', code: wrong });
    assert.equal((await c.call('POST', '/api/auth/verify', { email: 'anna@example.com', code })).status, 401);
  } finally {
    server.close();
  }
});

test('изменяющие запросы требуют JSON и свой origin', async () => {
  const env = setup();
  const { server, base } = await env.start();
  try {
    const anna = await login(env, base, 'anna@example.com');
    const foreign = await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: 0, projects: [] }, { Origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
    const res = await fetch(`${base}/api/my-report?week=${WEEK}`, {
      method: 'PUT',
      headers: { Cookie: anna.cookie, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(res.status, 415);
  } finally {
    server.close();
  }
});

test('райтер видит только свои отчёты, общий отчёт — только тимлиду', async () => {
  const env = setup();
  const { server, base } = await env.start();
  try {
    const anna = await login(env, base, 'anna@example.com');
    const boris = await login(env, base, 'boris@example.com');
    const lead = await login(env, base, 'lead@example.com');

    const saved = await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: 0, projects: sampleProjects() });
    assert.equal(saved.status, 200);
    const id = saved.data.report.id;
    assert.equal(saved.data.report.projects[0].streams[0].sections.done.length, 1, 'пустые пункты отброшены');

    assert.equal((await boris.call('GET', `/api/reports/${id}`)).status, 404);
    assert.equal((await boris.call('PUT', `/api/reports/${id}`, { version: 1, projects: [] })).status, 404);
    assert.equal((await boris.call('POST', `/api/reports/${id}/comments`, { taskId: 'x', text: 'hi' })).status, 404);
    assert.deepEqual((await boris.call('GET', `/api/reports?week=${WEEK}`)).data.reports, []);
    assert.equal((await boris.call('GET', `/api/summary?week=${WEEK}`)).status, 403);
    assert.deepEqual((await boris.call('GET', '/api/weeks')).data.weeks, []);

    const all = await lead.call('GET', `/api/reports?week=${WEEK}`);
    assert.equal(all.data.reports.length, 1);
    assert.equal(all.data.team.find((m) => m.email === 'anna@example.com').reportId, id);
    assert.equal(all.data.team.find((m) => m.email === 'boris@example.com').reportId, null);
  } finally {
    server.close();
  }
});

test('правки и комментарии тимлида видны райтеру; конфликт версий', async () => {
  const env = setup();
  const { server, base } = await env.start();
  try {
    const anna = await login(env, base, 'anna@example.com');
    const lead = await login(env, base, 'lead@example.com');

    const first = (await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: 0, projects: sampleProjects() })).data.report;
    const doneTask = first.projects[0].streams[0].sections.done[0];
    const progressTask = first.projects[0].streams[0].sections.progress[0];

    const edited = JSON.parse(JSON.stringify(first.projects));
    edited[0].streams[0].sections.done[0].text = 'Тексты онбординга турнирного лобби';
    edited[0].streams[0].sections.blockers.push({ text: 'Ждём решения по бонусам' });
    edited[0].streams[0].sections.progress = [];
    const leadSave = await lead.call('PUT', `/api/reports/${first.id}`, { version: first.version, projects: edited });
    assert.equal(leadSave.status, 200);

    const comment = await lead.call('POST', `/api/reports/${first.id}/comments`, { taskId: doneTask.id, text: 'Добавь ссылку на макет' });
    assert.equal(comment.status, 200);

    const mine = (await anna.call('GET', `/api/my-report?week=${WEEK}`)).data.report;
    const s = mine.projects[0].streams[0].sections;
    assert.equal(s.done[0].leadEdit.prevText, 'Тексты онбординга');
    assert.equal(s.blockers[0].leadEdit.added, true);
    assert.equal(mine.removedByLead[0].text, progressTask.text);
    assert.equal(mine.comments[0].text, 'Добавь ссылку на макет');
    assert.equal(mine.comments[0].authorName, 'Тимлид');

    const stale = await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: first.version, projects: sampleProjects('x') });
    assert.equal(stale.status, 409);

    // Райтер сохраняет, не трогая задачу: отметка о правке остаётся. Переписал — отметка снимается.
    const keep = await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: mine.version, projects: mine.projects });
    assert.ok(keep.data.report.projects[0].streams[0].sections.done[0].leadEdit);
    const rewritten = JSON.parse(JSON.stringify(keep.data.report.projects));
    rewritten[0].streams[0].sections.done[0].text = 'Своя формулировка';
    const after = await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: keep.data.report.version, projects: rewritten });
    assert.equal(after.data.report.projects[0].streams[0].sections.done[0].leadEdit, undefined);
    assert.equal(after.data.report.comments.length, 1, 'комментарии не затираются сохранением');

    // Удалить чужой комментарий нельзя, свой — можно.
    const cid = after.data.report.comments[0].id;
    assert.equal((await anna.call('DELETE', `/api/reports/${first.id}/comments/${cid}`)).status, 403);
    assert.equal((await lead.call('DELETE', `/api/reports/${first.id}/comments/${cid}`)).status, 200);
  } finally {
    server.close();
  }
});

test('после перезапуска отчёты, правки, комментарии и сессии сохраняются', async () => {
  const env = setup();
  let { server, base } = await env.start();
  const anna = await login(env, base, 'anna@example.com');
  const saved = (await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: 0, projects: sampleProjects() })).data.report;
  const taskId = saved.projects[0].streams[0].sections.done[0].id;
  await anna.call('POST', `/api/reports/${saved.id}/comments`, { taskId, text: 'Заметка' });
  server.close();

  ({ server, base } = await env.start());
  try {
    const again = client(base);
    again.cookie = anna.cookie;
    const mine = await again.call('GET', `/api/my-report?week=${WEEK}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.data.report.comments[0].text, 'Заметка');
    const weeks = await again.call('GET', '/api/weeks');
    assert.deepEqual(weeks.data.weeks, [{ week: WEEK, count: 1 }]);
  } finally {
    server.close();
  }
});

test('удаление из списка команды сразу закрывает доступ', async () => {
  const env = setup();
  const { server, base } = await env.start();
  try {
    const boris = await login(env, base, 'boris@example.com');
    assert.equal((await boris.call('GET', '/api/me')).status, 200);
    const team = { ...TEAM, users: TEAM.users.filter((u) => u.email !== 'boris@example.com') };
    fs.writeFileSync(env.teamFile, JSON.stringify(team));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(env.teamFile, future, future);
    assert.equal((await boris.call('GET', '/api/me')).status, 401);
  } finally {
    server.close();
  }
});

test('неделя проверяется, статика отдаётся с защитными заголовками', async () => {
  const env = setup();
  const { server, base } = await env.start();
  try {
    const anna = await login(env, base, 'anna@example.com');
    assert.equal((await anna.call('GET', '/api/my-report?week=2026-10-07')).status, 400);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(page.headers.get('x-robots-tag'), /noindex/);
    assert.equal((await fetch(`${base}/..%2fserver%2fapp.js`)).status, 404);
  } finally {
    server.close();
  }
});

test('план на неделю: виден только автору, не попадает в общий отчёт, переживает правки тимлида', async () => {
  const env = setup();
  const { server, base } = await env.start();
  try {
    const anna = await login(env, base, 'anna@example.com');
    const lead = await login(env, base, 'lead@example.com');
    const plan = [{ text: 'Подготовить глоссарий', date: '2026-10-07' }, { text: '  ' }, { text: 'Созвон', date: 'не дата' }];

    // Только план, без задач отчёта: тимлиду отчёт не засчитывается как заполненный.
    const onlyPlan = await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: 0, projects: [], plan });
    assert.equal(onlyPlan.status, 200);
    assert.deepEqual(onlyPlan.data.report.plan.map((t) => [t.text, t.date]), [['Подготовить глоссарий', '2026-10-07'], ['Созвон', '']]);
    const team = (await lead.call('GET', `/api/reports?week=${WEEK}`)).data.team;
    assert.equal(team.find((m) => m.email === 'anna@example.com').reportId, null);

    const saved = (await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: 1, projects: sampleProjects(), plan: onlyPlan.data.report.plan })).data.report;
    const leadView = (await lead.call('GET', `/api/reports/${saved.id}`)).data.report;
    assert.equal(leadView.plan, undefined, 'тимлид план не видит');

    const leadSave = await lead.call('PUT', `/api/reports/${saved.id}`, { version: saved.version, projects: leadView.projects, plan: [] });
    assert.equal(leadSave.status, 200);
    const mine = (await anna.call('GET', `/api/my-report?week=${WEEK}`)).data.report;
    assert.equal(mine.plan.length, 2, 'тимлид не может изменить или стереть план');

    const summary = (await lead.call('GET', `/api/summary?week=${WEEK}`)).data;
    assert.doesNotMatch(summary.text, /глоссарий|Созвон/);
  } finally {
    server.close();
  }
});

test('при удалении задачи её комментарии исчезают', async () => {
  const env = setup();
  const { server, base } = await env.start();
  try {
    const anna = await login(env, base, 'anna@example.com');
    const lead = await login(env, base, 'lead@example.com');
    const report = (await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: 0, projects: sampleProjects() })).data.report;
    const doneTask = report.projects[0].streams[0].sections.done[0];
    const progressTask = report.projects[0].streams[0].sections.progress[0];
    await lead.call('POST', `/api/reports/${report.id}/comments`, { taskId: doneTask.id, text: 'Убрать' });
    await lead.call('POST', `/api/reports/${report.id}/comments`, { taskId: progressTask.id, text: 'Оставить' });

    const projects = JSON.parse(JSON.stringify(report.projects));
    projects[0].streams[0].sections.done = [];
    const saved = (await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: report.version, projects })).data.report;
    assert.deepEqual(saved.comments.map((c) => c.text), ['Оставить']);
    const leadView = (await lead.call('GET', `/api/reports/${report.id}`)).data.report;
    assert.deepEqual(leadView.comments.map((c) => c.text), ['Оставить']);
  } finally {
    server.close();
  }
});

test('комментарии не попадают в общий отчёт', async () => {
  const env = setup();
  const { server, base } = await env.start();
  try {
    const anna = await login(env, base, 'anna@example.com');
    const lead = await login(env, base, 'lead@example.com');
    const report = (await anna.call('PUT', `/api/my-report?week=${WEEK}`, { version: 0, projects: sampleProjects() })).data.report;
    const taskId = report.projects[0].streams[0].sections.done[0].id;
    await lead.call('POST', `/api/reports/${report.id}/comments`, { taskId, text: 'Комментарий тимлида' });
    await anna.call('POST', `/api/reports/${report.id}/comments`, { taskId, text: 'Ответ райтера' });
    const summary = (await lead.call('GET', `/api/summary?week=${WEEK}`)).data;
    assert.match(summary.text, /Тексты онбординга/);
    assert.doesNotMatch(summary.text + summary.html, /Комментарий тимлида|Ответ райтера/);
  } finally {
    server.close();
  }
});
