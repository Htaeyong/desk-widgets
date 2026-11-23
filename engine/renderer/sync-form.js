// The sync tab's options form (#134): the engine sends its saved state on every check (start and end of each
// automatic check, a change on another PC, a local edit). Those updates must not put back checkboxes the user
// changed but has not saved yet, or "설정 저장" would save the old choice (a widget the user turned off kept
// syncing). "지금 동기화" saves such changes first, so a check never runs with a choice the screen does not show.
// No DOM here (unit-tested in Node).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncForm = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  function createSyncForm() {
    let edited = false;
    return {
      /** The user changed a field (folder, PC name, widget checkboxes, always confirm, interval). */
      edit() { edited = true; },
      /** Saved, connected, turned off or reloaded: the form shows the engine's values again. */
      saved() { edited = false; },
      get edited() { return edited; },
      /** Whether an engine state update may replace the form fields. */
      mayRender({ previewingConnect = false } = {}) { return !previewingConnect && !edited; },
      /** Whether "지금 동기화" must save the form first (only while connected). */
      saveBeforeSync(state) { return Boolean(edited && state?.enabled); },
    };
  }

  return { createSyncForm };
});
