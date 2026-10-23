// Memo section of the settings window (see engine/renderer/widget-settings.js for the panel contract).
(() => {
  let root = null;
  let defaults = '';
  const $ = (id) => root.querySelector(`#${id}`);

  async function check(api) {
    const problem = await api.call('check', $('memoDir').value);
    $('memoDirError').hidden = !problem;
    $('memoDirError').textContent = problem || '';
  }

  window.settingsShell.registerPanel('memo', {
    init(panelRoot, values, api) {
      root = panelRoot;
      defaults = values.defaultNotesDir;
      $('memoDir').value = values.notesDir;
      for (const c of values.colors) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name;
        $('memoColor').append(o);
      }
      $('memoColor').value = values.defaultColor;
      $('memoFont').value = values.fontSize;
      $('memoOpacity').value = values.opacity;
      const showOpacity = () => ($('memoOpacityValue').textContent = `${$('memoOpacity').value}%`);
      showOpacity();
      $('memoOpacity').addEventListener('input', showOpacity);
      $('memoPick').addEventListener('click', async () => {
        const dir = await api.call('pickFolder');
        if (dir) $('memoDir').value = dir;
        check(api);
      });
      $('memoDefault').addEventListener('click', () => {
        $('memoDir').value = defaults;
        check(api);
      });
      $('memoOpen').addEventListener('click', () => api.call('openFolder'));
      $('memoDir').addEventListener('change', () => check(api));
    },
    validate() {
      const dir = $('memoDir').value.trim();
      if (!dir) return '노트 폴더를 적어 주세요.';
      const font = Number($('memoFont').value);
      if (!Number.isFinite(font) || font < 10 || font > 24) return '글자 크기는 10~24 사이로 적어 주세요.';
      return null;
    },
    read() {
      return {
        notesDir: $('memoDir').value.trim(),
        defaultColor: $('memoColor').value,
        fontSize: Number($('memoFont').value),
        opacity: Number($('memoOpacity').value),
      };
    },
  });
})();
