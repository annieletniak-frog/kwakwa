'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { loadGoogleApp } = require('./google-mock');

const WEEK = '2026-10-05';
execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-google.js')]);

function setup() {
  const app = loadGoogleApp({ owner: 'lead@example.com' });
  app.doGet();
  app.sheets.get('Команда').appendRow(['anna@example.com', 'Анна', 'райтер']);
  app.sheets.get('Команда').appendRow(['boris@example.com', 'Борис', 'Райтер']);
  return app;
}

const projects = () => [{
  project: 'WL',
  streams: [{ name: 'Регистрация', sections: { done: [{ text: 'Тексты верификации' }], blockers: [], progress: [{ text: 'Письма', due: '18.10' }] } }],
}];

test('Google: листы создаются при первом открытии, владелец становится тимлидом', () => {
  const app = setup();
  assert.ok(app.sheets.get('Отчёты'));
  assert.equal(app.sheets.get('Проекты').get(2, 1), '{brand} Main');
  const me = app.call('lead@example.com', 'GET', '/api/me');
  assert.equal(me.data.user.role, 'lead');
  assert.deepEqual(me.data.projects.slice(0, 2), ['{brand} Main', 'WL']);
});

test('Google: посторонний и пустой адрес не получают доступ', () => {
  const app = setup();
  assert.equal(app.call('stranger@example.com', 'GET', '/api/me').status, 403);
  assert.equal(app.call('', 'GET', '/api/me').status, 401);
});

test('Google: доступ по ролям, правки и комментарии, общий отчёт', () => {
  const app = setup();
  const saved = app.call('anna@example.com', 'PUT', `/api/my-report?week=${WEEK}`, { version: 0, projects: projects() });
  assert.equal(saved.status, 200);
  const report = saved.data.report;

  // Райтер не видит чужое и общий отчёт.
  assert.equal(app.call('boris@example.com', 'GET', `/api/reports/${report.id}`).status, 404);
  assert.deepEqual(app.call('boris@example.com', 'GET', `/api/reports?week=${WEEK}`).data.reports, []);
  assert.equal(app.call('boris@example.com', 'GET', `/api/summary?week=${WEEK}`).status, 403);

  // Тимлид правит и комментирует.
  const edited = JSON.parse(JSON.stringify(report.projects));
  edited[0].streams[0].sections.done[0].text = 'Тексты верификации, шаг 2';
  assert.equal(app.call('lead@example.com', 'PUT', `/api/reports/${report.id}`, { version: report.version, projects: edited }).status, 200);
  const taskId = report.projects[0].streams[0].sections.done[0].id;
  assert.equal(app.call('lead@example.com', 'POST', `/api/reports/${report.id}/comments`, { taskId, text: 'Ок' }).status, 200);

  // Данные лежат в таблице и читаются заново в каждом запросе — как после повторного входа.
  const mine = app.call('anna@example.com', 'GET', `/api/my-report?week=${WEEK}`).data.report;
  assert.equal(mine.projects[0].streams[0].sections.done[0].leadEdit.prevText, 'Тексты верификации');
  assert.equal(mine.comments[0].authorName, 'Тимлид');
  assert.equal(app.call('anna@example.com', 'PUT', `/api/my-report?week=${WEEK}`, { version: 1, projects: projects() }).status, 409);

  const summary = app.call('lead@example.com', 'GET', `/api/summary?week=${WEEK}`).data;
  assert.match(summary.html, /<h3>WL<\/h3>\n<h4>Регистрация<\/h4>/);
  assert.match(summary.text, /Письма \(срок: 18\.10\)/);
  assert.deepEqual(app.call('anna@example.com', 'GET', '/api/weeks').data.weeks, [{ week: WEEK, count: 1 }]);
  assert.equal(app.sheets.get('Отчёты').getLastRow(), 2, 'одна строка на отчёт');
});

test('Google: план на неделю виден только автору', () => {
  const app = setup();
  const r = app.call('anna@example.com', 'PUT', `/api/my-report?week=${WEEK}`, { version: 0, projects: projects(), plan: [{ text: 'Глоссарий', date: '2026-10-06' }] }).data.report;
  assert.equal(r.plan[0].text, 'Глоссарий');
  assert.equal(app.call('lead@example.com', 'GET', `/api/reports/${r.id}`).data.report.plan, undefined);
  assert.doesNotMatch(app.call('lead@example.com', 'GET', `/api/summary?week=${WEEK}`).data.text, /Глоссарий/);
});
