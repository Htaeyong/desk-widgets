// Theme contract v1: render the engine's numeric measurements without direct system access.
(() => {
  const t = {
    ko: {
      title: '시스템', cpu: 'CPU', memory: '메모리', disks: '디스크', diskIo: '디스크 속도',
      network: '네트워크', gpu: 'GPU', battery: '배터리', uptime: '가동 시간',
      down: '받기', up: '보내기', read: '읽기', write: '쓰기',
      unavailable: '사용 불가', noBattery: '배터리 없음', charging: '충전 중', paused: '측정 대기', settings: '설정',
    },
    en: {
      title: 'System', cpu: 'CPU', memory: 'Memory', disks: 'Disks', diskIo: 'Disk I/O',
      network: 'Network', gpu: 'GPU', battery: 'Battery', uptime: 'Uptime',
      down: 'Down', up: 'Up', read: 'Read', write: 'Write',
      unavailable: 'Unavailable', noBattery: 'No battery', charging: 'Charging', paused: 'Waiting for sample', settings: 'Settings',
    },
  };
  const $ = (id) => document.getElementById(id);
  const text = (id, value) => { $(id).textContent = value; };
  const percent = (value) => Number.isFinite(value) ? `${Math.round(value)}%` : labels.unavailable;
  const bytes = (value) => {
    if (!Number.isFinite(value)) return labels.unavailable;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = value;
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit += 1; }
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit ? 1 : 0 }).format(n)} ${units[unit]}`;
  };
  const speed = (value) => Number.isFinite(value) ? `${bytes(value)}/s` : labels.unavailable;
  const duration = (seconds) => {
    if (!Number.isFinite(seconds)) return labels.unavailable;
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return locale.startsWith('ko') ? `${days}일 ${hours}시간 ${minutes}분` : `${days}d ${hours}h ${minutes}m`;
  };
  let locale = 'ko-KR';
  let labels = t.ko;
  const setWidth = (id, value) => { $(id).style.width = `${Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0}%`; };

  function drawHistory(points) {
    const values = Array.isArray(points) ? points.slice(-150) : [];
    if (!values.length) { $('cpuGraph').setAttribute('points', ''); return; }
    const min = values[0].at;
    const max = values.at(-1).at;
    const span = Math.max(1, max - min);
    const line = values.map((point) => `${((point.at - min) / span * 100).toFixed(1)},${(100 - point.percent).toFixed(1)}`).join(' ');
    $('cpuGraph').setAttribute('points', line);
  }

  function render(payload) {
    locale = payload?.locale || locale;
    labels = t[locale.startsWith('ko') ? 'ko' : 'en'];
    document.documentElement.lang = locale.startsWith('ko') ? 'ko' : 'en';
    document.title = labels.title;
    $('settings').setAttribute('aria-label', labels.settings);
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = labels[node.dataset.i18n];
    const m = payload?.metrics;
    if (!m) { text('status', labels.paused); return; }
    text('status', new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(m.at));
    text('cpuValue', percent(m.cpu?.percent));
    setWidth('cpuBar', m.cpu?.percent);
    drawHistory(m.cpu?.history);
    const cores = payload.settings?.showCores ? m.cpu?.cores || [] : [];
    $('cores').replaceChildren(...cores.map((value, i) => {
      const node = document.createElement('span');
      node.textContent = `${i + 1}: ${percent(value)}`;
      return node;
    }));
    text('memoryValue', `${bytes(m.memory.used)} / ${bytes(m.memory.total)} · ${percent(m.memory.percent)}`);
    setWidth('memoryBar', m.memory.percent);
    $('disks').replaceChildren(...(m.disks || []).map((disk) => {
      const row = document.createElement('div');
      row.className = 'disk-row';
      const name = document.createElement('span');
      name.textContent = disk.drive;
      const value = document.createElement('span');
      value.textContent = `${bytes(disk.used)} / ${bytes(disk.total)} · ${percent(disk.percent)}`;
      row.append(name, value);
      return row;
    }));
    text('diskSpeed', `${labels.read} ${speed(m.diskIo.readBytesPerSec)} · ${labels.write} ${speed(m.diskIo.writeBytesPerSec)}`);
    text('networkValue', `${labels.down} ${speed(m.network.downBytesPerSec)} · ${labels.up} ${speed(m.network.upBytesPerSec)}`);
    text('gpuValue', percent(m.gpu.percent));
    setWidth('gpuBar', m.gpu.percent);
    text('batteryValue', m.battery ? `${percent(m.battery.percent)}${m.battery.charging ? ' · ' + labels.charging : ''}` : labels.noBattery);
    text('uptimeValue', duration(m.uptimeSeconds));
  }

  $('settings').addEventListener('click', () => window.widget.openSettings());
  window.widget.on('metrics', render);
  window.widget.on('settings', render);
  window.widget.api.getState().then(render);
})();
