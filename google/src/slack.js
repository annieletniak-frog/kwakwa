// ---------- Slack: напоминание по четвергам и отбивки райтерам ----------
// Настройки хранятся на листе «Настройки». Токен бота виден только владельцу таблицы.
// Функции без «_» в конце видны в редакторе (их можно запустить кнопкой «Выполнить»), но Google разрешает
// вызывать их и из браузера, поэтому каждая проверяет, что её запускает владелец или расписание.

const SHEET_SETTINGS = 'Настройки';
const SETTING_TOKEN = 'Slack: токен бота';
const SETTING_CHANNEL = 'Slack: ID канала';
const SETTING_HOUR = 'Напоминание по четвергам: час (0–23)';
const SETTING_URL = 'Ссылка на приложение';
const DEFAULT_CHANNEL = 'C052UCY0KME';
const REMINDER_TEXT = '<!channel>, четверг пришел, а значит время похвастаться успехами! {link} ждет вас, красавчики 🩶';

function ensureSettingsSheet_() {
  const ss = book_();
  if (ss.getSheetByName(SHEET_SETTINGS)) return;
  const sh = ss.insertSheet(SHEET_SETTINGS);
  sh.getRange(1, 1, 5, 3).setValues([
    ['Параметр', 'Значение', 'Пояснение'],
    [SETTING_TOKEN, '', 'Начинается с xoxb-. Как получить — в инструкции, раздел про Slack'],
    [SETTING_CHANNEL, DEFAULT_CHANNEL, 'Канал для напоминаний и отбивок'],
    [SETTING_HOUR, 11, 'По часовому поясу скрипта; после изменения снова запустите setupSlack'],
    [SETTING_URL, '', 'Можно не заполнять: подставится адрес приложения'],
  ]);
  sh.getRange(1, 1, 1, 3).setFontWeight('bold');
  sh.setColumnWidth(1, 320);
  sh.setColumnWidth(2, 260);
  sh.setColumnWidth(3, 480);
  sh.setFrozenRows(1);
}

function setting_(name) {
  for (const row of sheetRows_(SHEET_SETTINGS)) {
    if (String(row[0]).trim() === name) return String(row[1] === undefined ? '' : row[1]).trim();
  }
  return '';
}

function slackConfigured_() {
  return /^xox[bp]-/.test(setting_(SETTING_TOKEN));
}

function appUrl_() {
  return setting_(SETTING_URL) || ScriptApp.getService().getUrl();
}

function weekLink_(week) {
  return `<${appUrl_()}?week=${week}|Отчетник>`;
}

function currentWeekId_() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Запуск разрешён владельцу таблицы и расписанию; посетитель веб-приложения получит отказ.
function requireOwner_() {
  const active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (active && active !== owner) throw new Error('Эту функцию может запускать только владелец таблицы');
}

function slackCall_(method, payload) {
  const token = setting_(SETTING_TOKEN);
  if (!/^xox[bp]-/.test(token)) throw new HttpError(400, 'Slack не настроен: на листе «Настройки» нет токена бота');
  const res = UrlFetchApp.fetch(`https://slack.com/api/${method}`, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
  });
  let data = {};
  try {
    data = JSON.parse(res.getContentText());
  } catch (e) {
    data = { ok: false, error: `HTTP ${res.getResponseCode()}` };
  }
  return data;
}

