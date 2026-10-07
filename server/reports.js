'use strict';

const crypto = require('node:crypto');

const SECTIONS = ['done', 'blockers', 'progress', 'meetings'];
const SECTION_TITLES = {
  done: 'Завершено',
  blockers: 'Блокеры',
  progress: 'Что в работе',
  meetings: 'Важные встречи и обсуждения',
};
const LIMITS = {
  projects: 20,
  streamsPerProject: 30,
  tasksPerSection: 100,
  taskText: 2000,
  due: 120,
  name: 120,
  comment: 2000,
  commentsPerReport: 1000,
  removedLog: 100,
};
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

class ValidationError extends Error {}

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

// Понедельник отчётной недели в формате YYYY-MM-DD.
function isWeekId(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value && d.getUTCDay() === 1;
}

function cleanMultiline(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
    .slice(0, max);
}

function cleanLine(value, max) {
  return cleanMultiline(value, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);
}

function takeId(candidate, used) {
  const id = typeof candidate === 'string' && ID_RE.test(candidate) && !used.has(candidate) ? candidate : newId();
  used.add(id);
  return id;
}

// Приводит присланную форму к хранимому виду: обрезает лишнее, выбрасывает пустые пункты,
// проверяет лимиты. Служебные поля (правки тимлида) клиент задать не может.
function sanitizeProjects(input) {
  if (!Array.isArray(input)) throw new ValidationError('Ожидается список проектов');
  if (input.length > LIMITS.projects) throw new ValidationError('Слишком много проектов в одном отчёте');
  const used = new Set();
  return input.map((p) => {
    const project = cleanLine(p && p.project, LIMITS.name);
    const streamsIn = Array.isArray(p && p.streams) ? p.streams : [];
    if (streamsIn.length > LIMITS.streamsPerProject) throw new ValidationError('Слишком много стримов в проекте');
    const streams = streamsIn.map((s) => {
      const sections = {};
      for (const key of SECTIONS) {
        const tasksIn = Array.isArray(s && s.sections && s.sections[key]) ? s.sections[key] : [];
        if (tasksIn.length > LIMITS.tasksPerSection) throw new ValidationError('Слишком много задач в разделе');
        sections[key] = tasksIn
          .map((t) => {
            const task = { id: takeId(t && t.id, used), text: cleanMultiline(t && t.text, LIMITS.taskText) };
            if (key === 'progress') task.due = cleanLine(t && t.due, LIMITS.due);
            return task;
          })
          .filter((t) => t.text);
      }
      return { id: takeId(s && s.id, used), name: cleanLine(s && s.name, LIMITS.name), sections };
    });
    const hasTasks = streams.some((s) => SECTIONS.some((k) => s.sections[k].length));
    if (!project && hasTasks) throw new ValidationError('Выберите проект для каждого заполненного блока');
    return { id: takeId(p && p.id, used), project, streams };
  });
}

function indexTasks(projects) {
  const map = new Map();
  for (const p of projects) {
    for (const s of p.streams) {
      for (const key of SECTIONS) {
        // В отчётах, сохранённых до появления раздела, его может не быть.
        for (const t of s.sections[key] || []) map.set(t.id, { task: t, section: key, project: p.project, stream: s.name });
      }
    }
  }
  return map;
}

// Применяет сохранение к отчёту. Если сохраняет тимлид чужой отчёт — помечаем
// добавленные и изменённые задачи и запоминаем удалённые, чтобы райтер увидел правки.
function applySave(report, projectsInput, editor, now = new Date().toISOString()) {
  const projects = sanitizeProjects(projectsInput);
  const before = indexTasks(report.projects || []);
  const leadEdit = editor.role === 'lead' && editor.email !== report.author;
  const seen = new Set();

  for (const p of projects) {
    for (const s of p.streams) {
      for (const key of SECTIONS) {
        for (const t of s.sections[key]) {
          seen.add(t.id);
          const prev = before.get(t.id);
          const prevTask = prev && prev.task;
          const changed = !prevTask || prevTask.text !== t.text || (prevTask.due || '') !== (t.due || '');
          if (leadEdit) {
            if (!prevTask) {
              t.leadEdit = { by: editor.email, at: now, added: true };
            } else if (changed) {
              const base = prevTask.leadEdit;
              t.leadEdit = base && base.added
                ? { by: editor.email, at: now, added: true }
                : {
                    by: editor.email,
                    at: now,
                    prevText: base ? base.prevText : prevTask.text,
                    prevDue: base ? base.prevDue : prevTask.due || '',
                  };
            } else if (prevTask.leadEdit) {
              t.leadEdit = prevTask.leadEdit;
            }
          } else if (prevTask && !changed && prevTask.leadEdit) {
            // Райтер не трогал задачу — отметка о правке тимлида остаётся видимой.
            t.leadEdit = prevTask.leadEdit;
          }
        }
      }
    }
  }

  const removedByLead = (report.removedByLead || []).slice();
  if (leadEdit) {
    for (const [id, info] of before) {
      if (seen.has(id)) continue;
      removedByLead.push({
        text: info.task.text,
        section: info.section,
        project: info.project,
        stream: info.stream,
        by: editor.email,
        at: now,
      });
    }
  }

  return {
    ...report,
    projects,
    removedByLead: removedByLead.slice(-LIMITS.removedLog),
    version: (report.version || 0) + 1,
    updatedAt: now,
    updatedBy: editor.email,
  };
}

