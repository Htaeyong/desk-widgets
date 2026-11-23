// AI chat section of the settings window (see engine/renderer/widget-settings.js for the panel contract). The key field goes
// to the widget only through "키 저장", is emptied right after, and is never part of the saved settings.
(() => {
  let root = null;
  const $ = (id) => root.querySelector(`#${id}`);

  function showResult(res) {
    $('aiKeyResult').textContent = res.message || '';
    $('aiKeyResult').className = `status ${res.ok ? 'ok' : 'err'}`;
  }

  function showStatus(status) {
    $('aiKeyState').textContent = status.has ? `저장된 키: …${status.tail}` : '저장된 키가 없습니다. 키가 없으면 아무것도 실행하지 않습니다.';
    $('aiKeyDelete').disabled = !status.has;
    $('aiKeyTest').disabled = !status.has;
    $('aiKeySave').disabled = !status.encryption;
    if (!status.encryption) showResult({ ok: false, message: '이 PC에서 암호화 저장을 쓸 수 없어 키를 저장할 수 없습니다.' });
  }

  window.settingsShell.registerPanel('ai-chat', {
    async init(panelRoot, values, api) {
      root = panelRoot;
      for (const m of values.models) $('aiModel').append(Object.assign(document.createElement('option'), { value: m.id, textContent: m.label }));
      $('aiModel').value = values.model;
      const showCost = () => {
        $('aiModelCost').textContent = values.models.find((m) => m.id === $('aiModel').value)?.cost || '';
      };
      $('aiModel').addEventListener('change', showCost);
      showCost();
      for (const m of values.modes) $('aiMode').append(Object.assign(document.createElement('option'), { value: m.id, textContent: m.label }));
      $('aiMode').value = values.mode;
      $('aiKeep').value = String(values.keepDays);
      $('aiConcurrent').value = String(values.maxConcurrent);
      $('aiGuard').checked = values.writeGuard;
      $('aiCardTimeout').checked = values.cardTimeoutMinutes === 30;
      $('aiBudget').value = String(values.monthlyBudgetUsd);
      $('aiCap').value = String(values.taskCapUsd);
      $('aiReset').value = String(values.resetDay);
      $('aiDir').value = values.workDir || values.defaultWorkDir;
      $('aiDirDefault').addEventListener('click', () => { $('aiDir').value = values.defaultWorkDir; });
      $('aiDirPick').addEventListener('click', async () => {
        const dir = await api.call('pickFolder');
        if (dir) $('aiDir').value = dir;
      });
      $('aiLinkWorkspaces').addEventListener('click', () => api.call('openLink', 'workspaces'));
      $('aiLinkKeys').addEventListener('click', () => api.call('openLink', 'keys'));
      // The memory list: each one can be read, fixed, switched off or deleted here.
      const memoryResult = (res) => {
        $('aiMemoryResult').textContent = res?.message || '';
        $('aiMemoryResult').className = `status ${res?.ok === false ? 'err' : 'ok'}`;
      };
      const drawMemory = async () => {
        const list = await api.call('memoryList');
        const rows = list.map((m) => {
          const row = document.createElement('div');
          row.className = 'memory-row';
          row.dataset.memory = m.id;
          const head = document.createElement('div');
          head.className = 'row';
          const on = Object.assign(document.createElement('input'), { type: 'checkbox', checked: m.enabled });
          const onLabel = document.createElement('label');
          onLabel.className = 'check';
          onLabel.append(on, ' 전달');
          const title = Object.assign(document.createElement('input'), { type: 'text', value: m.title, placeholder: '제목 (선택)', maxLength: 80, spellcheck: false });
          head.append(onLabel, title);
          const text = Object.assign(document.createElement('textarea'), { value: m.text, rows: 2, maxLength: 1000, spellcheck: false });
          const note = document.createElement('p');
          note.className = 'hint';
          note.textContent = [new Date(m.createdAt).toLocaleDateString(), m.sourceTitle ? `대화: ${m.sourceTitle}` : '', m.external ? '외부 내용을 읽은 대화에서 나옴' : ''].filter(Boolean).join(' · ');
          const actions = document.createElement('div');
          actions.className = 'row';
          const save = Object.assign(document.createElement('button'), { type: 'button', textContent: '고친 내용 저장' });
          const del = Object.assign(document.createElement('button'), { type: 'button', textContent: '삭제' });
          let allow = false;
          save.addEventListener('click', async () => {
            const res = await api.call('memoryUpdate', { id: m.id, text: text.value, title: title.value, allowFlags: allow });
            allow = res?.code === 'secrets'; // a second click saves it as it is
            memoryResult(res?.ok ? { ok: true, message: '기억을 고쳤습니다.' } : res);
          });
          on.addEventListener('change', async () => {
            await api.call('memorySetEnabled', { id: m.id, enabled: on.checked });
            memoryResult({ ok: true, message: on.checked ? '이 기억을 다시 전달합니다.' : '이 기억을 전달하지 않습니다.' });
          });
          del.addEventListener('click', async () => {
            if (del.dataset.armed !== '1') {
              del.dataset.armed = '1';
              del.textContent = '정말 삭제';
              return;
            }
            await api.call('memoryRemove', m.id);
            memoryResult({ ok: true, message: '기억을 지웠습니다.' });
            drawMemory();
          });
          actions.append(save, del);
          row.append(head, text, note, actions);
          return row;
        });
        if (!rows.length) {
          const empty = document.createElement('p');
          empty.className = 'hint';
          empty.textContent = '저장한 기억이 없습니다.';
          rows.push(empty);
        }
        $('aiMemoryList').replaceChildren(...rows);
      };
      drawMemory();
      $('aiNoticesReset').addEventListener('click', async () => {
        const res = await api.call('resetNotices');
        $('aiNoticesResult').textContent = res?.message || '';
      });
      $('aiKeySave').addEventListener('click', async () => {
        const res = await api.call('saveKey', $('aiKey').value);
        if (res.ok) $('aiKey').value = '';
        showResult(res);
        showStatus(res.status);
      });
      $('aiKeyDelete').addEventListener('click', async () => {
        const res = await api.call('deleteKey');
        showResult(res);
        showStatus(res.status);
      });
      $('aiKeyTest').addEventListener('click', async () => {
        $('aiKeyResult').textContent = '확인 중…';
        $('aiKeyResult').className = 'status';
        showResult(await api.call('testKey'));
      });
      showStatus(await api.call('keyStatus'));
    },
    validate() {
      const budget = Number($('aiBudget').value);
      const cap = Number($('aiCap').value);
      const day = Number($('aiReset').value);
      let problem = null;
      if (!(budget > 0) || budget > 100000) problem = '월 예산은 0보다 큰 금액으로 적어 주세요.';
      else if (!(cap > 0) || cap > 1000) problem = '작업 상한은 0보다 큰 금액으로 적어 주세요.';
      else if (!Number.isInteger(day) || day < 1 || day > 28) problem = '예산을 새로 세는 날은 1에서 28 사이로 적어 주세요.';
      $('aiBudgetError').textContent = problem || '';
      return problem;
    },
    read: () => ({ model: $('aiModel').value, workDir: $('aiDir').value.trim(), mode: $('aiMode').value, keepDays: Number($('aiKeep').value), maxConcurrent: Number($('aiConcurrent').value), writeGuard: $('aiGuard').checked, cardTimeoutMinutes: $('aiCardTimeout').checked ? 30 : 0, monthlyBudgetUsd: Number($('aiBudget').value), taskCapUsd: Number($('aiCap').value), resetDay: Number($('aiReset').value) }),
  });
})();
