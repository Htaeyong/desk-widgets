// Clock section of the settings window (see engine/renderer/widget-settings.js for the panel contract).
// The theme list, background opacity, preview and theme folder are the engine's theme section (#59, #60).
(() => {
  let root = null;
  const $ = (id) => root.querySelector(`#${id}`);

  function fill(values) {
    $('clockShowSeconds').checked = Boolean(values.showSeconds);
    $('clockHour12').checked = Boolean(values.hour12);
    $('clockAlwaysOnTop').checked = Boolean(values.alwaysOnTop);
    $('clockTools').checked = Boolean(values.tools);
  }

  window.settingsShell.registerPanel('clock', {
    init(panelRoot, values, api) {
      root = panelRoot;
      fill(values);
      // Saving adds the section's { themeId, themeOpacity } to read().
      api.mountThemePicker($('clockThemes'), { themeId: values.themeId, themeOpacity: values.themeOpacity });
      // The right-click menu can change these while this window is open.
      api.onEvent('settings-changed', fill);
    },
    validate: () => null,
    read: () => ({
      showSeconds: $('clockShowSeconds').checked,
      hour12: $('clockHour12').checked,
      alwaysOnTop: $('clockAlwaysOnTop').checked,
      tools: $('clockTools').checked,
    }),
  });
})();