function findTask(report, taskId) {
  const hit = indexTasks(report.projects || []).get(taskId);
  return hit ? hit.task : null;
}

function cleanComment(text) {
  return cleanMultiline(text, LIMITS.comment);
}

// ---------- Общий отчёт ----------

function streamKey(name) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function taskLine(task, section) {
  const text = task.text.trim();
  if (section === 'progress' && task.due && task.due.trim()) return `${text} (срок: ${task.due.trim()})`;
  return text;
}

// Объединяет отчёты недели по проектам и стримам. Пустые разделы, стримы и проекты не выводятся.
function buildSummary(reports, projectOrder = []) {
  const projects = new Map();
  for (const report of reports) {
    for (const p of report.projects || []) {
      const projectName = (p.project || '').trim();
      if (!projectName) continue;
      if (!projects.has(projectName)) projects.set(projectName, new Map());
      const streams = projects.get(projectName);
      for (const s of p.streams || []) {
        const key = streamKey(s.name || '');
        if (!streams.has(key)) {
          streams.set(key, { name: (s.name || '').trim(), ...Object.fromEntries(SECTIONS.map((k) => [k, []])) });
        }
        const target = streams.get(key);
        for (const section of SECTIONS) {
          for (const t of (s.sections && s.sections[section]) || []) {
            if (t.text && t.text.trim()) target[section].push(taskLine(t, section));
          }
        }
      }
    }
  }

  const order = (name) => {
    const i = projectOrder.indexOf(name);
    return i === -1 ? projectOrder.length : i;
  };
  return [...projects.entries()]
    .map(([project, streams]) => ({
      project,
      streams: [...streams.values()].filter((s) => SECTIONS.some((k) => s[k].length)),
    }))
    .filter((p) => p.streams.length)
    .sort((a, b) => order(a.project) - order(b.project) || a.project.localeCompare(b.project, 'ru'));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SUMMARY_TITLE = '🔹 UX Writers';

// HTML для вставки в Confluence: заголовки проектов и стримов, подзаголовки разделов, маркированные списки.
function summaryToHtml(tree) {
  const out = [`<h2>${escapeHtml(SUMMARY_TITLE)}</h2>`];
  for (const p of tree) {
    out.push(`<h3>${escapeHtml(p.project)}</h3>`);
    for (const s of p.streams) {
      if (s.name) out.push(`<h4>${escapeHtml(s.name)}</h4>`);
      for (const key of SECTIONS) {
        if (!s[key].length) continue;
        out.push(`<p><strong>${SECTION_TITLES[key]}</strong></p>`);
        out.push(`<ul>${s[key].map((line) => `<li>${escapeHtml(line).replace(/\n/g, '<br>')}</li>`).join('')}</ul>`);
      }
    }
  }
  return out.join('\n');
}

function summaryToText(tree) {
  const out = [SUMMARY_TITLE];
  for (const p of tree) {
    out.push('', p.project);
    for (const s of p.streams) {
      const indent = s.name ? '    ' : '  ';
      if (s.name) out.push(`  ${s.name}`);
      for (const key of SECTIONS) {
        if (!s[key].length) continue;
        out.push(`${indent}${SECTION_TITLES[key]}`);
        for (const line of s[key]) out.push(`${indent}  • ${line.replace(/\n/g, `\n${indent}    `)}`);
      }
    }
  }
  return out.join('\n');
}

module.exports = {
  SECTIONS,
  SECTION_TITLES,
  LIMITS,
  ValidationError,
  newId,
  isWeekId,
  sanitizeProjects,
  applySave,
  findTask,
  cleanComment,
  buildSummary,
  summaryToHtml,
  summaryToText,
  escapeHtml,
};
