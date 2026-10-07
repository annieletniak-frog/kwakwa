'use strict';

// Собирает версию для Google Apps Script из общего кода:
//   google/Code.gs    — логика отчётов (server/reports.js) + хранение в Google Таблице (google/src/server.js)
//   google/Index.html — интерфейс (public/index.html + styles.css + app.js в одном файле)
// Оба файла вставляются в редактор Apps Script как есть. Запуск: npm run build:google

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function reportsForGas() {
  let src = read('server/reports.js');
  src = src.replace(/^'use strict';\n/, '');
  src = src.replace(/^const crypto = require\('node:crypto'\);\n/m, '');
  // newId в Apps Script берётся из google/src/server.js (Utilities.getUuid).
  src = src.replace(/^function newId\(\) \{\n[\s\S]*?\n\}\n/m, '');
  src = src.replace(/^module\.exports = \{[\s\S]*?\};\n?/m, '');
  if (/require\(|module\.exports|crypto\./.test(src)) throw new Error('reports.js: остались зависимости Node');
  return src.trim();
}

const header = '// Отчётник — версия для Google Apps Script. Файл собран автоматически (npm run build:google), не редактируйте вручную.\n\n';
const code = `${header}${reportsForGas()}\n\n${read('google/src/server.js').trim()}\n\n${read('google/src/slack.js').trim()}\n`;

// Отдельный маленький скрипт: если основной код не запустился или Google не ответил, через 15 секунд
// вместо вечной «Загрузки…» показываем, что проверить. Чаще всего причина — несколько Google-аккаунтов в браузере.
const LOAD_WATCHDOG = `<script>
var otchetnikErrors = [];
window.addEventListener('error', function (e) {
  otchetnikErrors.push(String(e.message || e) + (e.lineno ? ' (строка ' + e.lineno + ':' + e.colno + ')' : ''));
});
function otchetnikHash(line) {
  var h = 5381;
  for (var i = 0; i < line.length; i += 1) h = ((h * 33) ^ line.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function otchetnikCompare() {
  var el = document.getElementById('main-app');
  if (!el || !window.otchetnikLineHashes) return '| Сверка кода: основной скрипт не найден.';
  var lines = el.textContent.replace(/^\\n/, '').split('\\n');
  var want = window.otchetnikLineHashes;
  for (var i = 0; i < Math.max(lines.length, want.length); i += 1) {
    if (lines[i] === undefined) return '| Сверка кода: файл обрезан после строки ' + i + ' из ' + want.length + '.';
    if (otchetnikHash(lines[i]) !== want[i]) {
      return '| Сверка кода: строка ' + (i + 1) + ' отличается от оригинала: «' + lines[i].slice(0, 160) + '»';
    }
  }
  return '| Сверка кода: код дошёл без изменений.';
}
window.addEventListener('unhandledrejection', function (e) {
  var r = e.reason; otchetnikErrors.push(String((r && (r.message || r)) || 'unhandled rejection'));
});
setTimeout(function () {
  var app = document.getElementById('app');
  if (!app || app.textContent.trim() !== 'Загрузка…') return;
  var details = otchetnikErrors.length ? otchetnikErrors.join(' | ') : 'ошибок в браузере нет — не ответил Google';
  details += ' ' + otchetnikCompare();
  app.innerHTML = '<div class="card"><h2>Отчётник не загрузился</h2>' +
    '<p class="notice notice--error" id="loadError"></p>' +
    '<p>Чаще всего так бывает, когда в браузере открыто несколько Google-аккаунтов. Попробуйте:</p>' +
    '<ol><li>Открыть ссылку в окне инкогнито (Ctrl+Shift+N, на Mac ⌘+Shift+N) и войти только рабочим аккаунтом.</li>' +
    '<li>Или выйти из личного Google-аккаунта в этом браузере, либо завести для работы отдельный профиль Chrome.</li></ol>' +
    '<p>Если не помогло — сообщите тимлиду: возможно, приложение нужно заново разрешить после обновления.</p></div>';
  document.getElementById('loadError').textContent = 'Техническая причина: ' + details;
}, 15000);
</script>`;

// Хеши строк основного скрипта: если по дороге в браузер код изменился (при копировании или на стороне Google),
// подсказка о незагрузке покажет первую отличающуюся строку.
function lineHash(line) {
  let h = 5381;
  for (let i = 0; i < line.length; i += 1) h = ((h * 33) ^ line.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function integrityScript(js) {
  const hashes = js.split('\n').map(lineHash);
  return `<script>var otchetnikLineHashes = ${JSON.stringify(hashes)};</script>`;
}

const page = read('public/index.html')
  .replace(/\s*<link rel="icon"[^>]*>/, '')
  .replace(/<meta name="robots"[^>]*>\s*/, '')
  .replace('<head>', '<head>\n  <base target="_top">')
  .replace(/<link rel="stylesheet" href="\/styles.css">/, () => `<style>\n${read('public/styles.css')}</style>`)
  .replace(/<script src="\/app.js"><\/script>/, () => `${LOAD_WATCHDOG}\n${integrityScript(read('public/app.js'))}\n<script id="main-app">\n${read('public/app.js')}</script>`);
if (/<\/script/i.test(read('public/app.js'))) {
  throw new Error('app.js содержит </script — это сломает Index.html');
}

fs.mkdirSync(path.join(root, 'google'), { recursive: true });
fs.writeFileSync(path.join(root, 'google', 'Code.gs'), code);
fs.writeFileSync(path.join(root, 'google', 'Index.html'), page);
console.log('Готово: google/Code.gs и google/Index.html');
