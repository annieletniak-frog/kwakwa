(() => {
  'use strict';

  const SECTIONS = [
    { key: 'done', title: 'Завершено', placeholder: 'Что сделано за неделю' },
    { key: 'blockers', title: 'Блокеры', placeholder: 'Что мешает и чего не хватает' },
    { key: 'progress', title: 'Что в работе', placeholder: 'Над чем работаете сейчас' },
    { key: 'meetings', title: 'Важные встречи и обсуждения', placeholder: 'Встреча или обсуждение и его итог' },
  ];
  const ROLE_NAMES = { writer: 'Райтер', lead: 'Тимлид' };
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  const app = document.getElementById('app');
  const tabsEl = document.getElementById('tabs');
  const toastEl = document.getElementById('toast');

  const state = {
    user: null,
    projects: [],
    route: { tab: 'writer', week: null, report: null },
    dirty: false,
    renderToken: 0,
  };

  // ---------- Утилиты ----------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'value') el.value = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // replaceChildren превращает null в текст "null", поэтому пустые узлы отфильтровываем.
  function mount(target, ...nodes) {
    target.replaceChildren(...nodes.flat().filter(Boolean));
  }

  function uid() {
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  let toastTimer = null;
  function toast(message, kind, durationMs) {
    toastEl.textContent = message;
    toastEl.className = kind === 'error' ? 'toast toast--error' : 'toast';
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, durationMs || (kind === 'error' ? 6000 : 3500));
  }

  // Версия для Google Apps Script: те же запросы уходят в серверную функцию api() через google.script.run,
  // а входом занимается Google, поэтому своего экрана входа нет.
  const GAS = Boolean(window.google && window.google.script && window.google.script.run);

  function gasApi(method, url, body) {
    return new Promise((resolve, reject) => {
      window.google.script.run
        .withSuccessHandler((res) => {
          if (res && res.status >= 400) {
            const err = new Error(res.error || `Ошибка ${res.status}`);
            err.status = res.status;
            reject(err);
          } else {
            resolve(res ? res.data : {});
          }
        })
        .withFailureHandler((e) => reject(new Error((e && e.message) || 'Не удалось связаться с Google. Обновите страницу.')))
        .api(method, url, body === undefined ? null : body);
    });
  }

  async function api(method, url, body) {
    if (GAS) return gasApi(method, url, body);
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* пустой ответ */ }
    if (!res.ok) {
      const err = new Error(data.error || `Ошибка ${res.status}`);
      err.status = res.status;
      if (res.status === 401 && state.user) {
        state.user = null;
        state.dirty = false;
        renderLogin('Сессия завершилась — войдите снова.');
      }
      throw err;
    }
    return data;
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} в ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ---------- Недели (id недели — дата понедельника YYYY-MM-DD) ----------

  function toId(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function fromId(id) {
    const [y, m, d] = id.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function currentWeek() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return toId(d);
  }
  function addWeeks(id, n) {
    const d = fromId(id);
    d.setDate(d.getDate() + 7 * n);
    return toId(d);
  }
  function isWeekId(id) {
    return typeof id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(id) && fromId(id).getDay() === 1 && toId(fromId(id)) === id;
  }
  function weekLabel(id) {
    const start = fromId(id);
    const end = fromId(addWeeks(id, 1));
    end.setDate(end.getDate() - 1);
    const sameMonth = start.getMonth() === end.getMonth();
    const left = sameMonth ? `${start.getDate()}` : `${start.getDate()} ${MONTHS[start.getMonth()]}`;
    return `${left} – ${end.getDate()} ${MONTHS[end.getMonth()]} ${end.getFullYear()}`;
  }
  function weekHint(id) {
    const cur = currentWeek();
    if (id === cur) return 'текущая неделя';
    if (id === addWeeks(cur, -1)) return 'прошлая неделя';
    if (id === addWeeks(cur, 1)) return 'следующая неделя';
    return '';
  }

  function weekNav(week, onChange) {
    const max = addWeeks(currentWeek(), 1);
    return h('div', { class: 'week-nav', role: 'group', 'aria-label': 'Отчётная неделя' },
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': 'Предыдущая неделя', onclick: () => onChange(addWeeks(week, -1)) }, '←'),
      h('div', { class: 'week-nav__label' }, weekLabel(week), h('small', { text: weekHint(week) || ' ' })),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': 'Следующая неделя', disabled: week >= max, onclick: () => onChange(addWeeks(week, 1)) }, '→'),
      week !== currentWeek()
        ? h('button', { type: 'button', class: 'btn btn--link btn--sm', onclick: () => onChange(currentWeek()) }, 'Сегодня')
        : null,
    );
  }

  // ---------- Навигация ----------

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [tab, query] = raw.split('?');
    const params = new URLSearchParams(query || '');
    const week = params.get('week');
    return {
      tab: ['writer', 'lead', 'history'].includes(tab) ? tab : 'writer',
      week: isWeekId(week) ? week : null,
      report: params.get('report') || null,
    };
  }

  function hashFor(route) {
    const params = new URLSearchParams();
    if (route.week) params.set('week', route.week);
    if (route.report) params.set('report', route.report);
    const q = params.toString();
    return `#/${route.tab}${q ? `?${q}` : ''}`;
  }

  function confirmLeave() {
    return !state.dirty || window.confirm('Есть несохранённые изменения. Уйти без сохранения?');
  }

  function go(route) {
    if (!confirmLeave()) return;
    state.dirty = false;
    const next = hashFor(route);
    if (location.hash === next) render();
    else location.hash = next;
  }

  let restoringHash = false;
  window.addEventListener('hashchange', () => {
    if (restoringHash) { restoringHash = false; return; }
    if (state.dirty && !window.confirm('Есть несохранённые изменения. Уйти без сохранения?')) {
      restoringHash = true;
      location.hash = hashFor(state.route);
      return;
    }
    state.dirty = false;
    render();
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------- Вход ----------

  function renderNoAccess(message) {
    tabsEl.hidden = true;
    document.getElementById('account').hidden = true;
    mount(app, h('div', { class: 'card login' },
      h('h1', { text: 'Нет доступа' }),
      h('p', { class: 'muted', text: message }),
      h('p', { class: 'muted', text: 'Если вы в команде, попросите тимлида добавить ваш рабочий адрес на лист «Команда» и обновите страницу.' }),
    ));
  }

  async function renderLogin(message) {
    tabsEl.hidden = true;
    document.getElementById('account').hidden = true;
    let config = { devMail: false };
    try { config = await api('GET', '/api/config'); } catch { /* не критично */ }

    let email = '';
    const notice = h('div', { class: message ? 'notice notice--warn' : 'notice', hidden: !message, text: message || '' });

    const emailInput = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true, placeholder: 'name@company.com' });
    const codeInput = h('input', { type: 'text', id: 'code', class: 'code-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}', required: true });

    const stepCode = h('form', { hidden: true },
      h('label', { class: 'field', for: 'code' },
        h('span', { class: 'field__label', text: 'Код из письма' }),
        codeInput,
        h('span', { class: 'field__hint', text: 'Код действует 10 минут.' }),
      ),
      h('button', { type: 'submit', class: 'btn btn--primary btn--lg' }, 'Войти'),
      h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => { stepCode.hidden = true; stepEmail.hidden = false; notice.hidden = true; emailInput.focus(); } }, 'Изменить почту'),
    );

    const stepEmail = h('form', {},
      h('label', { class: 'field', for: 'email' },
        h('span', { class: 'field__label', text: 'Рабочая почта' }),
        emailInput,
      ),
      h('button', { type: 'submit', class: 'btn btn--primary btn--lg' }, 'Получить код'),
    );

    function showNotice(text, kind) {
      notice.textContent = text;
      notice.className = `notice${kind ? ` notice--${kind}` : ''}`;
      notice.hidden = false;
    }

    stepEmail.addEventListener('submit', async (e) => {
      e.preventDefault();
      email = emailInput.value.trim();
      const btn = stepEmail.querySelector('button');
      btn.disabled = true;
      try {
        await api('POST', '/api/auth/request', { email });
        stepEmail.hidden = true;
        stepCode.hidden = false;
        showNotice(
          `Если ${email} есть в списке команды, на него отправлен код. Повторно запросить код можно через минуту.` +
          (config.devMail ? ' Режим проверки: код выводится в консоль сервера.' : ''),
        );
        codeInput.focus();
      } catch (err) {
        showNotice(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    stepCode.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = stepCode.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api('POST', '/api/auth/verify', { email, code: codeInput.value });
        await boot();
      } catch (err) {
        showNotice(err.message, 'error');
        btn.disabled = false;
      }
    });

    mount(app, 
      h('div', { class: 'card login' },
        h('h1', { text: 'Вход в Отчётник' }),
        h('p', { class: 'muted', text: 'Еженедельные отчёты команды UX-райтеров. Доступ есть только у участников команды.' }),
        notice,
        stepEmail,
        stepCode,
      ),
    );
    emailInput.focus();
  }

  // ---------- Шапка и вкладки ----------

  function renderChrome() {
    const tabs = [
      { id: 'writer', title: state.user.role === 'lead' ? 'Райтер · мой отчёт' : 'Райтер' },
      state.user.role === 'lead' ? { id: 'lead', title: 'Тимлид' } : null,
      { id: 'history', title: 'История' },
    ].filter(Boolean);
    mount(tabsEl, ...tabs.map((t) => h('button', {
      type: 'button',
      class: 'tab',
      role: 'tab',
      'aria-selected': String(state.route.tab === t.id),
      onclick: () => go({ tab: t.id, week: state.route.week }),
    }, t.title)));
    tabsEl.setAttribute('role', 'tablist');
    tabsEl.hidden = false;
    document.getElementById('account').hidden = false;
    document.getElementById('logoutBtn').hidden = GAS;
    document.getElementById('accountName').textContent = state.user.name;
    document.getElementById('accountRole').textContent = ROLE_NAMES[state.user.role] || state.user.role;
  }

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (!confirmLeave()) return;
    state.dirty = false;
    try { await api('POST', '/api/auth/logout', {}); } catch { /* всё равно выходим */ }
    state.user = null;
    location.hash = '';
    renderLogin();
  });

  // ---------- Модель отчёта ----------

  function emptyTask() {
    return { id: uid(), text: '', due: '' };
  }
  function emptyStream() {
    return { id: uid(), name: '', sections: Object.fromEntries(SECTIONS.map(({ key }) => [key, [emptyTask()]])) };
  }
  function emptyProject() {
    return { id: uid(), project: '', streams: [emptyStream()] };
  }

  function modelFromReport(report) {
    const projects = report && report.projects.length ? clone(report.projects) : [emptyProject()];
    for (const p of projects) {
      if (!p.streams.length) p.streams.push(emptyStream());
      for (const s of p.streams) {
        for (const { key } of SECTIONS) {
          if (!s.sections[key] || !s.sections[key].length) s.sections[key] = [emptyTask()];
        }
      }
    }
    return projects;
  }

  function modelToPayload(projects) {
    return projects.map((p) => ({
      id: p.id,
      project: p.project,
      streams: p.streams.map((s) => ({
        id: s.id,
        name: s.name,
        sections: Object.fromEntries(SECTIONS.map(({ key }) => [key, s.sections[key].map((t) => ({ id: t.id, text: t.text, due: t.due || '' }))])),
      })),
    }));
  }

  function hasContent(project) {
    return project.streams.some((s) => s.name.trim() || SECTIONS.some(({ key }) => s.sections[key].some((t) => t.text.trim())));
  }

  // В отчётах, сохранённых до появления нового раздела, его может не быть.
  function tasksOf(stream, key) {
    return (stream.sections && stream.sections[key]) || [];
  }

  function savedTaskIds(report) {
    const ids = new Set();
    if (!report) return ids;
    for (const p of report.projects) for (const s of p.streams) for (const { key } of SECTIONS) for (const t of tasksOf(s, key)) ids.add(t.id);
    return ids;
  }

  function commentsByTask(report) {
    const map = new Map();
    for (const c of (report && report.comments) || []) {
      if (!map.has(c.taskId)) map.set(c.taskId, []);
      map.get(c.taskId).push(c);
    }
    return map;
  }

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }

  // ---------- Правки и комментарии ----------

  function editMark(task) {
    const e = task.leadEdit;
    if (!e) return null;
    const when = formatDateTime(e.at);
    if (e.added) return h('span', { class: 'edit-mark', title: 'Задачу добавил тимлид' }, `✎ Добавлено тимлидом · ${when}`);
    const prev = [e.prevText, e.prevDue ? `(срок: ${e.prevDue})` : ''].filter(Boolean).join(' ');
    return h('span', { class: 'edit-mark' },
      `✎ Изменено тимлидом · ${when}`,
      prev ? h('span', { class: 'edit-mark__prev', text: `Было: ${prev}` }) : null,
    );
  }

  function commentList(comments, { onDelete } = {}) {
    if (!comments || !comments.length) return null;
    return h('div', { class: 'comments' }, comments.map((c) => h('div', { class: 'comment' },
      h('div', { class: 'comment__head' },
        h('span', { class: 'comment__author', text: c.authorName }),
        h('span', { text: formatDateTime(c.createdAt) }),
        onDelete && c.author === state.user.email
          ? h('button', { type: 'button', class: 'btn btn--danger-link', onclick: () => onDelete(c) }, 'Удалить')
          : null,
      ),
      h('div', { class: 'comment__text', text: c.text }),
    )));
  }

  // ---------- План на неделю и календарь ----------

  function emptyPlanItem() {
    return { id: uid(), text: '', date: '' };
  }

  function planFromReport(report) {
    const plan = report && report.plan && report.plan.length ? clone(report.plan) : [];
    if (!plan.length) plan.push(emptyPlanItem());
    return plan;
  }

  function formatDay(id) {
    const d = fromId(id);
    const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    return `${days[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }

  function copyTextNow(text) {
    // Синхронное копирование работает и внутри окна Google Apps Script, где буфер обмена бывает закрыт.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      ok = true;
    }
    return ok;
  }

  // Google не даёт внешним страницам создавать в календаре запись типа «Задача», поэтому копируем текст
  // и открываем календарь на нужном дне: остаётся выбрать время, тип «Задача» и вставить название.
  function addToCalendar(item, week) {
    const text = item.text.trim();
    if (!text) {
      toast('Сначала напишите задачу', 'error');
      return;
    }
    const [y, m, d] = (item.date || week).split('-').map(Number);
    const copied = copyTextNow(text);
    window.open(`https://calendar.google.com/calendar/r/day/${y}/${m}/${d}`, '_blank', 'noopener');
    toast(copied
      ? 'Текст скопирован. В календаре нажмите на время → «Задача» → вставьте название (Ctrl+V / ⌘V)'
      : 'Календарь открыт. Нажмите на время → «Задача» и введите название', null, 8000);
  }

  // Событие Google Календарь умеет создавать по ссылке сразу с названием и датой (на весь день).
  function addEventToCalendar(item) {
    const text = item.text.trim();
    if (!text) {
      toast('Сначала напишите задачу', 'error');
      return;
    }
    const params = new URLSearchParams({ action: 'TEMPLATE', text, details: 'Из плана на неделю в Отчётнике' });
    if (item.date) {
      const [y, m, d] = item.date.split('-').map(Number);
      const next = toId(new Date(y, m - 1, d + 1));
      params.set('dates', `${item.date.replace(/-/g, '')}/${next.replace(/-/g, '')}`);
    }
    window.open(`https://calendar.google.com/calendar/render?${params}`, '_blank', 'noopener');
    toast(item.date ? 'Проверьте событие в календаре и нажмите «Сохранить»' : 'День не выбран: укажите дату в календаре и нажмите «Сохранить»', null, 6000);
  }

  function calendarButtons(item, week, extraClass) {
    return [
      h('button', {
        type: 'button',
        class: `btn btn--sm ${extraClass || ''}`,
        title: 'Скопировать текст и открыть календарь, чтобы создать запись типа «Задача»',
        onclick: () => addToCalendar(item, week),
      }, '📋 Задачей'),
      h('button', {
        type: 'button',
        class: `btn btn--sm ${extraClass || ''}`,
        title: 'Создать в Google Календаре событие с этим названием и датой',
        onclick: () => addEventToCalendar(item),
      }, '📅 Событием'),
    ];
  }

  function planReadonly(report, week) {
    const list = (report.plan || []).filter((t) => t.text);
    if (!list.length) return null;
    return h('div', { class: 'project plan' },
      h('h2', { text: 'План на неделю' }),
      h('p', { class: 'muted small', text: 'Виден только вам и не попадает в общий отчёт.' }),
      h('ul', { class: 'plan-list' }, list.map((t) => h('li', {},
        t.date ? h('span', { class: 'plan-list__date', text: formatDay(t.date) }) : null,
        h('span', { class: 'readonly-task', text: t.text }),
        calendarButtons(t, week, 'btn--link'),
      ))),
    );
  }

  // ---------- Редактор отчёта ----------
  // ctx: { report, mode: 'own' | 'lead', saveUrl, onSaved(report), onReloaded() }

  function createEditor(ctx) {
    let model = modelFromReport(ctx.report);
    // План есть только в собственном отчёте во вкладке «Райтер».
    let plan = ctx.withPlan ? planFromReport(ctx.report) : null;
    const root = h('div', { class: 'editor' });
    const statusEl = h('span', { class: 'savebar__status' });
    const saveBtn = h('button', { type: 'button', class: 'btn btn--primary btn--lg', onclick: save }, 'Сохранить');
    const openComment = new Set();
    let focusAfterRender = null;

    function setDirty(value) {
      state.dirty = value;
      updateStatus();
    }

    function updateStatus() {
      if (state.dirty) {
        statusEl.textContent = 'Есть несохранённые изменения';
        statusEl.className = 'savebar__status savebar__status--dirty';
      } else if (ctx.report) {
        const who = ctx.report.updatedBy && ctx.report.updatedBy !== state.user.email ? ` · ${ctx.report.updatedByName}` : '';
        statusEl.textContent = `Сохранено ${formatDateTime(ctx.report.updatedAt)}${who}`;
        statusEl.className = 'savebar__status';
      } else {
        statusEl.textContent = 'Отчёт ещё не сохранён';
        statusEl.className = 'savebar__status';
      }
    }

    function changed() {
      setDirty(true);
    }

    function structural(fn, focusId) {
      fn();
      focusAfterRender = focusId || null;
      setDirty(true);
      draw();
    }

    async function postComment(taskId, textarea) {
      const text = textarea.value.trim();
      if (!text) return;
      try {
        const data = await api('POST', `/api/reports/${ctx.report.id}/comments`, { taskId, text });
        ctx.report.comments = data.report.comments;
        openComment.delete(taskId);
        draw();
        toast(ctx.mode === 'lead' ? 'Комментарий сохранён — райтер его увидит' : 'Комментарий сохранён');
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function deleteComment(comment) {
      if (!window.confirm('Удалить комментарий?')) return;
      try {
        const data = await api('DELETE', `/api/reports/${ctx.report.id}/comments/${comment.id}`);
        ctx.report.comments = data.report.comments;
        draw();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    function taskEl(stream, sectionKey, task, saved, comments) {
      const list = stream.sections[sectionKey];
      const textarea = h('textarea', {
        rows: '1',
        'data-task': task.id,
        'aria-label': 'Описание задачи',
        placeholder: SECTIONS.find((s) => s.key === sectionKey).placeholder,
        value: task.text,
        oninput: (e) => { task.text = e.target.value; autosize(e.target); changed(); },
      });
      const due = sectionKey === 'progress'
        ? h('input', {
          type: 'text',
          class: 'task__due',
          'aria-label': 'Дата или ближайшая веха',
          placeholder: 'Дата или веха, напр. 15.10',
          maxlength: '120',
          value: task.due || '',
          oninput: (e) => { task.due = e.target.value; changed(); },
        })
        : null;
      const removeBtn = h('button', {
        type: 'button',
        class: 'icon-btn',
        title: 'Удалить задачу',
        'aria-label': 'Удалить задачу',
        onclick: () => {
          if (comments.length && !window.confirm('К задаче есть комментарии. Удалить задачу?')) return;
          structural(() => {
            list.splice(list.indexOf(task), 1);
            if (!list.length) list.push(emptyTask());
          });
        },
      }, '×');

      const canComment = ctx.report && saved.has(task.id);
      const isOpen = openComment.has(task.id);
      const commentBtn = canComment
        ? h('button', {
          type: 'button',
          class: 'btn btn--link btn--sm',
          onclick: () => {
            if (isOpen) openComment.delete(task.id); else openComment.add(task.id);
            focusAfterRender = isOpen ? null : `comment:${task.id}`;
            draw();
          },
        }, isOpen ? 'Скрыть форму' : '💬 Комментировать')
        : null;

      let form = null;
      if (canComment && isOpen) {
        const input = h('textarea', { rows: '1', 'data-comment': task.id, 'aria-label': 'Текст комментария', placeholder: 'Комментарий к задаче' });
        form = h('div', { class: 'comment-form' },
          input,
          h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => postComment(task.id, input) }, 'Отправить'),
        );
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) postComment(task.id, input);
        });
      }

      const mark = editMark(task);
      return h('div', { class: 'task' },
        h('div', { class: 'task__row' }, textarea, due, removeBtn),
        mark || commentBtn ? h('div', { class: 'task__meta' }, mark, commentBtn) : null,
        commentList(comments, { onDelete: deleteComment }),
        form,
      );
    }

    function draw() {
      const saved = savedTaskIds(ctx.report);
      const comments = commentsByTask(ctx.report);
      const projectBlocks = model.map((project, pi) => {
        const select = h('select', {
          'aria-label': 'Проект',
          onchange: (e) => { project.project = e.target.value; e.target.classList.remove('invalid'); changed(); },
        },
        h('option', { value: '' }, 'Выберите проект'),
        // Проект из старого отчёта, которого уже нет в списке, остаётся доступным.
        [...new Set([...state.projects, project.project].filter(Boolean))].map((name) => h('option', { value: name, selected: name === project.project }, name)));
        select.dataset.project = project.id;

        const streams = project.streams.map((stream) => h('div', { class: 'stream' },
          h('div', { class: 'stream__head' },
            h('label', { class: 'field' },
              h('span', { class: 'field__label', text: 'Стрим' }),
              h('input', {
                type: 'text',
                'data-stream': stream.id,
                maxlength: '120',
                placeholder: 'Например, Покер или Бонусы',
                value: stream.name,
                oninput: (e) => { stream.name = e.target.value; changed(); },
              }),
            ),
            h('span', { class: 'spacer' }),
            project.streams.length > 1
              ? h('button', {
                type: 'button',
                class: 'btn btn--danger-link btn--sm',
                onclick: () => {
                  const filled = SECTIONS.some(({ key }) => stream.sections[key].some((t) => t.text.trim()));
                  if (filled && !window.confirm(`Удалить стрим «${stream.name || 'без названия'}» со всеми задачами?`)) return;
                  structural(() => project.streams.splice(project.streams.indexOf(stream), 1));
                },
              }, 'Удалить стрим')
              : null,
          ),
          h('div', { class: 'sections' }, SECTIONS.map(({ key, title }) => {
            const list = stream.sections[key];
            return h('div', { class: `section section--${key}` },
              h('div', { class: 'section__title' }, title,
                key === 'progress' ? h('span', { class: 'muted small', text: '· укажите дату или ближайшую веху' }) : null),
              list.map((task) => taskEl(stream, key, task, saved, comments.get(task.id) || [])),
              h('div', { class: 'add-row' },
                h('button', {
                  type: 'button',
                  class: 'btn btn--link btn--sm',
                  onclick: () => {
                    const t = emptyTask();
                    structural(() => list.push(t), `task:${t.id}`);
                  },
                }, '+ Добавить задачу'),
              ),
            );
          })),
        ));

        return h('section', { class: 'project', 'aria-label': `Проект ${pi + 1}` },
          h('div', { class: 'project__head' },
            h('label', { class: 'field' }, h('span', { class: 'field__label', text: 'Проект' }), select),
            h('span', { class: 'spacer' }),
            model.length > 1
              ? h('button', {
                type: 'button',
                class: 'btn btn--danger-link btn--sm',
                onclick: () => {
                  if (hasContent(project) && !window.confirm(`Удалить блок «${project.project || 'без проекта'}» со всеми стримами и задачами?`)) return;
                  structural(() => model.splice(model.indexOf(project), 1));
                },
              }, 'Удалить проект')
              : null,
          ),
          streams,
          h('div', { class: 'add-row' },
            h('button', {
              type: 'button',
              class: 'btn btn--link',
              onclick: () => {
                const s = emptyStream();
                structural(() => project.streams.push(s), `stream:${s.id}`);
              },
            }, '+ Добавить стрим'),
          ),
        );
      });

      mount(root,
        plan ? planBlock() : null,
        plan ? h('h2', { class: 'editor-heading', text: 'Отчёт за неделю' }) : null,
        ...projectBlocks,
        h('button', {
          type: 'button',
          class: 'btn add-project',
          onclick: () => {
            const p = emptyProject();
            structural(() => model.push(p), `project:${p.id}`);
          },
        }, '+ Добавить проект'),
      );

      // Фокус ставим сразу, чтобы не потерять первые нажатия; высоту полей — после отрисовки.
      if (focusAfterRender) {
        const [kind, id] = focusAfterRender.split(':');
        const selector = {
          task: `[data-task="${id}"]`,
          stream: `[data-stream="${id}"]`,
          comment: `[data-comment="${id}"]`,
          plan: `[data-plan="${id}"]`,
        }[kind];
        const target = selector ? root.querySelector(selector) : [...root.querySelectorAll('select')].find((el) => el.dataset.project === id);
        if (target) target.focus();
        focusAfterRender = null;
      }
      requestAnimationFrame(() => root.querySelectorAll('textarea').forEach(autosize));
    }

    function planBlock() {
      const [y, m, d] = ctx.week.split('-').map(Number);
      const sunday = toId(new Date(y, m - 1, d + 6));
      return h('section', { class: 'project plan', 'aria-label': 'План на неделю' },
        h('h2', { text: '📅 План на неделю' }),
        h('p', { class: 'muted small', text: 'Задачи для себя: план виден только вам и не попадает в общий отчёт. В Google Календарь: «Задачей» — скопирует текст и откроет нужный день, «Событием» — создаст событие с названием и датой.' }),
        plan.map((item) => h('div', { class: 'plan-row' },
          h('input', {
            type: 'date',
            class: 'plan-row__date',
            'aria-label': 'День',
            min: ctx.week,
            max: sunday,
            value: item.date,
            onchange: (e) => { item.date = e.target.value; changed(); },
          }),
          h('textarea', {
            rows: '1',
            'data-plan': item.id,
            'aria-label': 'Запланированная задача',
            placeholder: 'Что планируете сделать',
            value: item.text,
            oninput: (e) => { item.text = e.target.value; autosize(e.target); changed(); },
          }),
          calendarButtons(item, ctx.week),
          h('button', {
            type: 'button',
            class: 'icon-btn',
            title: 'Удалить из плана',
            'aria-label': 'Удалить из плана',
            onclick: () => structural(() => {
              plan.splice(plan.indexOf(item), 1);
              if (!plan.length) plan.push(emptyPlanItem());
            }),
          }, '×'),
        )),
        h('div', { class: 'add-row' },
          h('button', {
            type: 'button',
            class: 'btn btn--link btn--sm',
            onclick: () => {
              const item = emptyPlanItem();
              structural(() => plan.push(item), `plan:${item.id}`);
            },
          }, '+ Добавить задачу в план'),
        ),
      );
    }

    async function save() {
      const missing = [...root.querySelectorAll('select')].filter((el) => {
        const p = model.find((x) => x.id === el.dataset.project);
        return p && !p.project && hasContent(p);
      });
      if (missing.length) {
        missing.forEach((el) => el.classList.add('invalid'));
        missing[0].focus();
        toast('Выберите проект для каждого заполненного блока', 'error');
        return;
      }
      saveBtn.disabled = true;
      try {
        const data = await api('PUT', ctx.saveUrl(), {
          version: ctx.report ? ctx.report.version : 0,
          projects: modelToPayload(model),
          plan: plan ? plan.map((t) => ({ id: t.id, text: t.text, date: t.date })) : undefined,
        });
        ctx.report = data.report;
        model = modelFromReport(ctx.report);
        if (plan) plan = planFromReport(ctx.report);
        setDirty(false);
        draw();
        if (ctx.onSaved) ctx.onSaved(ctx.report);
        toast(ctx.mode === 'lead' ? 'Правки сохранены — райтер их увидит' : 'Отчёт сохранён — тимлид его видит');
      } catch (err) {
        if (err.status === 409) {
          conflict(err.message);
        } else {
          toast(err.message, 'error');
        }
      } finally {
        saveBtn.disabled = false;
      }
    }

    function conflict(message) {
      const box = h('div', { class: 'notice notice--warn' },
        message, ' ',
        h('button', {
          type: 'button',
          class: 'btn btn--link btn--sm',
          onclick: () => {
            if (!window.confirm('Ваши несохранённые изменения пропадут. Загрузить актуальную версию?')) return;
            state.dirty = false;
            ctx.onReloaded();
          },
        }, 'Загрузить актуальную версию'),
      );
      root.prepend(box);
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    draw();
    updateStatus();
    const savebar = h('div', { class: 'savebar' }, h('div', { class: 'savebar__inner' }, statusEl, saveBtn));
    return { root, savebar };
  }

  // ---------- Просмотр отчёта (только чтение) ----------

  function readonlyReport(report) {
    const comments = commentsByTask(report);
    const blocks = [];
    for (const p of report.projects) {
      const streams = [];
      for (const s of p.streams) {
        const sections = SECTIONS.filter(({ key }) => tasksOf(s, key).length).map(({ key, title }) => h('div', { class: `section section--${key}` },
          h('div', { class: 'section__title', text: title }),
          h('ul', { class: 'stack-sm' }, tasksOf(s, key).map((t) => h('li', {},
            h('span', { class: 'readonly-task', text: t.text }),
            t.due ? h('span', { class: 'readonly-due', text: ` · срок: ${t.due}` }) : null,
            t.leadEdit ? h('div', { class: 'task__meta' }, editMark(t)) : null,
            commentList(comments.get(t.id)),
          ))),
        ));
        if (sections.length) {
          streams.push(h('div', { class: 'stream' },
            h('h3', { text: s.name || 'Без названия стрима' }),
            h('div', { class: 'sections' }, sections),
          ));
        }
      }
      if (streams.length) blocks.push(h('div', { class: 'project' }, h('h2', { text: p.project || 'Проект не выбран' }), streams));
    }
    const orphan = orphanComments(report);
    return h('div', {},
      blocks.length ? blocks : h('p', { class: 'muted', text: 'В отчёте нет заполненных задач.' }),
      orphan,
      removedList(report),
    );
  }

  function orphanComments(report) {
    const ids = savedTaskIds(report);
    const list = (report.comments || []).filter((c) => !ids.has(c.taskId));
    if (!list.length) return null;
    return h('div', { class: 'card' },
      h('h3', { text: 'Комментарии к удалённым задачам' }),
      list.map((c) => h('div', {},
        h('p', { class: 'muted small', text: `К задаче «${c.taskText}»` }),
        commentList([c]),
      )),
    );
  }

  function removedList(report) {
    const list = report.removedByLead || [];
    if (!list.length) return null;
    const titles = Object.fromEntries(SECTIONS.map((s) => [s.key, s.title]));
    return h('div', { class: 'notice notice--edit' },
      h('strong', { text: 'Тимлид удалил задачи:' }),
      h('ul', {}, list.map((r) => h('li', {},
        `«${r.text}» — ${[r.project, r.stream, titles[r.section]].filter(Boolean).join(' → ')} · ${r.byName}, ${formatDateTime(r.at)}`))),
    );
  }

  function leadActivityNotice(report) {
    if (!report || report.author !== state.user.email) return null;
    let edits = 0;
    for (const p of report.projects) for (const s of p.streams) for (const { key } of SECTIONS) for (const t of tasksOf(s, key)) if (t.leadEdit) edits += 1;
    const comments = (report.comments || []).filter((c) => c.author !== state.user.email).length;
    if (!edits && !comments && !(report.removedByLead || []).length) return null;
    const parts = [];
    if (edits) parts.push(`правки в задачах: ${edits}`);
    if (comments) parts.push(`комментарии: ${comments}`);
    if ((report.removedByLead || []).length) parts.push(`удалённые задачи: ${report.removedByLead.length}`);
    return h('div', { class: 'notice notice--edit' }, `Тимлид поработал с отчётом — ${parts.join(', ')}. Они отмечены ниже фиолетовым.`);
  }

  // ---------- Общий отчёт ----------

  function summaryPreview(summary) {
    const box = h('div', { class: 'summary-preview' });
    if (!summary.tree.length) {
      box.append(h('p', { class: 'muted', text: 'Пока нечего собирать: за эту неделю нет заполненных задач.' }));
      return box;
    }
    // HTML собран сервером из экранированного текста; разбираем его в отдельный документ,
    // чтобы показать ровно то, что попадёт в буфер обмена.
    const doc = new DOMParser().parseFromString(summary.html, 'text/html');
    box.append(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
    return box;
  }

  async function copySummary(summary) {
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([summary.html], { type: 'text/html' }),
          'text/plain': new Blob([summary.text], { type: 'text/plain' }),
        })]);
      } else {
        legacyCopy(summary.html);
      }
      toast('Общий отчёт скопирован — вставьте его в Confluence (Ctrl+V / ⌘V)');
    } catch {
      try {
        legacyCopy(summary.html);
        toast('Общий отчёт скопирован — вставьте его в Confluence (Ctrl+V / ⌘V)');
      } catch {
        toast('Не получилось скопировать автоматически. Выделите текст отчёта и скопируйте вручную.', 'error');
      }
    }
  }

  function legacyCopy(html) {
    const holder = h('div', { contenteditable: 'true' });
    holder.style.position = 'fixed';
    holder.style.left = '-9999px';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    holder.append(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
    document.body.append(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('copy');
    sel.removeAllRanges();
    holder.remove();
    if (!ok) throw new Error('copy failed');
  }

  function summaryCard(summary, title) {
    const copyBtn = h('button', {
      type: 'button',
      class: 'btn btn--primary',
      disabled: !summary.tree.length,
      onclick: () => copySummary(summary),
    }, '📋 Скопировать общий отчёт');
    return h('div', { class: 'card' },
      h('div', { class: 'split-head' },
        h('div', {},
          h('h2', { text: title || 'Общий отчёт' }),
          h('p', { class: 'muted small', text: `Собран из отчётов: ${summary.reportCount}. Записи объединены по проектам и стримам, пустые разделы скрыты.` }),
        ),
        copyBtn,
      ),
      summaryPreview(summary),
    );
  }

  // ---------- Вкладка «Райтер» ----------

  async function renderWriter(token) {
    const week = state.route.week || currentWeek();
    const data = await api('GET', `/api/my-report?week=${week}`);
    if (token !== state.renderToken) return;
    const ctx = {
      report: data.report,
      mode: 'own',
      withPlan: true,
      week,
      saveUrl: () => `/api/my-report?week=${week}`,
      onSaved: () => {},
      onReloaded: () => render(),
    };
    const editor = createEditor(ctx);
    mount(app, 
      h('div', { class: 'page-head' },
        h('div', {},
          h('h1', { text: 'Мой отчёт' }),
          h('p', { class: 'muted', text: 'Выберите проект, укажите стрим и заполните задачи. После сохранения отчёт увидит тимлид.' }),
        ),
        weekNav(week, (w) => go({ tab: 'writer', week: w })),
      ),
      leadActivityNotice(data.report),
      data.report ? removedList(data.report) : null,
      data.report ? orphanComments(data.report) : null,
      editor.root,
      editor.savebar,
    );
  }

  // Отбивка райтеру в Slack: тимлид отправляет её сам, когда закончил проверку отчёта.
  function notifyBlock(report) {
    const sent = report.reviewNotified;
    const btn = h('button', {
      type: 'button',
      class: sent ? 'btn' : 'btn btn--primary',
      onclick: async () => {
        if (state.dirty) {
          toast('Сначала сохраните правки — райтер должен увидеть их по ссылке', 'error');
          return;
        }
        if (!window.confirm(`Отправить ${report.authorName} отбивку в Slack?`)) return;
        btn.disabled = true;
        try {
          const data = await api('POST', `/api/reports/${report.id}/notify`, {});
          const extra = data.warnings && data.warnings.length ? ` Обратите внимание: ${data.warnings.join('; ')}.` : '';
          toast(`Отбивка отправлена в Slack.${extra}`, null, extra ? 9000 : 3500);
          render();
        } catch (err) {
          toast(err.message, 'error', 9000);
          btn.disabled = false;
        }
      },
    }, sent ? '📣 Отправить отбивку ещё раз' : '📣 Проверено — отправить отбивку в Slack');
    return h('div', { class: 'notify-row' },
      btn,
      h('span', {
        class: 'muted small',
        text: sent
          ? `Отбивка отправлена ${formatDateTime(sent.at)}`
          : 'Райтер получит сообщение с тегом в треде четвергового напоминания',
      }),
    );
  }

  // ---------- Вкладка «Тимлид» ----------

  async function renderLead(token) {
    if (state.user.role !== 'lead') return go({ tab: 'writer' });
    const week = state.route.week || currentWeek();
    const [list, summary] = await Promise.all([
      api('GET', `/api/reports?week=${week}`),
      api('GET', `/api/summary?week=${week}`),
    ]);
    if (token !== state.renderToken) return;

    const selected = state.route.report ? list.reports.find((r) => r.id === state.route.report) : null;
    const filled = list.team.filter((m) => m.reportId).length;

    const teamCard = h('div', { class: 'card' },
      h('h2', { text: 'Команда' }),
      h('p', { class: 'progress-line muted', text: `Заполнили ${filled} из ${list.team.length}` }),
      h('ul', { class: 'team-list' }, list.team.map((m) => h('li', {},
        h('button', {
          type: 'button',
          class: 'team-item',
          disabled: !m.reportId,
          'aria-current': String(Boolean(selected && selected.id === m.reportId)),
          onclick: () => go({ tab: 'lead', week, report: m.reportId }),
        },
        h('span', { class: `status-dot${m.reportId ? ' status-dot--ok' : ''}`, 'aria-hidden': 'true' }),
        h('span', {},
          h('span', { class: 'team-item__name', text: m.name }),
          h('span', {
            class: 'team-item__sub',
            text: m.reportId
              ? `Обновлён ${formatDateTime(m.updatedAt)}${m.notifiedAt ? ' · отбивка отправлена' : ''}`
              : 'Отчёт не заполнен',
          }),
        )),
      ))),
      selected
        ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => go({ tab: 'lead', week }) }, '← К общему отчёту')
        : null,
    );

    let main;
    let savebar = null;
    if (selected) {
      const ctx = {
        report: selected,
        mode: selected.author === state.user.email ? 'own' : 'lead',
        saveUrl: () => `/api/reports/${selected.id}`,
        onSaved: () => {},
        onReloaded: () => render(),
      };
      const editor = createEditor(ctx);
      savebar = editor.savebar;
      main = h('div', {},
        h('div', { class: 'card' },
          h('div', { class: 'split-head' },
            h('div', {},
              h('h2', { text: `Отчёт: ${selected.authorName}` }),
              h('p', { class: 'muted small', text: 'Можно дополнить и исправить задачи или оставить комментарий к конкретной задаче. Райтер увидит правки и комментарии в своём отчёте.' }),
            ),
            h('button', { type: 'button', class: 'btn', onclick: () => go({ tab: 'lead', week }) }, 'К общему отчёту'),
          ),
          state.slack && selected.author !== state.user.email ? notifyBlock(selected) : null,
        ),
        removedList(selected),
        orphanComments(selected),
        h('div', {}, editor.root),
      );
    } else if (state.route.report) {
      main = h('div', { class: 'card empty', text: 'Отчёт не найден за эту неделю.' });
    } else {
      main = summaryCard(summary);
    }

    mount(app, 
      h('div', { class: 'page-head' },
        h('div', {},
          h('h1', { text: 'Отчёты команды' }),
          h('p', { class: 'muted', text: 'Проверьте отчёты, дополните и прокомментируйте их, затем скопируйте общий отчёт в Confluence.' }),
        ),
        weekNav(week, (w) => go({ tab: 'lead', week: w })),
      ),
      h('div', { class: 'lead-grid' }, teamCard, main),
      savebar,
    );
  }

  // ---------- Вкладка «История» ----------

  async function renderHistory(token) {
    const { weeks } = await api('GET', '/api/weeks');
    if (token !== state.renderToken) return;
    const week = state.route.week && weeks.some((w) => w.week === state.route.week) ? state.route.week : weeks[0] && weeks[0].week;

    const head = h('div', { class: 'page-head' },
      h('div', {},
        h('h1', { text: 'История' }),
        h('p', {
          class: 'muted',
          text: state.user.role === 'lead'
            ? 'Сохранённые отчёты команды по неделям.'
            : 'Ваши сохранённые отчёты по неделям — с правками и комментариями тимлида.',
        }),
      ),
    );

    if (!week) {
      mount(app, head, h('div', { class: 'card empty', text: 'Пока нет сохранённых отчётов.' }));
      return;
    }

    const chips = h('div', { class: 'card' },
      h('div', { class: 'field__label', text: 'Неделя' }),
      h('div', { class: 'history-weeks' }, weeks.map((w) => h('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(w.week === week),
        onclick: () => go({ tab: 'history', week: w.week }),
      }, weekLabel(w.week), state.user.role === 'lead' ? ` · ${w.count}` : ''))),
    );

    const requests = [api('GET', `/api/reports?week=${week}`)];
    if (state.user.role === 'lead') requests.push(api('GET', `/api/summary?week=${week}`));
    const [list, summary] = await Promise.all(requests);
    if (token !== state.renderToken) return;

    const content = [];
    if (summary) content.push(summaryCard(summary, `Общий отчёт · ${weekLabel(week)}`));
    for (const report of list.reports) {
      // Чужой отчёт, в котором есть только личный план, тимлиду показывать нечего.
      if (report.author !== state.user.email && !savedTaskIds(report).size) continue;
      const editRoute = report.author === state.user.email
        ? { tab: 'writer', week }
        : { tab: 'lead', week, report: report.id };
      const body = h('div', { class: 'stack' },
        h('div', { class: 'split-head' },
          h('div', {},
            h('h2', { text: report.author === state.user.email ? 'Мой отчёт' : report.authorName }),
            h('p', { class: 'muted small', text: `Обновлён ${formatDateTime(report.updatedAt)}${report.updatedByName ? ` · ${report.updatedByName}` : ''}` }),
          ),
          h('button', { type: 'button', class: 'btn', onclick: () => go(editRoute) }, 'Открыть для правки'),
        ),
        leadActivityNotice(report),
        report.author === state.user.email ? planReadonly(report, week) : null,
        readonlyReport(report),
      );
      content.push(state.user.role === 'lead'
        ? h('details', { class: 'card' }, h('summary', {}, h('strong', { text: report.authorName })), body)
        : h('div', { class: 'card' }, body));
    }
    mount(app, head, chips, ...content);
  }

  // ---------- Запуск ----------

  async function render() {
    if (!state.user) return;
    state.route = parseHash();
    if (state.route.tab === 'lead' && state.user.role !== 'lead') state.route.tab = 'writer';
    renderChrome();
    const token = ++state.renderToken;
    try {
      if (state.route.tab === 'lead') await renderLead(token);
      else if (state.route.tab === 'history') await renderHistory(token);
      else await renderWriter(token);
      window.scrollTo(0, 0);
    } catch (err) {
      if (err.status === 401) return;
      mount(app, h('div', { class: 'card' },
        h('div', { class: 'notice notice--error', text: err.message }),
        h('p', {}, h('button', { type: 'button', class: 'btn', onclick: () => render() }, 'Повторить')),
      ));
    }
  }

  // Ссылка из Slack открывает приложение с ?week=…; в Google параметры адреса читаются через google.script.url.
  function applyStartParams() {
    return new Promise((resolve) => {
      if (location.hash || !(window.google.script.url && window.google.script.url.getLocation)) {
        resolve();
        return;
      }
      window.google.script.url.getLocation((loc) => {
        const week = loc && loc.parameter && loc.parameter.week;
        if (isWeekId(week)) history.replaceState(null, '', hashFor({ tab: 'writer', week }));
        resolve();
      });
    });
  }

  async function boot() {
    try {
      const me = await api('GET', '/api/me');
      state.user = me.user;
      state.projects = me.projects;
      state.slack = Boolean(me.slack);
      if (GAS) await applyStartParams();
      await render();
    } catch (err) {
      if (err.status === 401 && !GAS) renderLogin();
      else if (GAS && (err.status === 401 || err.status === 403)) renderNoAccess(err.message);
      else mount(app, h('div', { class: 'card notice notice--error', text: err.message }));
    }
  }

  boot();
})();
