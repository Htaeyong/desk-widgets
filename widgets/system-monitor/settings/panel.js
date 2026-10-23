// The settings shell supplies localization and the shared theme picker.
(() => {
  const text = {
    ko: {
      display: '표시', interval: '측정 간격 (초, 1~10)', history: 'CPU 그래프 기록 (초, 10~300)',
      cores: 'CPU 코어별 사용률 표시', onTop: '항상 위에 표시',
      pause: '위젯이 보이지 않거나 자리를 비우면 측정을 멈춥니다. 지원되지 않는 항목은 화면에 사용 불가로 표시됩니다.',
    },
    en: {
      display: 'Display', interval: 'Sample interval (seconds, 1–10)', history: 'CPU graph history (seconds, 10–300)',
      cores: 'Show CPU use by core', onTop: 'Always on top',
      pause: 'Sampling pauses while the widget is hidden or you are away. Unsupported metrics appear as unavailable.',
    },
  };
  let root;
  const $ = (id) => root.querySelector('#' + id);
  function fill(value) {
    $('systemInterval').value = value.intervalMs / 1000;
    $('systemHistory').value = value.historyMs / 1000;
    $('systemCores').checked = value.showCores;
    $('systemOnTop').checked = value.alwaysOnTop;
  }
  window.settingsShell.registerPanel('system-monitor', {
    init(panel, value, api) {
      root = panel;
      const labels = text[String(value.locale || '').startsWith('ko') ? 'ko' : 'en'];
      for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = labels[node.dataset.i18n];
      fill(value);
      api.mountThemePicker($('systemThemes'), { themeId: value.themeId, themeOpacity: value.themeOpacity });
      api.onEvent('settings-changed', fill);
    },
    validate: () => null,
    read: () => ({
      intervalMs: Number($('systemInterval').value) * 1000,
      historyMs: Number($('systemHistory').value) * 1000,
      showCores: $('systemCores').checked,
      alwaysOnTop: $('systemOnTop').checked,
    }),
  });
})();
