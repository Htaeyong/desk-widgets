// The AI chat widget's settings on this PC. The API key is never here: it lives in the secret store (ctx.secrets).
const path = require('path');

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', cost: '작은 작업 약 $0.08, 중간 작업 약 $0.71 (추정)' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', cost: '작은 작업 약 $0.04, 중간 작업 약 $0.36 (추정)' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', cost: '작은 작업 $0.01 미만, 중간 작업 약 $0.02 (추정)' },
];

// What the screen offers. The runner refuses everything else; there is no way to ask for more here (design 8.2).
const MODES = [
  { id: 'auto', label: '자동 판단 (기본)' },
  { id: 'default', label: '수동: 필요할 때마다 묻기' },
  { id: 'acceptEdits', label: '파일 수정만 자동' },
  { id: 'plan', label: '계획만 세우기' },
];

const KEEP_DAYS = [7, 30, 90, 0]; // 0: only when deleted by hand
// Notices a person may put off for a week (#129). Anything about safety, money, a refusal or an error is not here and always shows.
const SNOOZABLE = ['folder-boundary', 'widget-tools', 'unverified-version'];
const SNOOZE_MS = 7 * 86400000;
// The conversation list's width in the chat window (#129): narrow by default, the user drags it wider or narrower.
const SIDE_WIDTH = { default: 180, min: 140, max: 360 };
const MAX_KNOWN_FOLDERS = 200;

const DEFAULTS = {
  model: MODELS[0].id,
  modelChosen: false,
  mode: 'auto',
  workDir: '',
  knownFolders: [],
  keepDays: 30,
  maxConcurrent: 1,
  writeGuard: true,
  cardTimeoutMinutes: 0,
  sideWidth: SIDE_WIDTH.default,
  sideCollapsed: false,
  attachNoticeSeen: false,
  noticeSnooze: {},
  monthlyBudgetUsd: 20,
  taskCapUsd: 3,
  resetDay: 1,
  consent: null,
};

/** Documents\Desk Widgets\AI 대화. Kept when the widget was renamed AI Widgets: sessions and confirmed folders point here. */
const defaultWorkDir = (documents) => path.join(documents, 'Desk Widgets', 'AI 대화');

const folderKey = (dir) => path.resolve(String(dir)).toLowerCase();

const money = (value, fallback, max) => {
  const n = Number(value);
  return n > 0 && n <= max ? Math.round(n * 100) / 100 || fallback : fallback;
};

function sanitize(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const consent = v.consent && typeof v.consent === 'object' && Number.isInteger(v.consent.version)
    ? { version: v.consent.version, at: String(v.consent.at || '') }
    : null;
  return {
    model: MODELS.some((m) => m.id === v.model) ? v.model : DEFAULTS.model,
    modelChosen: v.modelChosen === true,
    mode: MODES.some((m) => m.id === v.mode) ? v.mode : DEFAULTS.mode,
    workDir: typeof v.workDir === 'string' && path.isAbsolute(v.workDir) ? v.workDir : '',
    knownFolders: Array.isArray(v.knownFolders) ? v.knownFolders.filter((d) => typeof d === 'string').slice(-MAX_KNOWN_FOLDERS) : [],
    keepDays: KEEP_DAYS.includes(v.keepDays) ? v.keepDays : DEFAULTS.keepDays,
    maxConcurrent: [1, 2, 3].includes(v.maxConcurrent) ? v.maxConcurrent : DEFAULTS.maxConcurrent,
    writeGuard: v.writeGuard !== false,
    cardTimeoutMinutes: v.cardTimeoutMinutes === 30 ? 30 : 0,
    sideWidth: Number.isFinite(v.sideWidth) ? Math.round(Math.min(SIDE_WIDTH.max, Math.max(SIDE_WIDTH.min, v.sideWidth))) : SIDE_WIDTH.default,
    sideCollapsed: v.sideCollapsed === true,
    attachNoticeSeen: v.attachNoticeSeen === true,
    noticeSnooze: Object.fromEntries(SNOOZABLE.filter((k) => Number.isFinite(v.noticeSnooze?.[k])).map((k) => [k, v.noticeSnooze[k]])),
    monthlyBudgetUsd: money(v.monthlyBudgetUsd, DEFAULTS.monthlyBudgetUsd, 100000),
    taskCapUsd: money(v.taskCapUsd, DEFAULTS.taskCapUsd, 1000),
    resetDay: Number.isInteger(v.resetDay) && v.resetDay >= 1 && v.resetDay <= 28 ? v.resetDay : DEFAULTS.resetDay,
    consent,
  };
}

module.exports = { MODELS, MODES, KEEP_DAYS, SIDE_WIDTH, SNOOZABLE, SNOOZE_MS, DEFAULTS, defaultWorkDir, folderKey, sanitize };
