// Clock face of the clock themes (theme contract v1, #60): draws the time from this page's own clock and redraws
// on the next second (or minute) boundary only; the widget sends settings changes, never a tick.
const SVG_NS = 'http://www.w3.org/2000/svg';
const W = window.widget;
// The page decides its layout (the analog theme has its own index.html with data-layout="analog").
const layout = document.body.dataset.layout === 'analog' ? 'analog' : 'digital';
let view = { showSeconds: false, hour12: false, locale: 'ko-KR', tools: false };
let timer = null;

const $ = (id) => document.getElementById(id);

function buildTicks() {
  const ticks = $('ticks');
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', major ? 'tick major' : 'tick');
    line.setAttribute('x1', '100');
    line.setAttribute('x2', '100');
    line.setAttribute('y1', '10');
    line.setAttribute('y2', major ? '22' : '15');
    line.setAttribute('transform', `rotate(${i * 6} 100 100)`);
    ticks.appendChild(line);
  }
}

const rotate = (id, degrees) => $(id).setAttribute('transform', `rotate(${degrees} 100 100)`);
const dateText = (now) => now.toLocaleDateString(view.locale, { month: 'long', day: 'numeric', weekday: 'short' });

const timeText = (now) =>
  now.toLocaleTimeString(view.locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(view.showSeconds ? { second: '2-digit' } : {}),
    hour12: view.hour12,
  });

function drawDigital(now) {
  $('time').textContent = timeText(now);
  $('date').textContent = dateText(now);
}

function drawAnalog(now) {
  const s = now.getSeconds();
  const minutes = now.getMinutes() + (view.showSeconds ? s / 60 : 0);
  const hours = (now.getHours() % 12) + now.getMinutes() / 60;
  rotate('hourHand', hours * 30);
  rotate('minuteHand', minutes * 6);
  // The second hand only exists while seconds are shown (the redraw is per minute otherwise).
  $('secondHand').setAttribute('visibility', view.showSeconds ? 'visible' : 'hidden');
  if (view.showSeconds) rotate('secondHand', s * 6);
  $('faceDate').textContent = dateText(now);
}

function draw() {
  const now = new Date();
  // Stopwatch / timer / alarm tabs ("스톱워치·타이머 사용"), drawn by tools.js.
  document.body.dataset.tools = view.tools ? 'on' : 'off';
  if (layout === 'analog') drawAnalog(now);
  else drawDigital(now);
  clearTimeout(timer);
  const step = view.showSeconds ? 1000 : 60000;
  timer = setTimeout(draw, step - (now.getTime() % step) + 5);
}

// Right-click: the widget's menu (always on top, stopwatch/timer, theme) and the engine's (settings, quit ...).
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  W.window.openMenu();
});

buildTicks();
// One getState for both scripts: tools.js waits for the same answer.
window.clockState = W.api.getState().then((res) => (res && res.ok ? res.result : null));
W.on('settings', (next) => {
  view = { ...view, ...next };
  draw();
});
window.clockState.then((state) => {
  if (state) view = { ...view, ...state.settings };
  draw();
});
draw();
