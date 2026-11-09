// Clock section of the settings window (see engine/renderer/widget-settings.js for the panel contract).
// The theme list, background opacity, preview and theme folder are the engine's theme section (#59, #60).
// "알림음" (#130): volume, longest time and the timer's sound are saved with 저장; adding or removing a file applies
// at once (the file is copied or deleted then). Each alarm's sound and repeat are set in the clock's alarm tab.
(() => {
  let root = null;
  let api = null;
  let previewing = false;
  // Kept from the last values: the sound choices (with names) and the timer's selection.
  let current = { sounds: [], userSounds: [], timerSound: 'default', timerRepeat: 0 };
  const $ = (id) => root.querySelector(`#${id}`);
  const REPEATS = [1, 2, 3, 5, 10, 0];
  const repeatText = (n) => (n === 0 ? '끌 때까지' : `${n}번`);
  const option = (value, label) => Object.assign(document.createElement('option'), { value: String(value), textContent: label });

  function fill(values) {
    $('clockShowSeconds').checked = Boolean(values.showSeconds);
    $('clockHour12').checked = Boolean(values.hour12);
    $('clockAlwaysOnTop').checked = Boolean(values.alwaysOnTop);
    $('clockTools').checked = Boolean(values.tools);
  }

  function fillSound(values) {
    if (!Array.isArray(values.sounds)) return; // an older widget without #130
    current = { ...current, ...values };
    $('clockSoundVolume').value = String(values.soundVolume ?? 80);
    showVolume();
    $('clockSoundMax').value = String(values.soundMaxSeconds ?? 60);
    fillSoundList(values);
  }

  /** The file list and the timer's sound choices (after adding / removing a file too). */
  function fillSoundList(values) {
    const keep = $('clockTimerSound').value || values.timerSound;
    $('clockTimerSound').replaceChildren(...values.sounds.map((s) => option(s.id, s.name)));
    $('clockTimerSound').value = values.sounds.some((s) => s.id === keep) ? keep : values.timerSound || 'default';
    if (!$('clockTimerSound').value) $('clockTimerSound').value = 'default';
    if (!$('clockTimerRepeat').options.length) $('clockTimerRepeat').replaceChildren(...REPEATS.map((n) => option(n, repeatText(n))));
    if (!$('clockTimerRepeat').dataset.touched) $('clockTimerRepeat').value = String(values.timerRepeat ?? 0);

    const items = values.userSounds.map((s) => {
      const li = document.createElement('li');
      const name = Object.assign(document.createElement('span'), { className: 'name', textContent: s.name, title: s.name });
      const play = Object.assign(document.createElement('button'), { type: 'button', className: 'small', textContent: '미리 듣기' });
      play.addEventListener('click', () => preview(s.id));
      const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'small ghost', textContent: '삭제' });
      // Two clicks: the first asks (alarms using it go back to the default sound).
      remove.addEventListener('click', () => {
        if (remove.dataset.armed) return removeSound(s.id);
        remove.dataset.armed = '1';
        remove.textContent = '정말 삭제';
        status(`"${s.name}"을(를) 쓰던 알람·타이머는 기본음으로 바뀝니다.`);
        setTimeout(() => {
          delete remove.dataset.armed;
          remove.textContent = '삭제';
        }, 4000);
        return undefined;
      });
      li.append(name, play, remove);
      return li;
    });
    $('clockSoundList').replaceChildren(...items);
    $('clockSoundEmpty').hidden = items.length > 0;
    $('clockSoundAdd').disabled = items.length >= 10;
  }

  function showVolume() {
    $('clockSoundVolumeText').textContent = `${$('clockSoundVolume').value}%`;
  }

  function status(text, error = false) {
    $('clockSoundStatus').textContent = text || '';
    $('clockSoundStatus').classList.toggle('err', error);
  }

  async function preview(id) {
    if (previewing) {
      await api.call('stopPreview');
      return;
    }
    const res = await api.call('previewSound', id, Number($('clockSoundVolume').value));
    if (!res?.ok) status(res?.message || '재생하지 못했습니다.', true);
    else if (res.missing) status('파일이 없어 기본음으로 들려 드립니다.');
    else if (!res.playing) status(id === 'none' ? '소리 없음입니다.' : '재생하지 못했습니다.', !res.playing && id !== 'none');
    else status('');
  }

  async function addSound() {
    status('');
    const res = await api.call('addSound');
    if (!res?.ok) return status(res?.message || '추가하지 못했습니다.', true);
    fillSoundList(res);
    if (res.added) status('추가했습니다. 알람 탭에서 알람에 고르세요.');
    return undefined;
  }

  async function removeSound(id) {
    const res = await api.call('removeSound', id);
    if (!res?.ok) return status(res?.message || '지우지 못했습니다.', true);
    fillSoundList(res);
    status('');
    return undefined;
  }

  function setPreviewing(on) {
    previewing = Boolean(on);
    $('clockTimerPreview').textContent = previewing ? '정지' : '미리 듣기';
  }

  window.settingsShell.registerPanel('clock', {
    init(panelRoot, values, shellApi) {
      root = panelRoot;
      api = shellApi;
      fill(values);
      fillSound(values);
      // Saving adds the section's { themeId, themeOpacity } to read().
      api.mountThemePicker($('clockThemes'), { themeId: values.themeId, themeOpacity: values.themeOpacity });
      // The right-click menu can change these while this window is open.
      api.onEvent('settings-changed', fill);
      api.onEvent('sound-playing', setPreviewing);
      $('clockSoundVolume').addEventListener('input', showVolume);
      $('clockTimerRepeat').addEventListener('change', () => ($('clockTimerRepeat').dataset.touched = '1'));
      $('clockTimerPreview').addEventListener('click', () => preview($('clockTimerSound').value));
      $('clockSoundAdd').addEventListener('click', addSound);
      // A preview does not outlive the window.
      window.addEventListener('pagehide', () => api.call('stopPreview'));
    },
    validate: () => null,
    read: () => ({
      showSeconds: $('clockShowSeconds').checked,
      hour12: $('clockHour12').checked,
      alwaysOnTop: $('clockAlwaysOnTop').checked,
      tools: $('clockTools').checked,
      soundVolume: Number($('clockSoundVolume').value),
      soundMaxSeconds: Number($('clockSoundMax').value),
      timerSound: $('clockTimerSound').value || 'default',
      timerRepeat: Number($('clockTimerRepeat').value),
    }),
  });
})();
