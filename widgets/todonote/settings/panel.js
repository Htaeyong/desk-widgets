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

  window.settingsShell.registerPanel('todonote', {
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
      // To-do notes (#111)
      $('memoSnooze').value = values.snoozeMinutes;
      $('memoAllDayOn').checked = Boolean(values.allDayRemind);
      $('memoAllDay').value = values.allDayRemind || '09:00';
      $('memoReopen').checked = values.reopenRepeat;
      $('memoReset').checked = values.resetChecks;
      for (const d of values.autoDeleteChoices) $('memoAutoDelete').append(new Option(d === 0 ? '삭제 안 함' : d === 365 ? '1년 뒤' : `${d}일 뒤`, String(d)));
      $('memoAutoDelete').value = String(values.autoDeleteDays);
      const preview = async () => {
        const days = Number($('memoAutoDelete').value);
        const n = days ? await api.call('autoDeletePreview', days) : 0;
        $('memoAutoDeleteHint').textContent = days ? `지금 기준 ${n}개가 휴지통으로 갑니다.` : '완료한 노트를 지우지 않습니다.';
      };
      preview();
      $('memoAutoDelete').addEventListener('change', preview);
      // Integrations (#111): the same three switches the to-do widget had, off until the user turns them on (#94).
      $('memoRecvDooray').checked = values.receiveDooray;
      $('memoRecvMail').checked = values.receiveMail;
      $('memoShareCal').checked = values.shareCalendar;
      const showStatus = (st) => {
        if (!st) return;
        const parts = [];
        const name = { dooray: '두레이', mail: '메일', calendar: '캘린더' };
        if (!st.dooray?.brokerAvailable && !st.calendar?.brokerAvailable) parts.push('이 Desk Widgets 엔진은 위젯 간 연동을 지원하지 않습니다. Desk Widgets를 업데이트하세요.');
        else {
          for (const [id, box] of [['dooray', 'memoRecvDooray'], ['mail', 'memoRecvMail'], ['calendar', 'memoShareCal']]) {
            if (!$(box).checked) continue;
            const p = st[id] || {};
            if (!p.installed) parts.push(`${name[id]} 위젯이 설치되어 있지 않습니다.`);
            else if (!p.running) parts.push(`${name[id]} 위젯을 사용 상태로 켜 주세요.`);
            else if (!p.peerEnabled) parts.push(`${name[id]} 위젯 설정에서 할 일 연동을 켜 주세요.`);
            else parts.push(`${name[id]}: 연동 준비됨`);
          }
        }
        $('memoIntegrationStatus').textContent = parts.join(' ');
      };
      showStatus(values.integrationStatus);
      for (const id of ['memoRecvDooray', 'memoRecvMail', 'memoShareCal']) $(id).addEventListener('change', async () => showStatus(await api.call('integrationStatus')));
      api.onEvent?.('integration-status', showStatus);
      // The to-do widget's import (#111, design 9.4).
      $('memoImport').addEventListener('click', async () => {
        $('memoImport').disabled = true;
        $('memoImportResult').textContent = '가져오는 중…';
        let r;
        try {
          r = await api.call('importTodo', { includeDone: $('memoImportDone').checked });
        } catch (err) {
          r = { ok: false, message: err.message };
        }
        $('memoImport').disabled = false;
        $('memoImportResult').textContent = r?.message || (r?.ok ? '가져왔습니다.' : '가져오지 못했습니다.');
      });
    },
    validate() {
      const dir = $('memoDir').value.trim();
      if (!dir) return '노트 폴더를 적어 주세요.';
      if (!$('memoMove').hidden && !moveChoice) return '기존 노트를 새 폴더로 옮길지 골라 주세요(옮기기 / 옮기지 않기 / 취소).';
      const font = Number($('memoFont').value);
      if (!Number.isFinite(font) || font < 10 || font > 24) return '글자 크기는 10~24 사이로 적어 주세요.';
      const snooze = Number($('memoSnooze').value);
      if (!Number.isInteger(snooze) || snooze < 1 || snooze > 120) return '다시 알림 간격은 1~120분으로 적어 주세요.';
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
        snoozeMinutes: Number($('memoSnooze').value),
        allDayRemind: $('memoAllDayOn').checked ? $('memoAllDay').value || '09:00' : '',
        reopenRepeat: $('memoReopen').checked,
        resetChecks: $('memoReset').checked,
        autoDeleteDays: Number($('memoAutoDelete').value),
        receiveDooray: $('memoRecvDooray').checked,
        receiveMail: $('memoRecvMail').checked,
        shareCalendar: $('memoShareCal').checked,
      };
    },
  });
})();
