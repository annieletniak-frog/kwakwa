'use strict';

// Доставка кода входа. В продакшене — только SMTP; режим "console"
// (код печатается в консоль сервера) разрешён лишь для локальной проверки.
function createMailer(env = process.env) {
  const mode = env.MAIL_MODE || (env.SMTP_HOST ? 'smtp' : 'console');

  if (mode === 'console') {
    if (env.NODE_ENV === 'production') {
      throw new Error('MAIL_MODE=console запрещён при NODE_ENV=production: настройте SMTP');
    }
    return {
      mode,
      async sendCode(user, code) {
        console.log(`[dev-mail] Код входа для ${user.email}: ${code}`);
      },
    };
  }

  if (mode !== 'smtp') throw new Error(`Неизвестный MAIL_MODE: ${mode}`);
  if (!env.SMTP_HOST || !env.MAIL_FROM) throw new Error('Для MAIL_MODE=smtp нужны SMTP_HOST и MAIL_FROM');

  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });

  return {
    mode,
    async sendCode(user, code) {
      await transport.sendMail({
        from: env.MAIL_FROM,
        to: user.email,
        subject: 'Код входа в Отчётник',
        text: `Ваш код входа: ${code}\n\nКод действует 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.`,
      });
    },
  };
}

module.exports = { createMailer };
