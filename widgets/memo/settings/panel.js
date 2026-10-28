// Memo section of the settings window (see engine/renderer/widget-settings.js for the panel contract).
(() => {
  let root = null;
  let defaults = '';
  const $ = (id) => root.querySelector(`#${id}`);
  let initialDir = '';
  let moveChoice = null; // 'move' | 'keep' once the user answered "기존 노트를 새 폴더로 옮길까요?"

  /** Shows the move question while the folder field differs from the folder in use (#108). */
  function updateMove() {
    const changed = $('memoDir').value.trim().toLowerCase() !== initialDir.toLowerCase();
    if (!changed) moveChoice = null;
    $('memoMove').hidden = !changed;
    $('memoMoveYes').setAttribute('aria-pressed', String(moveChoice === 'move'));
    $('memoMoveNo').setAttribute('aria-pressed', String(moveChoice === 'keep'));
    $('memoKeepOriginals').disabled = moveChoice !== 'move';
  }

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
      initialDir = values.notesDir;
      $('memoMoveYes').addEventListener('click', () => { moveChoice = 'move'; updateMove(); });
      $('memoMoveNo').addEventListener('click', () => { moveChoice = 'keep'; updateMove(); });
      $('memoMoveCancel').addEventListener('click', () => {
        $('memoDir').value = initialDir;
        check(api);
        updateMove();
      });
      $('memoDir').addEventListener('input', updateMove);
      updateMove();
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
        updateMove();
      });
      $('memoDefault').addEventListener('click', () => {
        $('memoDir').value = defaults;
        check(api);
        updateMove();
      });
      $('memoOpen').addEventListener('click', () => api.call('openFolder'));
      $('memoDir').addEventListener('change', () => check(api));
    },
    validate() {
      const dir = $('memoDir').value.trim();
      if (!dir) return '노트 폴더를 적어 주세요.';
      if (!$('memoMove').hidden && !moveChoice) return '기존 노트를 새 폴더로 옮길지 골라 주세요(옮기기 / 옮기지 않기 / 취소).';
      const font = Number($('memoFont').value);
      if (!Number.isFinite(font) || font < 10 || font > 24) return '글자 크기는 10~24 사이로 적어 주세요.';
      return null;
    },
    read() {
      return {
        notesDir: $('memoDir').value.trim(),
        moveNotes: !$('memoMove').hidden && moveChoice === 'move',
        keepOriginals: $('memoKeepOriginals').checked,
        defaultColor: $('memoColor').value,
        fontSize: Number($('memoFont').value),
        opacity: Number($('memoOpacity').value),
      };
    },
  });
})();
