'use strict';

// Эмуляция сервисов Google Apps Script, достаточная для запуска google/Code.gs в Node.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  setValues(values) {
    values.forEach((r, i) => r.forEach((v, j) => this.sheet.set(this.row + i, this.col + j, v)));
    return this;
  }
  setValue(v) {
    this.sheet.set(this.row, this.col, v);
    return this;
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.rows; i += 1) {
      const r = [];
      for (let j = 0; j < this.cols; j += 1) r.push(this.sheet.get(this.row + i, this.col + j));
      out.push(r);
    }
    return out;
  }
  setFontWeight() { return this; }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.cells = [];
  }
  set(r, c, v) {
    while (this.cells.length < r) this.cells.push([]);
    this.cells[r - 1][c - 1] = v;
  }
  get(r, c) {
    const v = (this.cells[r - 1] || [])[c - 1];
    return v === undefined ? '' : v;
  }
  getRange(row, col, rows = 1, cols = 1) { return new FakeRange(this, row, col, rows, cols); }
  getLastRow() { return this.cells.length; }
  getLastColumn() { return Math.max(0, ...this.cells.map((r) => r.length)); }
  appendRow(values) { this.cells.push(values.slice()); }
  setColumnWidth() {}
  setFrozenRows() {}
}

function loadGoogleApp({ owner = 'lead@example.com' } = {}) {
  const sheets = new Map();
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
  };
  let activeEmail = owner;
  const props = new Map();
  const triggers = [];
  const slack = { calls: [], users: {}, nextTs: 1 };
  const json = (obj) => ({ getContentText: () => JSON.stringify(obj), getResponseCode: () => 200 });
  const context = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, String(v)),
      }),
    },
    // Эмуляция Slack Web API: запоминаем вызовы и отвечаем как Slack.
    UrlFetchApp: {
      fetch: (url, opts = {}) => {
        const method = url.split('/api/')[1].split('?')[0];
        const auth = (opts.headers || {}).Authorization || '';
        if (auth !== 'Bearer xoxb-test') return json({ ok: false, error: 'invalid_auth' });
        if (method === 'users.lookupByEmail') {
          const email = decodeURIComponent(url.split('email=')[1]);
          return json(slack.users[email] ? { ok: true, user: { id: slack.users[email] } } : { ok: false, error: 'users_not_found' });
        }
        const payload = opts.payload ? JSON.parse(opts.payload) : {};
        slack.calls.push({ method, payload });
        if (method === 'auth.test') return json({ ok: true, user: 'otchetnik' });
        if (method === 'chat.postMessage') return json({ ok: true, ts: `1700000000.00000${slack.nextTs++}` });
        return json({ ok: false, error: 'unknown_method' });
      },
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/a/macros/example.com/s/APP/exec' }),
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      WeekDay: { THURSDAY: 'THURSDAY' },
      newTrigger: (fn) => {
        const t = { fn, getHandlerFunction: () => fn };
        const b = {
          timeBased: () => b,
          onWeekDay: (d) => { t.day = d; return b; },
          atHour: (h) => { t.hour = h; return b; },
          create: () => { triggers.push(t); return t; },
        };
        return b;
      },
    },
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Session: {
      getActiveUser: () => ({ getEmail: () => activeEmail }),
      getEffectiveUser: () => ({ getEmail: () => owner }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => crypto.randomUUID() },
    HtmlService: {
      createHtmlOutputFromFile: () => {
        const out = { setTitle: () => out, addMetaTag: () => out };
        return out;
      },
    },
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '..', 'google', 'Code.gs'), 'utf8');
  // Объявления верхнего уровня (const/class) не становятся свойствами контекста — отдаём нужные явно.
  vm.runInContext(`${code}\n;this.__exports = { doGet, api, sendThursdayReminder, setupSlack };`, context);
  return {
    sheets,
    props,
    triggers,
    slack,
    run(email, fn) { activeEmail = email; return context.__exports[fn](); },
    doGet: context.__exports.doGet,
    as(email) { activeEmail = email; return this; },
    call(email, method, url, body) {
      activeEmail = email;
      // Через JSON, как google.script.run: на клиент уходят только сериализуемые данные.
      return JSON.parse(JSON.stringify(context.__exports.api(method, url, body === undefined ? null : body)));
    },
  };
}

module.exports = { loadGoogleApp };
