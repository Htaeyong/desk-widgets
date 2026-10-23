// Condition alerts ("조건 알림"): user rules checked on a schedule, e.g.
// "notify me if no daily report was registered yesterday in these projects".
// Rules and their per-day state live in <userData>/widgets/dooray/rules.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const MAX_RULES = 50;

class RuleError extends Error {}

// ---------- pure helpers (unit-tested) ----------

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar day as "YYYY-MM-DD". */
function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

const isWeekend = (date) => date.getDay() === 0 || date.getDay() === 6;

function dayLabel(date) {
  return `${date.getMonth() + 1}/${date.getDate()}(${WEEKDAYS[date.getDay()]})`;
}

/** Whether the rule runs on this calendar day. */
function isCheckDay(rule, now) {
  return rule.days === 'everyday' || !isWeekend(now);
}

/** Today's scheduled check time. */
function checkTimeOn(rule, now) {
  const [h, m] = rule.time.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  return at;
}

/**
 * The time window whose registrations the rule counts.
 * yesterday: the previous day, or with "weekdays" the previous weekday (Monday -> Friday).
 * today: from midnight until now.
 */
function periodFor(rule, now) {
  const today = startOfDay(now);
  if (rule.period === 'today') return { from: today, to: new Date(now), label: `오늘 ${dayLabel(today)}` };
  let day = new Date(today.getTime() - DAY_MS);
  if (rule.days !== 'everyday') {
    while (isWeekend(day)) day = new Date(day.getTime() - DAY_MS);
  }
  // Rebuild from calendar parts so DST-free local midnight is exact.
  day = startOfDay(day);
  const next = new Date(day);
  next.setDate(next.getDate() + 1);
  return { from: day, to: next, label: dayLabel(day) };
}

/**
 * Whether the rule should be checked now.
 * Runs once a day after its check time (also when the PC was off or away at that time),
 * then again every repeatMinutes until the condition is met.
 */
function isDue(rule, state, now) {
  if (!rule.enabled || !rule.projectIds.length || !isCheckDay(rule, now)) return false;
  if (now < checkTimeOn(rule, now)) return false;
  const today = dayKey(now);
  if (!state || state.date !== today) return true;
  if (state.resolved || !rule.repeatMinutes) return false;
  return now.getTime() - Date.parse(state.lastAlertAt || state.lastCheckedAt) >= rule.repeatMinutes * 60 * 1000;
}

/**
 * Counts registrations per project and lists the projects below the minimum.
 * @param {object[]} posts      raw posts created in the period (any state)
 * @param {(tagId: string) => string|undefined} tagName  resolves tag ids to names
 */
function evaluate(rule, posts, { projectName = (id) => id, tagName = () => undefined } = {}) {
  const needle = rule.tag.trim().toLowerCase();
  const counts = Object.fromEntries(rule.projectIds.map((id) => [id, 0]));
  for (const post of posts) {
    const pid = String(post.project?.id ?? '');
    if (!(pid in counts)) continue;
    if (needle && !(post.tags || []).some((t) => (tagName(String(t.id)) || '').toLowerCase().includes(needle))) continue;
    counts[pid]++;
  }
  const missing = rule.projectIds
    .filter((id) => counts[id] < rule.minCount)
    .map((id) => ({ id, name: projectName(id), count: counts[id] }));
  return { counts, missing };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validates and normalizes rule input from the manager window. */
function sanitizeRule(input, existing = {}) {
  const r = { ...existing, ...input };
  const name = String(r.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new RuleError('규칙 이름을 입력해 주세요.');
  if (name.length > 40) throw new RuleError('규칙 이름은 40자 이하로 입력해 주세요.');
  const projectIds = [...new Set((Array.isArray(r.projectIds) ? r.projectIds : []).map(String))].filter((id) => /^[\w-]{1,64}$/.test(id));
  if (!projectIds.length) throw new RuleError('확인할 프로젝트를 하나 이상 선택해 주세요.');
  const time = String(r.time || '09:30');
  if (!TIME.test(time)) throw new RuleError('확인 시각 형식이 올바르지 않습니다 (예: 09:30).');
  const minCount = Math.round(Number(r.minCount));
  return {
    id: existing.id || r.id || `r-${crypto.randomUUID().slice(0, 8)}`,
    type: 'noNewTasks',
    name,
    enabled: r.enabled !== false,
    projectIds,
    minCount: Number.isFinite(minCount) ? Math.min(100, Math.max(1, minCount)) : 1,
    period: r.period === 'today' ? 'today' : 'yesterday',
    tag: String(r.tag || '').trim().slice(0, 40),
    time,
    days: r.days === 'everyday' ? 'everyday' : 'weekdays',
    repeatMinutes: [0, 30, 60, 120, 240].includes(Number(r.repeatMinutes)) ? Number(r.repeatMinutes) : 0,
  };
}

// ---------- storage ----------

class RuleStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = { rules: Array.isArray(raw.rules) ? raw.rules : [], state: raw.state && typeof raw.state === 'object' ? raw.state : {} };
    } catch {
      this.data = { rules: [], state: {} };
    }
    return this.data;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  rules() {
    return this.load().rules;
  }

  stateOf(id) {
    return this.load().state[id] || null;
  }

  /** Creates or updates a rule. Changing a rule resets today's state so it is checked again. */
  save(input) {
    const data = this.load();
    const i = data.rules.findIndex((r) => r.id === input.id);
    if (i < 0 && data.rules.length >= MAX_RULES) throw new RuleError(`규칙은 최대 ${MAX_RULES}개까지 만들 수 있습니다.`);
    const rule = sanitizeRule(input, i >= 0 ? data.rules[i] : {});
    if (i >= 0) data.rules[i] = rule;
    else data.rules.push(rule);
    delete data.state[rule.id];
    this.persist();
    return rule;
  }

  remove(id) {
    const data = this.load();
    data.rules = data.rules.filter((r) => r.id !== id);
    delete data.state[id];
    this.persist();
  }

  setState(id, state) {
    this.load().state[id] = state;
    this.persist();
  }
}

module.exports = {
  RuleStore,
  RuleError,
  dayKey,
  isCheckDay,
  checkTimeOn,
  periodFor,
  isDue,
  evaluate,
  sanitizeRule,
};
