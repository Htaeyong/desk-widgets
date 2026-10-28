// Notes made by other widgets (#111, design 8.2): Dooray / Mail "할 일로 추가" -> one note with the item's text,
// and the to-do widget's import (design 9.4). Pure: what the note file holds; index.js creates it.
const D = require('./dates');
const md = require('./markdown');
const F = require('./files');

const MAX_BODY = 20000;
const SOURCES = { dooray: '두레이', mail: '메일' };

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\/[^\s<>()]+$/i.test(v) && v.length <= 2048 ? v : null);

/** "dueAt (ms) + dateOnly" (the to-do widget's / the integrations' form) -> due. */
function dueFromMs(dueAt, dateOnly) {
  if (dueAt === null || dueAt === undefined) return null;
  if (!Number.isSafeInteger(dueAt) || dueAt <= 0) return undefined; // invalid
  const d = new Date(dueAt);
  const date = D.todayOf(dueAt);
  return dateOnly ? { date, time: null } : { date, time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` };
}

/** Text cut to MAX_BODY characters with a note that the source has more. */
function cut(text) {
  const s = String(text || '');
  return s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}\n\n…(원본에서 계속)` : s;
}

/** Markdown-ish text from HTML, crude on purpose: tags out, entities of the common kind back. It is shown as text. */
function htmlText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * The note for an item from Dooray / Mail: { title, body, fm } or { error }. input:
 *   { title, dueAt?, dateOnly?, body?, bodyFormat?: 'markdown' | 'text' | 'html', details?: string[],
 *     attachments?: string[], source: { itemId, url?, label? } }
 * Dooray bodies are Markdown (kept, and shown through the note's own sanitizer); mail bodies are plain text, kept
 * line by line. Images and attachments are never copied (names only).
 */
function externalNote(sourceId, input) {
  if (!SOURCES[sourceId]) return { error: '알 수 없는 출처입니다.' };
  const itemId = clean(input?.source?.itemId, 256);
  if (!itemId) return { error: '원본 항목이 없습니다.' };
  const title = clean(input?.title, 200) || '(제목 없음)';
  const due = dueFromMs(input?.dueAt ?? null, input?.dateOnly === true);
  if (due === undefined) return { error: '마감 날짜가 올바르지 않습니다.' };
  const url = httpsUrl(input?.source?.url);
  const details = (Array.isArray(input?.details) ? input.details : []).map((d) => clean(d, 120)).filter(Boolean).slice(0, 6);
  const info = [url ? `[${SOURCES[sourceId]}에서 열기](${url})` : '', ...details.map(escapeLine)].filter(Boolean).join(' · ');
  const format = input?.bodyFormat === 'markdown' ? 'markdown' : input?.bodyFormat === 'html' ? 'html' : 'text';
  const rawBody = cut(clean(input?.body, MAX_BODY + 1000));
  const bodyText = !rawBody ? '' : format === 'markdown' ? rawBody : md.textToMarkdown(format === 'html' ? htmlText(rawBody) : rawBody);
  const files = (Array.isArray(input?.attachments) ? input.attachments : []).map((a) => clean(a, 200)).filter(Boolean).slice(0, 50);
  const parts = [`# ${escapeLine(title)}`];
  if (info) parts.push(info);
  if (bodyText.trim()) parts.push('---', bodyText.trim());
  if (files.length) parts.push(`첨부 (원본에 있음): ${files.map(escapeLine).join(', ')}`);
  const fm = {};
  if (due) fm.due = D.formatDueValue(due);
  fm.source = sourceId;
  fm['source-id'] = itemId;
  if (url) fm['source-url'] = url;
  return { title: F.sanitizeTitle(title), body: `${parts.join('\n\n')}\n`, fm };
}

/** A line of plain text that Markdown must not read as formatting (brackets, stars, a leading # ...). */
function escapeLine(s) {
  return String(s).replace(/([\\`*_[\]<>|~])/g, '\\$1').replace(/^([#>+-]|\d+[.)])/, '\\$1');
}

/**
 * What importing the frozen to-do widget makes (design 9.4), from the engine's copy of its data
 * ({ lists, tasks }, engine/main/widgets.js legacyTodo): [{ title, body, fm, folder, kind: 'task' | 'list' }].
 * - a task with a date or a weekly repeat -> one note (due, "매주 X", its Dooray / Mail link kept)
 * - the tasks without a date -> one checklist note per list ("할 일 - <목록>")
 * - completed tasks only with includeDone (a note in the done folder / a checked line)
 * `has(sourceId)`: a note with "source: todo" and this "source-id" exists (nothing is imported twice).
 */
function importPlan(data, { includeDone = false, has = () => false } = {}) {
  const out = [];
  const lists = Array.isArray(data?.lists) ? data.lists : [];
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  for (const list of lists) {
    const own = tasks.filter((t) => t.listId === list.id && (includeDone || !t.completedAt));
    for (const t of own.filter((x) => x.dueAt)) {
      if (has(t.id)) continue;
      const due = dueFromMs(t.dueAt, Boolean(t.dateOnly));
      if (!due) continue;
      const fm = { due: D.formatDueValue(due) };
      if (Number.isInteger(t.repeatWeekday)) fm.repeat = `매주 ${D.WD[t.repeatWeekday]}`;
      if (t.completedAt && !fm.repeat) fm.completed = D.stampOf(t.completedAt);
      fm.source = 'todo';
      fm['source-id'] = t.id;
      const url = httpsUrl(t.source?.url);
      if (url) fm['source-url'] = url;
      const link = url ? `\n\n[${SOURCES[t.source.widgetId] || '원본'}에서 열기](${url})` : '';
      out.push({ kind: 'task', title: F.sanitizeTitle(t.title), body: `# ${escapeLine(t.title)}${link}\n`, fm, folder: fm.completed ? 'done' : 'notes' });
    }
    const undated = own.filter((x) => !x.dueAt);
    const key = `list-${list.id}`;
    if (!undated.length || has(key)) continue;
    const name = list.name || '할 일';
    out.push({
      kind: 'list',
      title: F.sanitizeTitle(`할 일 - ${name}`),
      body: `# 할 일 - ${escapeLine(name)}\n\n${undated.map((t) => `- [${t.completedAt ? 'x' : ' '}] ${escapeLine(t.title)}`).join('\n')}\n`,
      fm: { source: 'todo', 'source-id': key },
      folder: 'notes',
    });
  }
  return out;
}

module.exports = { externalNote, importPlan, dueFromMs, htmlText, escapeLine, MAX_BODY, SOURCES };
