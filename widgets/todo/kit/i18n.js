// Shared messages for the widget's main process, settings panel, and themes.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TodoI18n = api;
})(typeof window === 'undefined' ? null : window, function () {
  const messages = {
    ko: {
      widget: '할 일', defaultList: '할 일', addPlaceholder: '할 일 입력 (예: 보고서 내일 3시)',
      add: '추가', save: '저장', cancel: '취소', lists: '목록', newList: '새 목록', listName: '목록 이름',
      active: '할 일', completed: '완료', empty: '할 일이 없습니다', delete: '삭제',
      rename: '이름 바꾸기', removeList: '목록 삭제', removeListConfirm: '이 목록과 할 일을 모두 삭제할까요?',
      noTitle: '할 일을 입력해 주세요.', enterListName: '목록 이름을 입력해 주세요.', duplicateList: '같은 이름의 목록이 있습니다.',
      noList: '목록을 찾을 수 없습니다.', noTask: '할 일을 찾을 수 없습니다.',
      listLimit: '목록을 더 만들 수 없습니다.', taskLimit: '할 일을 더 만들 수 없습니다.',
      invalidDate: '날짜나 시간을 확인해 주세요.', overdue: '지남', today: '오늘', tomorrow: '내일',
      weekly: '매주', reminderTitle: '할 일 알림', snooze: '{minutes}분 뒤 다시', done: '완료',
      settingsDisplay: '표시', alwaysOnTop: '항상 위에 표시', settingsReminder: '알림',
      snoozeMinutes: '다시 알림 간격(분)', invalidSnooze: '다시 알림 간격은 1~120분으로 입력해 주세요.', settingsHint: '할 일은 이 PC의 위젯 데이터 폴더에 저장됩니다. 날짜에 시간을 적으면 그때 알림 카드가 뜹니다.',
      settingsThemes: '테마', dragHint: '끌어서 순서 바꾸기',
      settingsIntegrations: '위젯 연동', receiveDooray: '두레이에서 받기', receiveMail: '메일에서 받기',
      shareCalendar: '캘린더에 마감 표시', integrationHint: '양쪽 위젯에서 연동을 켜야 동작합니다. 끄더라도 이미 추가한 할 일은 유지됩니다.',
      integrationReady: '필요 조건 충족', integrationOff: '상대 위젯이 꺼져 있습니다.', integrationMissing: '상대 위젯이 설치되지 않았습니다.',
      integrationIncompatible: '상대 위젯의 연동 기능 또는 엔진 API가 호환되지 않습니다.', integrationEngine: '위젯 간 연동을 지원하는 엔진이 필요합니다.',
      integrationPeerSetting: '상대 위젯의 연동 설정도 켜 주세요.', integrationVersion: '엔진 {engineVersion} / API {engineApi} · 상대 위젯 {widgetVersion}',
      requiresEngine: '엔진의 위젯 간 연동 API', requiresPeer: '{widget} 위젯 설치·사용', requiresFeature: '{widget}의 연동 기능',
      doorayName: '두레이', mailName: '메일', calendarName: '캘린더',
      invalidSource: '추가할 원본 항목을 확인해 주세요.', integrationDisabled: '이 연동은 할 일 위젯 설정에서 꺼져 있습니다.',
    },
    en: {
      widget: 'To Do', defaultList: 'To Do', addPlaceholder: 'Add a task',
      add: 'Add', save: 'Save', cancel: 'Cancel', lists: 'Lists', newList: 'New list', listName: 'List name',
      active: 'Tasks', completed: 'Completed', empty: 'No tasks yet', delete: 'Delete',
      rename: 'Rename', removeList: 'Delete list', removeListConfirm: 'Delete this list and all its tasks?',
      noTitle: 'Enter a task.', enterListName: 'Enter a list name.', duplicateList: 'A list with this name exists.',
      noList: 'List not found.', noTask: 'Task not found.',
      listLimit: 'The list limit was reached.', taskLimit: 'The task limit was reached.',
      invalidDate: 'Check the date and time.', overdue: 'Overdue', today: 'Today', tomorrow: 'Tomorrow',
      weekly: 'Weekly', reminderTitle: 'Task reminder', snooze: 'Remind in {minutes} min', done: 'Done',
      settingsDisplay: 'Display', alwaysOnTop: 'Always on top', settingsReminder: 'Reminders',
      snoozeMinutes: 'Snooze interval (minutes)', invalidSnooze: 'Enter a snooze interval from 1 to 120 minutes.', settingsHint: 'Tasks stay in this PC\'s widget data folder. Korean date phrases with a time schedule a reminder card.',
      settingsThemes: 'Theme', dragHint: 'Drag to reorder',
      settingsIntegrations: 'Widget integrations', receiveDooray: 'Receive from Dooray', receiveMail: 'Receive from Mail',
      shareCalendar: 'Show due dates in Calendar', integrationHint: 'Enable the integration in both widgets. Disabling it keeps previously added tasks.',
      integrationReady: 'Requirements met', integrationOff: 'The other widget is off.', integrationMissing: 'The other widget is not installed.',
      integrationIncompatible: 'The other widget integration or engine API is incompatible.', integrationEngine: 'An engine with widget integrations is required.',
      integrationPeerSetting: 'Enable the integration in the other widget too.', integrationVersion: 'Engine {engineVersion} / API {engineApi} · other widget {widgetVersion}',
      requiresEngine: 'Engine widget integration API', requiresPeer: '{widget} widget installed and on', requiresFeature: '{widget} integration support',
      doorayName: 'Dooray', mailName: 'Mail', calendarName: 'Calendar',
      invalidSource: 'Check the source item.', integrationDisabled: 'This integration is off in the To Do widget settings.',
    },
  };
  function language(locale) { return String(locale || '').toLowerCase().startsWith('ko') ? 'ko' : 'en'; }
  function t(locale, key, vars = {}) {
    const text = (messages[language(locale)] || messages.en)[key] || messages.en[key] || key;
    return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
  }
  return { t, language, messages };
});
