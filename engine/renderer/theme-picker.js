// The engine's theme section for a widget's settings window (#59): theme list, description, background opacity
// slider (#55), preview, theme folder, list refresh. A widget panel puts it in with api.mountThemePicker(element,
// { themeId, themeOpacity }); the settings shell adds its values ({ themeId, themeOpacity }) to what is saved.
// The widget's settings.handlers must offer themes / previewTheme / openThemeFolder / liveOpacity
// (host.settingsHandlers() of the engine theme host).
// The model part has no DOM (unit-tested in Node); mount() builds the section with textContent only.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThemePicker = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const OTHER_WIDGET = /^theme for another widget \("([^"]+)"\)$/;

  /** Why a theme cannot be used, in Korean where the engine knows the reason. */
  function problemOf(theme) {
    const other = theme.errors?.map((e) => OTHER_WIDGET.exec(e)).find(Boolean);
    if (other) return `다른 위젯(${other[1]})의 테마입니다.`;
    return `사용할 수 없음: ${(theme.errors || []).join(', ')}`;
  }

  function optionLabel(theme) {
    if (theme.usable) return theme.name;
    return theme.errors?.some((e) => OTHER_WIDGET.test(e)) ? `${theme.name} (다른 위젯 테마)` : `${theme.name} (호환 안 됨)`;
  }

  function describeTheme(theme) {
    if (!theme) return '';
    if (!theme.usable) return problemOf(theme);
    const by = theme.author ? ` · ${theme.author}` : '';
    const src = theme.source === 'user' ? ' · 사용자 테마' : theme.source === 'dev' ? ' · 개발 중' : '';
    return `v${theme.version}${by}${src}${theme.description ? ' — ' + theme.description : ''}`;
  }

  /** The selected theme: the wanted one when usable, else the first usable one (the list has the default first). */
  function pick(themes, wanted) {
    if (themes.some((t) => t.id === wanted && t.usable)) return wanted;
    return themes.find((t) => t.usable)?.id || '';
  }

  /**
   * Opacity per theme in % (#55): saved values, edits made here (null = back to the theme default).
   * Themes declare support and their default with theme.json "background": { "opacity": 0..1 }.
   */
  function createOpacityModel(saved = {}) {
    const edited = {};
    let themes = [];
    const themeOf = (id) => themes.find((t) => t.id === id);
    const defaultOf = (id) => Math.round((themeOf(id)?.background?.opacity ?? 1) * 100);
    return {
      setThemes(list) {
        themes = list;
      },
      supports: (id) => Boolean(themeOf(id)?.usable && themeOf(id).background),
      defaultOf,
      valueOf(id) {
        if (id in edited) return edited[id] === null ? defaultOf(id) : edited[id];
        return id in saved ? saved[id] : defaultOf(id);
      },
      edit(id, value) {
        edited[id] = value === null ? null : Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
      },
      /** Saved choices plus the edits; a reset drops the theme's entry so its default applies again. */
      read() {
        const out = { ...saved };
        for (const [id, value] of Object.entries(edited)) {
          if (value === null) delete out[id];
          else out[id] = value;
        }
        return out;
      },
    };
  }

  function el(tag, props = {}, text) {
    const node = Object.assign(document.createElement(tag), props);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * Builds the section inside `container`. api: the settings panel api ({ call, onEvent }).
   * @returns {{ read(): { themeId, themeOpacity }, reload(): Promise<void>, selected(): string }}
   */
  function mount(container, { themeId, themeOpacity } = {}, api) {
    const opacity = createOpacityModel(themeOpacity || {});
    let themes = [];
    const select = el('select', { id: 'engineThemeId' });
    const info = el('p', { className: 'hint' });
    const slider = el('input', { id: 'engineThemeOpacity', type: 'range', min: 0, max: 100, step: 1 });
    const value = el('output');
    const reset = el('button', { type: 'button', className: 'ghost' }, '테마 기본값');
    const sliderLabel = el('label', { htmlFor: 'engineThemeOpacity' });
    const sliderRow = el('div', { className: 'row' });
    sliderRow.append(slider, value, reset);
    const opacityBox = el('div', { hidden: true });
    opacityBox.append(
      sliderLabel,
      sliderRow,
      el('p', { className: 'hint' }, '배경만 투명해지고 글자는 그대로입니다. 테마마다 따로 기억하고, 움직이는 동안 위젯에 바로 보입니다(저장해야 남음).')
    );
    const preview = el('button', { type: 'button', className: 'secondary' }, '미리보기');
    const folder = el('button', { type: 'button', className: 'secondary' }, '테마 폴더 열기');
    const refresh = el('button', { type: 'button', className: 'ghost' }, '목록 새로고침');
    const buttons = el('div', { className: 'row' });
    buttons.append(preview, folder, refresh);
    container.replaceChildren(
      el('label', { htmlFor: 'engineThemeId' }, '테마'),
      select,
      info,
      opacityBox,
      buttons,
      el('p', { className: 'hint' }, '받은 테마 폴더를 테마 폴더에 넣은 뒤 목록을 새로고침하세요.')
    );

    function showSelected() {
      const id = select.value;
      info.textContent = describeTheme(themes.find((t) => t.id === id));
      opacityBox.hidden = !opacity.supports(id);
      if (opacityBox.hidden) return;
      sliderLabel.textContent = `배경 불투명도 (${themes.find((t) => t.id === id).name})`;
      slider.value = String(opacity.valueOf(id));
      value.textContent = `${opacity.valueOf(id)}%`;
    }

    function setOpacity(next) {
      const id = select.value;
      opacity.edit(id, next);
      showSelected();
      api.call('liveOpacity', id, opacity.valueOf(id));
    }

    async function reload() {
      themes = (await api.call('themes')) || [];
      opacity.setThemes(themes);
      const wanted = select.value || themeId;
      select.replaceChildren(...themes.map((t) => el('option', { value: t.id, disabled: !t.usable }, optionLabel(t))));
      select.value = pick(themes, wanted);
      showSelected();
    }

    select.addEventListener('change', showSelected);
    slider.addEventListener('input', () => setOpacity(Number(slider.value)));
    reset.addEventListener('click', () => setOpacity(null));
    preview.addEventListener('click', () => api.call('previewTheme', select.value));
    folder.addEventListener('click', () => api.call('openThemeFolder'));
    refresh.addEventListener('click', () => reload());
    // "이 테마로 바꾸기" in the preview switches the widget right away; follow it here.
    api.onEvent('theme-applied', (id) => {
      if (themes.some((t) => t.id === id)) select.value = id;
      showSelected();
    });
    // A slider value that was not saved ends with the window (the engine also clears it when the window closes).
    window.addEventListener('pagehide', () => api.call('liveOpacity', select.value, null));
    reload();

    return {
      read: () => ({ themeId: select.value || themeId, themeOpacity: opacity.read() }),
      reload,
      selected: () => select.value,
    };
  }

  return { problemOf, optionLabel, describeTheme, pick, createOpacityModel, mount };
});
