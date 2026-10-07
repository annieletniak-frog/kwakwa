'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('./app');
const { createMailer } = require('./mailer');

const env = process.env;
const production = env.NODE_ENV === 'production';
const teamFile = path.resolve(env.TEAM_FILE || path.join(__dirname, '..', 'config', 'team.json'));

if (!fs.existsSync(teamFile)) {
  console.error(
    `Не найден список команды: ${teamFile}\n` +
      'Скопируйте config/team.example.json в config/team.json и укажите адреса и роли,\n' +
      'или запустите демо на вымышленных данных: npm run demo',
  );
  process.exit(1);
}

const mailer = createMailer(env);
const app = createApp({
  dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
  teamFile,
  sendCode: mailer.sendCode,
  mailMode: mailer.mode,
  // В продакшене приложение работает за HTTPS-прокси, поэтому cookie только Secure.
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production,
  trustProxy: env.TRUST_PROXY === 'true',
});

// По умолчанию слушаем только localhost: наружу приложение открывается осознанно, через прокси.
const host = env.HOST || '127.0.0.1';
const port = Number(env.PORT || 3000);
app.server().listen(port, host, () => {
  console.log(`Отчётник запущен: http://${host}:${port}  (почта: ${mailer.mode})`);
});
