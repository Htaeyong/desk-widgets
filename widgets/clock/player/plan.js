// What the hidden sound page plays (#130): read from its query string, and when to play again. Shared by the page
// (<script>) and the widget's main code / tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SoundPlan = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // Longest a ring may sound, in seconds (settings window choices), and the default.
  const MAX_SECONDS = [30, 60, 120, 300, 600];
  const DEFAULT_MAX_SECONDS = 60;
  const DEFAULT_VOLUME = 80;

  const clamp = (v, min, max, fallback) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

  /** { src, fallback, repeat (0 = until stopped), volume 0..1, until (epoch ms) } from "?src=…&fallback=…&…". */
  function readPlan(search) {
    const q = new URLSearchParams(search);
    const repeat = Number(q.get('repeat'));
    return {
      src: q.get('src') || '',
      fallback: q.get('fallback') || '',
      repeat: Number.isInteger(repeat) && repeat >= 0 && repeat <= 10 ? repeat : 1,
      volume: clamp(Number(q.get('volume')), 0, 1, DEFAULT_VOLUME / 100),
      until: clamp(Number(q.get('until')), 0, Number.MAX_SAFE_INTEGER, 0),
    };
  }

  /** After the sound ended for the `played`-th time: play it again? Never past `until`. */
  const again = (played, repeat, now, until) => now < until && (repeat === 0 || played < repeat);

  return { MAX_SECONDS, DEFAULT_MAX_SECONDS, DEFAULT_VOLUME, readPlan, again };
});
