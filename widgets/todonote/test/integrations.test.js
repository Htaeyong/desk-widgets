// The sticky notes as the to-do side of the integrations (#111, design 8): notes from Dooray / Mail, the calendar's
// snapshot, date edits and "노트 열기".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('./fake-engine');
const X = require('../lib/external');

function broker() {
  const handlers = {};
  const enabled = {};
  const published = [];
  return {
    handlers,
    enabled,
    published,
    expose: (m, fn) => ((handlers[m] = fn), true),
    setEnabled: (peer, on) => ((enabled[peer] = on), true),
    publish: (e, p) => (published.push([e, p]), true),
    status: () => ({ brokerAvailable: true, installed: true, running: true, peerEnabled: true }),
    onStatus: () => () => {},
  };
}

test('a Dooray task becomes a note with its text, link and details; the same task twice opens that note', async () => {
  const b = broker();
  const t = setup({ initial: { receiveDooray: true }, integrations: b });
  await t.w.start();
  assert.deepEqual(b.enabled, { dooray: true, mail: false, calendar: false });
  const dueAt = new Date(2026, 9, 30, 23, 59).getTime();
  const input = {
    title: '[기획] 견적서 회신',
    dueAt,
    dateOnly: true,
    body: '## 요청\n\n- 단가 확인\n<script>alert(1)</script>\n',
    bodyFormat: 'markdown',
    details: ['프로젝트 영업지원', '담당 홍길동', '마감 10/30'],
    source: { itemId: '3912345678901234567', url: 'https://example.dooray.com/project/posts/3912345678901234567' },
  };
  const r = await b.handlers['notes.addExternal'](input, { sourceId: 'dooray' });
  assert.equal(r.ok, true);
  assert.equal(r.result.existing, false);
  // #113: an id file name; the title is in front matter.
  const file = t.fileByTitle('[기획] 견적서 회신');
  assert.match(path.basename(file), /^\d{8}-\d{6}-[0-9a-z]+\.md$/);
  const text = t.read(file);
  assert.match(text, /^---\ntitle: "\[기획\] 견적서 회신"\ncreated: \S+\ndue: 2026-10-30\nsource: dooray\nsource-id: 3912345678901234567\nsource-url: https:\/\/example\.dooray\.com\/project\/posts\/3912345678901234567\ndesk-widgets-memo: /);
  assert.match(text, /\n# \\\[기획\\\] 견적서 회신\n\n\[두레이에서 열기\]\(https:\/\/example\.dooray\.com\/project\/posts\/3912345678901234567\) · 프로젝트 영업지원 · 담당 홍길동 · 마감 10\/30\n\n---\n\n## 요청/);
  assert.equal(t.memoWindows().length, 1, 'the new note opens');
  // The note window shows the text through its sanitizer: the script stays text.
  const init = await t.call(t.memoWindows()[0], 'init');
  assert.doesNotMatch(init.html, /<script/);
  const again = await b.handlers['notes.addExternal'](input, { sourceId: 'dooray' });
  assert.equal(again.result.existing, true);
  assert.equal(fs.readdirSync(t.notes).filter((f) => f.endsWith('.md')).length, 1);
  t.w.stop();
});

test('a mail becomes a note with its plain text (cut at 20,000 characters) and attachment names only', async () => {
  const b = broker();
  const t = setup({ initial: { receiveMail: true }, integrations: b });
  await t.w.start();
  const long = `# 이건 제목이 아님\n> 인용\n${'가'.repeat(25000)}`;
  const r = await b.handlers['notes.addExternal']({ title: 'RE: 일정', body: long, bodyFormat: 'text', attachments: ['견적.pdf'], details: ['보낸 사람 김철수'], source: { itemId: 'acc/INBOX/12' } }, { sourceId: 'mail' });
  assert.equal(r.ok, true);
  const file = t.fileByTitle('RE 일정');
  assert.match(path.basename(file), /^\d{8}-\d{6}-[0-9a-z]+\.md$/);
  const text = t.read(file);
  assert.match(text, /source: mail\nsource-id: acc\/INBOX\/12\n/);
  assert.doesNotMatch(text, /^due:/m, 'no date chosen: a plain note');
  assert.match(text, /\\# 이건 제목이 아님/, 'plain text stays text');
  assert.match(text, /…\(원본에서 계속\)/);
  assert.match(text, /첨부 \(원본에 있음\): 견적\.pdf/);
  assert.ok(text.length < 21000);
  t.w.stop();
});

test('switched off, from an unknown widget, or with bad input: refused', async () => {
  const b = broker();
  const t = setup({ integrations: b });
  await t.w.start();
  assert.equal((await b.handlers['notes.addExternal']({ title: 'x', source: { itemId: '1' } }, { sourceId: 'dooray' })).ok, false);
  assert.equal((await b.handlers['notes.addExternal']({ title: 'x', source: { itemId: '1' } }, { sourceId: 'clock' })).ok, false);
  t.w.settings.save({ receiveDooray: true });
  assert.equal(b.enabled.dooray, true);
  assert.equal((await b.handlers['notes.addExternal']({ title: 'x', source: {} }, { sourceId: 'dooray' })).ok, false);
  assert.equal((await b.handlers['notes.addExternal']({ title: 'x', dueAt: -5, source: { itemId: '1' } }, { sourceId: 'dooray' })).ok, false);
  assert.equal(X.externalNote('dooray', { title: 'x', source: { itemId: '1', url: 'javascript:alert(1)' } }).fm['source-url'], undefined);
  t.w.stop();
});

test('the calendar: snapshot of notes with a due, date edits write only the due line, notes.changed, 노트 열기', async () => {
  const b = broker();
  const t = setup({ initial: { shareCalendar: true }, integrations: b });
  const file = t.writeNote('월간 보고', { id: 'cal1', fm: ['tags: [보고]', 'due: 2026-11-01 09:00', 'repeat: 매월 1일'], body: '본문\n' });
  t.writeNote('그냥', { id: 'cal2' });
  t.writeNote('끝', { id: 'cal3', dir: path.join(t.notes, '완료'), fm: ['due: 2026-10-01', 'completed: 2026-10-02 10:00'] });
  await t.w.start();
  assert.equal((await b.handlers['notes.snapshot']({}, { sourceId: 'dooray' })).ok, false);
  const snap = await b.handlers['notes.snapshot']({}, { sourceId: 'calendar' });
  const by = Object.fromEntries(snap.result.tasks.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(by).sort(), ['cal1', 'cal3']);
  assert.deepEqual(by.cal1, { id: 'cal1', title: '월간 보고', dueAt: new Date(2026, 10, 1, 9).getTime(), dateOnly: false, completedAt: null, repeat: '매월 1일', source: null });
  assert.equal(by.cal3.dateOnly, true);
  assert.equal(by.cal3.completedAt, new Date(2026, 9, 2, 10).getTime());
  const moved = await b.handlers['notes.updateDue']({ taskId: 'cal1', dueAt: new Date(2026, 10, 2, 14, 30).getTime(), dateOnly: false }, { sourceId: 'calendar' });
  assert.equal(moved.ok, true);
  assert.equal(t.read(file), '---\ntitle: 월간 보고\ntags: [보고]\ndue: 2026-11-02 14:30\nrepeat: 매월 1일\ndesk-widgets-memo: cal1\n---\n본문\n');
  await t.until(() => b.published.length > 0, 1000);
  assert.deepEqual(b.published[0], ['notes.changed', {}]);
  assert.equal((await b.handlers['notes.updateDue']({ taskId: 'cal2', dueAt: Date.now(), dateOnly: true }, { sourceId: 'calendar' })).ok, false, 'a plain note has no due to move');
  assert.equal(b.handlers['notes.open']({ id: 'cal1' }, { sourceId: 'calendar' }).ok, true);
  assert.equal(t.memoWindows().length, 1);
  assert.equal(b.handlers['notes.open']({ id: 'cal1' }, { sourceId: 'clock' }).ok, false);
  t.w.settings.save({ shareCalendar: false });
  assert.equal((await b.handlers['notes.snapshot']({}, { sourceId: 'calendar' })).ok, false);
  t.w.stop();
});

test('an engine without integrations (API 1.2 - 1.6): notes and to-dos work, nothing is exposed', async () => {
  const t = setup();
  t.writeNote('할 일', { id: 'noint', fm: ['due: 2026-11-01'] });
  await t.w.start();
  assert.equal(t.w.settings.get().integrationStatus.dooray.brokerAvailable, false);
  t.w.stop();
});
