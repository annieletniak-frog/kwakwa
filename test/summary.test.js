'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applySave, buildSummary, summaryToHtml, summaryToText, isWeekId } = require('../server/reports');

const order = ['{brand} Main', 'WL', 'Side Project', 'W.tv', 'CDP', 'Landings'];
const task = (text, due) => ({ text, due });
const stream = (name, done = [], blockers = [], progress = []) => ({ name, sections: { done, blockers, progress } });

function report(author, projects) {
  return applySave({ id: author, author, week: '2026-10-05', projects: [] }, projects, { email: author, role: 'writer' });
}

test('общий отчёт объединяет записи по проектам и стримам и скрывает пустое', () => {
  const reports = [
    report('a', [{ project: 'WL', streams: [stream('Регистрация', [task('Флоу верификации')])] }]),
    report('b', [
      { project: '{brand} Main', streams: [stream('Покер', [task('Онбординг')], [], [task('Кэш-игры', '15.10')])] },
      { project: 'CDP', streams: [stream('Пусто', [task('   ')])] },
    ]),
    report('c', [{ project: '{brand} Main', streams: [stream(' покер ', [], [task('Ждём юристов')]), stream('Бонусы', [], [], [task('Пуши')])] }]),
  ];
  const tree = buildSummary(reports, order);

  assert.deepEqual(tree.map((p) => p.project), ['{brand} Main', 'WL'], 'порядок по списку, пустой CDP скрыт');
  const main = tree[0];
  assert.equal(main.streams.length, 2, 'Покер и покер объединены');
  assert.deepEqual(main.streams[0], {
    name: 'Покер',
    done: ['Онбординг'],
    blockers: ['Ждём юристов'],
    progress: ['Кэш-игры (срок: 15.10)'],
    meetings: [],
  });

  const html = summaryToHtml(tree);
  assert.ok(html.startsWith('<h2>🔹 UX Writers</h2>'));
  assert.match(html, /<h3>\{brand\} Main<\/h3>\n<h4>Покер<\/h4>\n<p><strong>Завершено<\/strong><\/p>\n<ul><li>Онбординг<\/li><\/ul>/);
  assert.doesNotMatch(html, /Блокеры<\/strong><\/p>\n<ul><li>Пуши/);
  // В стриме «Бонусы» есть только «Что в работе» — другие заголовки не выводятся.
  const bonus = html.slice(html.indexOf('<h4>Бонусы</h4>'));
  assert.doesNotMatch(bonus.split('<h3>')[0], /Завершено|Блокеры/);

  const text = summaryToText(tree);
  assert.match(text, /^🔹 UX Writers\n\n\{brand\} Main\n {2}Покер\n {4}Завершено\n {6}• Онбординг/);
});

test('текст задач экранируется в HTML', () => {
  const tree = buildSummary([report('a', [{ project: 'WL', streams: [stream('S', [task('<img src=x onerror=alert(1)>')])] }])], order);
  const html = summaryToHtml(tree);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
});

test('заполненный блок без проекта не сохраняется', () => {
  assert.throws(() => report('a', [{ project: '', streams: [stream('S', [task('x')])] }]), /Выберите проект/);
  assert.doesNotThrow(() => report('a', [{ project: '', streams: [stream('', [task('  ')])] }]));
});

test('неделя — только понедельник', () => {
  assert.equal(isWeekId('2026-10-05'), true);
  assert.equal(isWeekId('2026-10-06'), false);
  assert.equal(isWeekId('2026-02-30'), false);
  assert.equal(isWeekId('../../x'), false);
});

test('раздел «Важные встречи и обсуждения» выводится последним и читается из старых отчётов', () => {
  const withMeeting = report('a', [{ project: 'WL', streams: [{ name: 'S', sections: { done: [task('Готово')], meetings: [task('Синк с продуктом: договорились о терминах')] } }] }]);
  // Отчёт, сохранённый до появления раздела: ключа meetings нет совсем.
  const legacy = { author: 'b', projects: [{ project: 'WL', streams: [{ name: 's', sections: { done: [{ id: 'x1', text: 'Старое' }], blockers: [], progress: [] } }] }] };
  const tree = buildSummary([withMeeting, legacy], order);
  assert.deepEqual(tree[0].streams[0].done, ['Готово', 'Старое']);
  const html = summaryToHtml(tree);
  assert.match(html, /<p><strong>Завершено<\/strong><\/p>\n<ul>.*<\/ul>\n<p><strong>Важные встречи и обсуждения<\/strong><\/p>\n<ul><li>Синк с продуктом: договорились о терминах<\/li><\/ul>/);
  assert.doesNotThrow(() => applySave(legacy, legacy.projects, { email: 'lead', role: 'lead' }));
});
