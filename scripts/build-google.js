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

// Отдельный маленький скрипт: если основной код не запустился или Google не ответил, через 20 секунд
// вместо вечной «Загрузки…» показываем, что проверить. Чаще всего причина — несколько Google-аккаунтов в браузере.
const LOAD_WATCHDOG = `<script>
setTimeout(function () {
  var app = document.getElementById('app');
  if (!app || app.textContent.trim() !== 'Загрузка…') return;
  app.innerHTML = '<div class="card"><h2>Отчётник не загрузился</h2>' +
    '<p>Чаще всего так бывает, когда в браузере открыто несколько Google-аккаунтов. Попробуйте:</p>' +
    '<ol><li>Открыть ссылку в окне инкогнито (Ctrl+Shift+N, на Mac ⌘+Shift+N) и войти только рабочим аккаунтом.</li>' +
    '<li>Или выйти из личного Google-аккаунта в этом браузере, либо завести для работы отдельный профиль Chrome.</li></ol>' +
    '<p>Если не помогло — сообщите тимлиду: возможно, приложение нужно заново разрешить после обновления.</p></div>';
}, 20000);
</script>`;

const page = read('public/index.html')
  .replace(/\s*<link rel="icon"[^>]*>/, '')
  .replace(/<meta name="robots"[^>]*>\s*/, '')
  .replace('<head>', '<head>\n  <base target="_top">')
  .replace(/<link rel="stylesheet" href="\/styles.css">/, () => `<style>\n${read('public/styles.css')}</style>`)
  .replace(/<script src="\/app.js"><\/script>/, () => `${LOAD_WATCHDOG}\n<script>\n${read('public/app.js')}</script>`);
if (/<\/script>[\s\S]*<\/script>/.test(page.replace(/<script>\n[\s\S]*?<\/script>/, ''))) {
  throw new Error('Index.html: лишний </script> внутри кода');
}

fs.mkdirSync(path.join(root, 'google'), { recursive: true });
fs.writeFileSync(path.join(root, 'google', 'Code.gs'), code);
fs.writeFileSync(path.join(root, 'google', 'Index.html'), page);
console.log('Готово: google/Code.gs и google/Index.html');
