// A widget's settings window. The widget's settings/panel.js calls
// settingsShell.registerPanel(id, panel):
//   panel.init(root, values, api)  fill the form; api.call(name, ...args), api.onEvent(name, cb)
//   panel.validate() -> message | null
//   panel.read() -> values passed to the widget's settings.save()
// A themed widget can put the engine's theme section in its panel (engine API 1.3, #59):
//   api.mountThemePicker(element, { themeId, themeOpacity })  -> its { themeId, themeOpacity } are saved with read()
const $ = (id) => document.getElementById(id);
let panel = null;
let themePicker = null;

window.settingsShell = {
  registerPanel(_id, p) {
    panel = p;
  },
};

function setStatus(text, kind = '') {
  $('saveResult').textContent = text;
  $('saveResult').className = `status ${kind}`;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), { src });
    script.onload = resolve;
    script.onerror = () => reject(new Error(`cannot load ${src}`));
    document.body.append(script);
  });
}

const listeners = [];
window.widgetSettingsApi.onEvent((name, payload) => {
  for (const l of listeners) if (l.name === name) l.callback(payload);
});
const api = {
  call: (name, ...args) => window.widgetSettingsApi.call(name, ...args),
  onEvent: (name, callback) => listeners.push({ name, callback }),
  /** The engine's theme section (list, opacity, preview, theme folder) inside the panel's element. */
  mountThemePicker: (element, values) => {
    themePicker = window.ThemePicker.mount(element, values, api);
    return themePicker;
  },
};

async function init() {
  const { widget, values, panel: files } = await window.widgetSettingsApi.get();
  document.title = `${widget.name} 설정`;
  $('title').textContent = `${widget.name} 설정`;
  $('version').textContent = widget.version ? `v${widget.version}` : '';
  if (files.style) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: files.style }));
  // The widget's own markup from its installed folder (never theme or remote content).
  $('panel').innerHTML = files.html;
  try {
    await loadScript(files.script);
    panel?.init($('panel'), values, api);
  } catch (err) {
    setStatus(`설정을 불러오지 못했습니다: ${err.message}`, 'err');
  }
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!panel) return;
  const problem = panel.validate?.();
  if (problem) {
    setStatus(problem, 'err');
    return;
  }
  $('save').disabled = true;
  const res = await window.widgetSettingsApi.save({ ...panel.read(), ...(themePicker ? themePicker.read() : {}) });
  $('save').disabled = false;
  if (!res.ok) setStatus(res.message, 'err');
  // On success the main process closes this window.
});

$('cancel').addEventListener('click', () => window.widgetSettingsApi.close());

init();
