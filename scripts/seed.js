'use strict';

// Заполняет хранилище вымышленными отчётами для проверки. Реальные отчёты сюда не добавляем.
const path = require('node:path');
const { JsonStore } = require('../server/store');
const { applySave, newId } = require('../server/reports');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const db = new JsonStore(path.join(dataDir, 'reports.json'), { reports: {} });

function monday(offsetWeeks) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offsetWeeks * 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const t = (text, due) => ({ text, due });
const stream = (name, done = [], blockers = [], progress = []) => ({ name, sections: { done, blockers, progress } });

const samples = {
  'anna@example.com': [
    { project: '{brand} Main', streams: [
      stream('Покер', [t('Переписали онбординг турнирного лобби'), t('Сократили тексты ошибок при входе в стол')], [], [t('Микрокопи для кэш-игр', '15.10')]),
    ] },
  ],
  'boris@example.com': [
    { project: '{brand} Main', streams: [
      stream('Бонусы', [t('Тексты условий фрибетов')], [t('Ждём юридическую формулировку для вейджера')], [t('Пуши о сгорании бонуса', 'ревью макетов')]),
      stream('покер', [t('Подсказки к статистике игрока')]),
    ] },
  ],
  'vera@example.com': [
    { project: 'WL', streams: [stream('Регистрация', [t('Новый флоу верификации: тексты шагов')], [], [t('Письма подтверждения', '18.10')])] },
    { project: 'Landings', streams: [stream('Промо', [], [], [t('Лендинг осенней акции', 'согласование с маркетингом')])] },
  ],
  'gleb@example.com': [
    { project: 'W.tv', streams: [stream('Плеер', [t('Тексты пустых состояний')], [t('Нет финального списка ошибок плеера от разработки')])] },
  ],
  'dina@example.com': [
    { project: 'CDP', streams: [stream('Сегменты', [t('Глоссарий терминов для интерфейса сегментов')], [], [t('Подсказки в конструкторе', '20.10')])] },
  ],
  'egor@example.com': [
    { project: 'Side Project', streams: [stream('Лояльность', [], [], [t('Названия уровней программы', 'воркшоп с продуктом')])] },
  ],
};

let count = 0;
for (const offset of [-2, -1]) {
  const week = monday(offset);
  for (const [email, projects] of Object.entries(samples)) {
    const exists = Object.values(db.data.reports).some((r) => r.author === email && r.week === week);
    if (exists) continue;
    const base = { id: newId(), week, author: email, createdAt: new Date().toISOString(), version: 0, projects: [], comments: [], removedByLead: [] };
    const saved = applySave(base, JSON.parse(JSON.stringify(projects)), { email, role: 'writer' });
    db.data.reports[saved.id] = saved;
    count += 1;
  }
}
db.save();
console.log(`Добавлено вымышленных отчётов: ${count} (за две прошлые недели).`);
