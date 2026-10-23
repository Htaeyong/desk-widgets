// The engine's theme section in a widget settings window (#59).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { problemOf, optionLabel, describeTheme, pick, createOpacityModel, mount } = require('../renderer/theme-picker');

const THEMES = [
  { id: 'dark-glass', name: '다크 글래스', version: '1.0.0', author: 'chilgong88', description: '기본', usable: true, errors: [], source: 'builtin', background: { opacity: 0.78 } },
  { id: 'light', name: '라이트', version: '1.1.0', author: '', description: '', usable: true, errors: [], source: 'user', background: { opacity: 0.88 } },
  { id: 'plain', name: '평범', version: '1.0.0', usable: true, errors: [], source: 'builtin', background: null },
  { id: 'glass', name: '글래스', version: '1.0.0', usable: false, errors: ['theme for another widget ("dooray")'], source: 'user' },
  { id: 'old', name: '옛 테마', version: '0.1.0', usable: false, errors: ['contractVersion 2 is not supported (expected 1)'], source: 'user' },
];

test('labels and descriptions: another widget\'s theme, incompatible, user theme', () => {
  assert.equal(optionLabel(THEMES[0]), '다크 글래스');
  assert.equal(optionLabel(THEMES[3]), '글래스 (다른 위젯 테마)');
  assert.equal(optionLabel(THEMES[4]), '옛 테마 (호환 안 됨)');
  assert.equal(problemOf(THEMES[3]), '다른 위젯(dooray)의 테마입니다.');
  assert.equal(describeTheme(THEMES[3]), '다른 위젯(dooray)의 테마입니다.');
  assert.equal(describeTheme(THEMES[4]), '사용할 수 없음: contractVersion 2 is not supported (expected 1)');
  assert.equal(describeTheme(THEMES[0]), 'v1.0.0 · chilgong88 — 기본');
  assert.equal(describeTheme(THEMES[1]), 'v1.1.0 · 사용자 테마');
  assert.equal(describeTheme(undefined), '');
});

test('selection falls back to the first usable theme', () => {
  assert.equal(pick(THEMES, 'light'), 'light');
  assert.equal(pick(THEMES, 'glass'), 'dark-glass');
  assert.equal(pick(THEMES, 'missing'), 'dark-glass');
  assert.equal(pick([], 'x'), '');
});

test('opacity per theme: saved, edited, reset to the theme default', () => {
  const m = createOpacityModel({ light: 40, gone: 10 });
  m.setThemes(THEMES);
  assert.equal(m.supports('dark-glass'), true);
  assert.equal(m.supports('plain'), false, 'no "background" in theme.json');
  assert.equal(m.supports('glass'), false, 'not usable');
  assert.equal(m.valueOf('dark-glass'), 78);
  assert.equal(m.valueOf('light'), 40);
  m.edit('dark-glass', 150);
  m.edit('light', null);
  assert.equal(m.valueOf('dark-glass'), 100);
  assert.equal(m.valueOf('light'), 88);
  // Unknown ids stay as saved (the widget's store drops them); a reset removes the theme's entry.
  assert.deepEqual(m.read(), { gone: 10, 'dark-glass': 100 });
});

// --- mount() with a very small DOM ---
function fakeDocument() {
  const make = (tag) => {
    const listeners = {};
    const node = {
      tag,
      children: [],
      value: '',
      textContent: '',
      hidden: false,
      append(...kids) {
        this.children.push(...kids);
      },
      replaceChildren(...kids) {
        this.children = kids;
      },
      addEventListener(name, fn) {
        (listeners[name] = listeners[name] || []).push(fn);
      },
      fire(name) {
        for (const fn of listeners[name] || []) fn();
      },
    };
    return node;
  };
  return { createElement: make };
}

function find(node, test) {
  if (test(node)) return node;
  for (const c of node.children || []) {
    const hit = find(c, test);
    if (hit) return hit;
  }
  return null;
}

test('mount: builds the section, previews the slider, reads what to save, follows "이 테마로 바꾸기"', async () => {
  global.document = fakeDocument();
  const pagehide = [];
  global.window = { addEventListener: (name, fn) => name === 'pagehide' && pagehide.push(fn) };
  const calls = [];
  const events = {};
  const api = {
    call: async (name, ...args) => {
      calls.push([name, ...args]);
      return name === 'themes' ? THEMES : null;
    },
    onEvent: (name, cb) => (events[name] = cb),
  };
  const container = document.createElement('div');
  const picker = mount(container, { themeId: 'light', themeOpacity: { light: 40 } }, api);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const select = find(container, (n) => n.tag === 'select');
  assert.equal(select.children.length, THEMES.length);
  assert.equal(select.value, 'light');
  const slider = find(container, (n) => n.tag === 'input');
  assert.equal(slider.value, '40');

  slider.value = '55';
  slider.fire('input');
  assert.deepEqual(calls.at(-1), ['liveOpacity', 'light', 55]);
  assert.deepEqual(picker.read(), { themeId: 'light', themeOpacity: { light: 55 } });

  // A theme without "background" hides the slider.
  select.value = 'plain';
  select.fire('change');
  const opacityBox = find(container, (n) => n.tag === 'div' && n.children.some((c) => c.children?.includes(slider)));
  assert.equal(opacityBox.hidden, true);

  // Buttons go to the widget's settings handlers.
  for (const label of ['미리보기', '테마 폴더 열기']) find(container, (n) => n.tag === 'button' && n.textContent === label).fire('click');
  assert.deepEqual(calls.slice(-2), [['previewTheme', 'plain'], ['openThemeFolder']]);

  events['theme-applied']('dark-glass');
  assert.equal(picker.selected(), 'dark-glass');
  pagehide.forEach((fn) => fn());
  assert.deepEqual(calls.at(-1), ['liveOpacity', 'dark-glass', null]);
  delete global.document;
  delete global.window;
});

test('the settings window loads the picker before its own script and saves its values', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'widget-settings.html'), 'utf8');
  assert.ok(html.indexOf('theme-picker.js') > 0 && html.indexOf('theme-picker.js') < html.indexOf('widget-settings.js'));
  const shell = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'widget-settings.js'), 'utf8');
  assert.match(shell, /mountThemePicker/);
  assert.match(shell, /\.\.\.\(themePicker \? themePicker\.read\(\) : \{\}\)/);
});
