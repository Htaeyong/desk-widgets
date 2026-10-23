// Pure stopwatch / timer math (#45). Shared by the widget's main code (require) and the clock page (<script>),
// so it has no dependencies. State is start timestamps + accumulated ms (Date.now() based), never per-tick counters.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TimerModel = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const MIN_SECONDS = 1;
  const MAX_SECONDS = 23 * 3600 + 59 * 60 + 59;
  const DEFAULT_PRESETS = [180, 300, 600];
  const DEFAULT_TIMER_SECONDS = 300;
  const TABS = ['clock', 'stopwatch', 'timer', 'alarm'];

  const num = (v) => (Number.isFinite(v) ? v : 0);
  const stamp = (v) => (Number.isFinite(v) && v > 0 ? v : null);

  /** Whole seconds within 1s..23:59:59, or the fallback when the value is not a number. */
  function clampSeconds(value, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || value === null || value === '' || typeof value === 'boolean') return fallback;
    return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, n));
  }

  /** Exactly three preset slots in seconds; a bad slot gets its default. */
  function sanitizePresets(value) {
    const src = Array.isArray(value) ? value : [];
    return DEFAULT_PRESETS.map((d, i) => clampSeconds(src[i], d));
  }

  // ---- stopwatch: { startedAt: epoch ms | null, elapsed: ms accumulated before startedAt } ----
  const STOPWATCH = { startedAt: null, elapsed: 0 };
  const swRunning = (sw) => sw.startedAt !== null;
  const swElapsed = (sw, now) => sw.elapsed + (swRunning(sw) ? Math.max(0, now - sw.startedAt) : 0);
  const swStart = (sw, now) => (swRunning(sw) ? sw : { ...sw, startedAt: now });
  const swPause = (sw, now) => (swRunning(sw) ? { startedAt: null, elapsed: swElapsed(sw, now) } : sw);
  const swReset = () => ({ ...STOPWATCH });
  const sanitizeStopwatch = (v) => {
    const src = v && typeof v === 'object' ? v : {};
    return { startedAt: stamp(src.startedAt), elapsed: Math.max(0, num(src.elapsed)) };
  };

  // ---- timer: { duration: ms, startedAt: epoch ms | null, elapsed: ms run before startedAt, done } ----
  const TIMER = { duration: DEFAULT_TIMER_SECONDS * 1000, startedAt: null, elapsed: 0, done: false };
  const tmRunning = (t) => t.startedAt !== null;
  const tmRemaining = (t, now) => Math.max(0, t.duration - t.elapsed - (tmRunning(t) ? Math.max(0, now - t.startedAt) : 0));
  function tmStatus(t) {
    if (t.done) return 'done';
    if (tmRunning(t)) return 'running';
    return t.elapsed > 0 ? 'paused' : 'idle';
  }
  /** Resumes a paused timer; otherwise starts a fresh run of `seconds` (or of the last duration). */
  function tmStart(t, now, seconds) {
    if (tmRunning(t)) return t;
    if (tmStatus(t) === 'paused') return { ...t, startedAt: now };
    const duration = seconds === undefined ? t.duration : clampSeconds(seconds, t.duration / 1000) * 1000;
    return { duration, startedAt: now, elapsed: 0, done: false };
  }
  const tmPause = (t, now) => (tmRunning(t) ? { ...t, startedAt: null, elapsed: t.duration - tmRemaining(t, now) } : t);
  const tmReset = (t) => ({ duration: t.duration, startedAt: null, elapsed: 0, done: false });
  const tmFinish = (t) => ({ duration: t.duration, startedAt: null, elapsed: t.duration, done: true });
  /** A running timer whose time is up (main fires the alarm). */
  const tmIsOver = (t, now) => tmRunning(t) && tmRemaining(t, now) <= 0;
  function sanitizeTimer(v) {
    const src = v && typeof v === 'object' ? v : {};
    const duration = num(src.duration) > 0 ? clampSeconds(src.duration / 1000, DEFAULT_TIMER_SECONDS) * 1000 : TIMER.duration;
    return { duration, startedAt: stamp(src.startedAt), elapsed: Math.min(duration, Math.max(0, num(src.elapsed))), done: src.done === true };
  }

  // ---- text ----
  const pad = (n) => String(n).padStart(2, '0');
  /** Stopwatch display: mm:ss.cc, h:mm:ss.cc from one hour. */
  function formatStopwatch(ms) {
    const cs = Math.floor(Math.max(0, ms) / 10);
    const h = Math.floor(cs / 360000);
    const m = Math.floor(cs / 6000) % 60;
    const s = Math.floor(cs / 100) % 60;
    const rest = `${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
    return h ? `${h}:${rest}` : rest;
  }
  /** Timer display: remaining time rounded up to the second, mm:ss or h:mm:ss. */
  function formatRemaining(ms) {
    const total = Math.ceil(Math.max(0, ms) / 1000);
    const h = Math.floor(total / 3600);
    const rest = `${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
    return h ? `${h}:${rest}` : rest;
  }
  /** Korean duration words: 90 -> "1분 30초", 3600 -> "1시간". */
  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const parts = [];
    if (total >= 3600) parts.push(`${Math.floor(total / 3600)}시간`);
    if (total % 3600 >= 60) parts.push(`${Math.floor(total / 60) % 60}분`);
    if (total % 60 || !parts.length) parts.push(`${total % 60}초`);
    return parts.join(' ');
  }
  const splitSeconds = (s) => ({ h: Math.floor(s / 3600), m: Math.floor(s / 60) % 60, s: s % 60 });
  // ---- hour / minute / second input fields (timer and alarm, #51) ----
  /** What a field keeps while typing: digits only, at most two. */
  const typedDigits = (text) => String(text ?? '').replace(/\D/g, '').slice(0, 2);
  /** The field's number, clamped to 0..max (empty or junk -> 0). */
  function fieldValue(text, max) {
    const n = parseInt(typedDigits(text), 10);
    return Number.isFinite(n) ? Math.min(max, n) : 0;
  }
  /** What a field shows after leaving it: the clamped number, zero-padded (7 -> "07"). */
  const fieldText = (text, max) => pad(fieldValue(text, max));

  /** Short time for a tab badge: 0:05, 12:34, 1:02:03. */
  function formatShort(seconds) {
    const { h, m, s } = splitSeconds(Math.max(0, seconds));
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // ---- tab badges (#50): what a stopwatch / timer tab shows while the user is on another tab ----
  /** null while idle; else { state: 'running' | 'paused', text: elapsed time }. */
  function swBadge(sw, now) {
    const ms = swElapsed(sw, now);
    if (!swRunning(sw) && ms === 0) return null;
    return { state: swRunning(sw) ? 'running' : 'paused', text: formatShort(Math.floor(ms / 1000)) };
  }
  /** null while idle or finished; else { state: 'running' | 'paused', text: remaining time (rounded up like the screen) }. */
  function tmBadge(t, now) {
    const status = tmStatus(t);
    if (status !== 'running' && status !== 'paused') return null;
    return { state: status, text: formatShort(Math.ceil(tmRemaining(t, now) / 1000)) };
  }
  /** Ms until a running badge's text changes (never 0), or null when no badge is running. */
  function badgeDelay(sw, t, now) {
    const waits = [];
    if (swRunning(sw)) waits.push(1000 - (swElapsed(sw, now) % 1000));
    if (tmRunning(t) && tmRemaining(t, now) > 0) waits.push(tmRemaining(t, now) % 1000 || 1000);
    return waits.length ? Math.min(...waits) : null;
  }

  return {
    MIN_SECONDS,
    MAX_SECONDS,
    DEFAULT_PRESETS,
    DEFAULT_TIMER_SECONDS,
    TABS,
    STOPWATCH,
    TIMER,
    clampSeconds,
    sanitizePresets,
    swRunning,
    swElapsed,
    swStart,
    swPause,
    swReset,
    sanitizeStopwatch,
    tmRunning,
    tmRemaining,
    tmStatus,
    tmStart,
    tmPause,
    tmReset,
    tmFinish,
    tmIsOver,
    sanitizeTimer,
    formatStopwatch,
    formatRemaining,
    formatDuration,
    splitSeconds,
    formatShort,
    typedDigits,
    fieldValue,
    fieldText,
    swBadge,
    tmBadge,
    badgeDelay,
  };
});
