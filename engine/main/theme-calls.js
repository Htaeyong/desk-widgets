// What a theme of a widget with its own theme contract may call (#57): only the methods and events the widget
// declares in ctx.useThemes({ methods, events }). No Electron dependency (unit-testable).
//
// methods: { 'timer.start': fn | { run: fn, preview?: 'deny' | 'noop' | 'allow', gesture?: boolean } }
//   run(entry, ...args) gets the calling page ({ frame, instanceId, preview, theme }) first.
//   preview: what happens when the theme preview calls it (default 'deny': { ok: false, message }).
//   gesture: only right after a click or key press in the theme (checked by the preload, which the theme cannot change).
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}(\.[a-zA-Z][a-zA-Z0-9]{0,31}){0,3}$/;
const EVENT_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,31}$/;
const PREVIEW_RULES = new Set(['deny', 'noop', 'allow']);
const MAX_ARGS_BYTES = 64 * 1024;
const PREVIEW_MESSAGE = '미리보기에서는 쓸 수 없습니다.';

/** Checks the widget's declarations (a mistake is the widget author's, so it throws). */
function normalizeMethods(methods = {}) {
  const table = new Map();
  for (const [name, decl] of Object.entries(methods)) {
    if (!NAME_RE.test(name)) throw new Error(`theme method name "${name}" is not valid`);
    const spec = typeof decl === 'function' ? { run: decl } : decl;
    if (!spec || typeof spec.run !== 'function') throw new Error(`theme method "${name}" needs a function`);
    const preview = spec.preview === undefined ? 'deny' : spec.preview;
    if (!PREVIEW_RULES.has(preview)) throw new Error(`theme method "${name}": preview must be deny, noop or allow`);
    table.set(name, { run: spec.run, preview, gesture: spec.gesture === true });
  }
  // "timer" and "timer.start" cannot both exist: the theme API is built as nested objects.
  for (const name of table.keys()) {
    const parts = name.split('.');
    for (let i = 1; i < parts.length; i++) {
      if (table.has(parts.slice(0, i).join('.'))) throw new Error(`theme method "${name}" is inside method "${parts.slice(0, i).join('.')}"`);
    }
  }
  return table;
}

function normalizeEvents(events = []) {
  if (!Array.isArray(events)) throw new Error('theme events must be an array of names');
  for (const e of events) if (typeof e !== 'string' || !EVENT_RE.test(e)) throw new Error(`theme event name "${e}" is not valid`);
  return [...new Set(events)];
}

/** What the preload gets to build window.widget: method names (with the gesture rule) and event names. */
function describe(table, events) {
  return { methods: [...table].map(([name, m]) => ({ name, gesture: m.gesture })), events };
}

const fail = (message) => ({ ok: false, message });

/** Bytes of the arguments as the IPC carries them (structured clone; JSON is a close enough measure). */
function argsSize(args) {
  try {
    return Buffer.byteLength(JSON.stringify(args) || '');
  } catch {
    return Infinity;
  }
}

/**
 * Runs one call from a theme page. Unknown names, oversized arguments, preview rules and a missing gesture are
 * answered here; the widget's function only sees allowed calls. A thrown error becomes { ok: false, message }.
 * @param {Map} table  normalizeMethods()
 * @param {{ frame: string, instanceId: string|null, preview: boolean, theme: object }} entry
 * @param {{ activated?: boolean }} info  activated: the preload saw a user gesture
 */
async function dispatch(table, name, args, entry, info = {}) {
  const method = typeof name === 'string' ? table.get(name) : null;
  if (!method) return fail(`지원하지 않는 호출입니다: ${String(name).slice(0, 64)}`);
  const list = Array.isArray(args) ? args : [];
  if (argsSize(list) > MAX_ARGS_BYTES) return fail('보낸 값이 너무 큽니다.');
  if (entry.preview) {
    if (method.preview === 'deny') return fail(PREVIEW_MESSAGE);
    if (method.preview === 'noop') return null;
  }
  if (method.gesture && info.activated !== true) return fail('클릭이나 키 입력으로만 할 수 있습니다.');
  try {
    const result = await method.run(entry, ...list);
    return result === undefined ? null : result;
  } catch (err) {
    return fail(err?.message || String(err));
  }
}

module.exports = { normalizeMethods, normalizeEvents, describe, dispatch, MAX_ARGS_BYTES, PREVIEW_MESSAGE };
