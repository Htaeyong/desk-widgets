// The engine loads this script after inserting the widget's settings fragment.
(() => {
  let root = null;
  let labels = {};
  let integrationState = {};
  const $ = (id) => root.querySelector(`#${id}`);
  const configurations = [
    ['todoReceiveDooray', 'todoDoorayRequirements', 'dooray', 'doorayName'],
    ['todoReceiveMail', 'todoMailRequirements', 'mail', 'mailName'],
    ['todoShareCalendar', 'todoCalendarRequirements', 'calendar', 'calendarName'],
  ];
  function renderRequirements() {
    for (const [checkboxId, containerId, key, nameKey] of configurations) {
      const container = $(containerId);
      container.hidden = !$(checkboxId).checked;
      if (container.hidden) continue;
      const status = integrationState[key] || {};
      const name = labels[nameKey] || key;
      const checks = [
        [status.brokerAvailable, labels.requiresEngine],
        [status.installed && status.enabled && status.running, (labels.requiresPeer || '').replace('{widget}', name)],
        [status.compatible, (labels.requiresFeature || '').replace('{widget}', name)],
        [status.peerEnabled, labels.integrationPeerSetting],
      ];
      const versions = (labels.integrationVersion || '').replace('{engineVersion}', status.engineVersion || '—')
        .replace('{engineApi}', status.engineApi || '—').replace('{widgetVersion}', status.widgetVersion || '—');
      container.textContent = `${checks.map(([good, title]) => `${good ? '✓' : '✗'} ${title}`).join(' · ')}\n${versions}\n${labels[status.reason] || labels.integrationEngine}`;
      container.style.whiteSpace = 'pre-line';
    }
  }
  function fill(values) {
    labels = values.labels || labels;
    root.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = labels[node.dataset.i18n] || node.dataset.i18n; });
    $('todoAlwaysOnTop').checked = Boolean(values.alwaysOnTop);
    $('todoSnoozeMinutes').value = values.snoozeMinutes;
    $('todoReceiveDooray').checked = Boolean(values.receiveDooray);
    $('todoReceiveMail').checked = Boolean(values.receiveMail);
    $('todoShareCalendar').checked = Boolean(values.shareCalendar);
    integrationState = values.integrationStatus || {};
    renderRequirements();
  }
  window.settingsShell.registerPanel('todo', {
    init(panelRoot, values, api) {
      root = panelRoot;
      fill(values);
      for (const [checkboxId] of configurations) $(checkboxId).addEventListener('change', renderRequirements);
      api.mountThemePicker($('todoThemes'), { themeId: values.themeId, themeOpacity: values.themeOpacity });
      api.onEvent('settings-changed', fill);
      api.onEvent('integration-status', (next) => { integrationState = next || {}; renderRequirements(); });
    },
    validate: () => {
      const value = Number($('todoSnoozeMinutes').value);
      return Number.isInteger(value) && value >= 1 && value <= 120 ? null : labels.invalidSnooze;
    },
    read: () => ({ alwaysOnTop: $('todoAlwaysOnTop').checked, snoozeMinutes: Number($('todoSnoozeMinutes').value),
      receiveDooray: $('todoReceiveDooray').checked, receiveMail: $('todoReceiveMail').checked,
      shareCalendar: $('todoShareCalendar').checked }),
  });
})();