function slackUserId_(email) {
  // users.lookupByEmail принимает параметры только формой, поэтому отдельный запрос.
  const res = UrlFetchApp.fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${setting_(SETTING_TOKEN)}` },
    muteHttpExceptions: true,
  });
  try {
    const data = JSON.parse(res.getContentText());
    return data.ok && data.user ? data.user.id : null;
  } catch (e) {
    return null;
  }
}

function slackErrorText_(code) {
  const known = {
    not_in_channel: 'бот не добавлен в канал — напишите в канале /invite и имя бота',
    channel_not_found: 'канал не найден — проверьте ID канала на листе «Настройки» и что бот в него добавлен',
    invalid_auth: 'неверный токен бота',
    not_authed: 'не указан токен бота',
    missing_scope: 'у бота не хватает прав — проверьте список прав в инструкции и переустановите приложение Slack',
    account_inactive: 'бот отключён в Slack',
  };
  return known[code] || code;
}

// Тред четвергового сообщения запоминаем, чтобы отбивки этой недели уходили в него.
function threadKey_(week) {
  return `slackThread:${week}`;
}

/** Расписание: каждый четверг публикует напоминание в канале. Можно запустить вручную для проверки. */
function sendThursdayReminder() {
  requireOwner_();
  if (!slackConfigured_()) {
    console.log('Slack не настроен — напоминание не отправлено');
    return;
  }
  const week = currentWeekId_();
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(threadKey_(week))) {
    console.log(`Напоминание за неделю ${week} уже отправлено`);
    return;
  }
  const data = slackCall_('chat.postMessage', {
    channel: setting_(SETTING_CHANNEL) || DEFAULT_CHANNEL,
    text: REMINDER_TEXT.replace('{link}', weekLink_(week)),
    unfurl_links: false,
  });
  if (!data.ok) throw new Error(`Slack не принял сообщение: ${slackErrorText_(data.error)}`);
  props.setProperty(threadKey_(week), data.ts);
  console.log(`Напоминание за неделю ${week} отправлено`);
}

/** Запустите один раз в редакторе: проверит токен и включит напоминание по четвергам. */
function setupSlack() {
  requireOwner_();
  ensureSettingsSheet_();
  if (!slackConfigured_()) {
    console.log('Лист «Настройки» готов. Вставьте на него токен бота Slack и запустите setupSlack ещё раз.');
    return;
  }
  const auth = slackCall_('auth.test');
  if (!auth.ok) throw new Error(`Slack: ${slackErrorText_(auth.error)}`);
  const hour = Math.min(23, Math.max(0, parseInt(setting_(SETTING_HOUR), 10) || 11));
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'sendThursdayReminder') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('sendThursdayReminder').timeBased().onWeekDay(ScriptApp.WeekDay.THURSDAY).atHour(hour).create();
  console.log(`Готово: бот «${auth.user}» подключён, напоминание будет уходить по четвергам с ${hour}:00 до ${hour + 1}:00`);
}

// Отбивка райтеру после проверки отчёта: в тред четвергового сообщения, с тегом райтера.
function notifyWriter_(report, lead) {
  const writer = findUser_(report.author);
  const writerId = slackUserId_(report.author);
  const mention = writerId ? `<@${writerId}>` : (writer ? writer.name : report.author);
  const leadComments = (report.comments || []).filter((c) => {
    const u = findUser_(c.author);
    return u && u.role === 'lead';
  }).length;
  const text = leadComments
    ? `${mention}, тимлид посмотрел твой отчёт и оставил комментарии (${leadComments}) — загляни в ${weekLink_(report.week)} 🩶`
    : `${mention}, тимлид посмотрел твой отчёт — спасибо! Он в ${weekLink_(report.week)} 🩶`;
  const threadTs = PropertiesService.getScriptProperties().getProperty(threadKey_(report.week));
  const payload = { channel: setting_(SETTING_CHANNEL) || DEFAULT_CHANNEL, text, unfurl_links: false };
  if (threadTs) payload.thread_ts = threadTs;
  const data = slackCall_('chat.postMessage', payload);
  if (!data.ok) throw new HttpError(502, `Slack не принял отбивку: ${slackErrorText_(data.error)}`);
  const warnings = [];
  if (!writerId) warnings.push('райтер не найден в Slack по рабочей почте, поэтому вместо тега указано имя');
  if (!threadTs) warnings.push('напоминания за эту неделю не было, поэтому отбивка ушла отдельным сообщением в канал');
  return { at: new Date().toISOString(), by: lead.email, warnings };
}
