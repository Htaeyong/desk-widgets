// Attachments (#129): checked when added, copied (never moved) into the conversation's own folder when sent, named in the
// prompt for Claude Code's Read tool, kept out of the record except for names and sizes, and deleted with the conversation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAttachmentStore, attachmentNote, imageType, safeName, uniqueName, ATTACH_DIR } = require('../lib/attachments');
const { FAKE_KEY, allFiles } = require('./helpers');
const { ready } = require('./setup');

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function files() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-attach-'));
  const put = (name, data) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return file;
  };
  return { dir, put, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const store = (opts = {}) => createAttachmentStore({ getKey: () => FAKE_KEY, thumbnail: ({ mime }) => `data:${mime};base64,AAAA`, ...opts });

test('images are known by their bytes, not their names', () => {
  assert.deepEqual(imageType(PNG), { mime: 'image/png', ext: '.png' });
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mime, 'image/jpeg');
  assert.equal(imageType(Buffer.from('GIF89a')).mime, 'image/gif');
  assert.equal(imageType(Buffer.from('RIFF0000WEBPVP8 ')).mime, 'image/webp');
  assert.equal(imageType(Buffer.from('<svg xmlns=')), null, 'SVG is a text file here, never drawn');
  assert.equal(imageType(Buffer.from('MZ')), null);
});

test('names are safe to create and never clash', () => {
  assert.equal(safeName('C:\\x\\..\\보고서:최종?.pdf'), '보고서_최종_.pdf');
  assert.equal(safeName('CON.txt'), '_CON.txt');
  assert.equal(safeName('...'), '첨부');
  assert.equal(safeName(`${'가'.repeat(200)}.png`).length, 120);
  const { dir, put, done } = files();
  try {
    put('a.txt', 'x');
    put('a (2).txt', 'x');
    assert.equal(uniqueName(dir, 'a.txt'), 'a (3).txt');
    assert.equal(uniqueName(dir, 'b.txt'), 'b.txt');
  } finally {
    done();
  }
});

test('adding: image with a preview, a document, a fake image, a program, and the limits', () => {
  const { put, done } = files();
  try {
    const s = store({ limits: { files: 3, fileBytes: 1000, totalBytes: 900, pasteBytes: 500, scanBytes: 1000 } });
    const img = s.addPath(put('사진.png', PNG));
    assert.deepEqual([img.ok, img.attachment.kind, img.attachment.mime, img.attachment.thumb.startsWith('data:image/png')], [true, 'image', 'image/png', true]);
    assert.equal(img.attachment.source, undefined, 'the window never gets where the bytes are kept');
    const fake = s.addPath(put('가짜.png', 'not an image'));
    assert.deepEqual([fake.attachment.kind, fake.attachment.thumb], ['file', null]);
    assert.match(fake.attachment.warnings[0], /이미지 형식이 아닙니다/);
    const prog = s.addPath(put('run.ps1', 'Write-Host hi'));
    assert.match(prog.attachment.warnings[0], /실행 파일이나 스크립트/);
    assert.equal(s.addPath(put('d.txt', 'x')).code, 'too-many');
    s.remove(prog.attachment.id);
    assert.equal(s.addPath(put('big.bin', Buffer.alloc(1001))).code, 'too-big');
    assert.equal(s.addPath(put('mid.bin', Buffer.alloc(900))).code, 'too-big', 'the total');
    assert.equal(s.addPath(path.join(os.tmpdir(), 'no-such-file-ai-chat')).code, 'missing');
    assert.equal(s.addPath(os.tmpdir()).code, 'not-file');
  } finally {
    done();
  }
});

test('a text file holding the widget\'s key is refused; other secret-looking text is marked, not refused', () => {
  const { put, done } = files();
  try {
    const s = store();
    const key = s.addPath(put('메모.txt', `키는 ${FAKE_KEY} 입니다`));
    assert.deepEqual([key.ok, key.code], [false, 'key-in-file']);
    assert.ok(!JSON.stringify(key).includes(FAKE_KEY));
    assert.equal(s.addData({ text: `x ${FAKE_KEY}` }).code, 'key-in-file');
    const soft = s.addPath(put('config.env', 'password=hunter2xx'));
    assert.equal(soft.ok, true);
    assert.match(soft.attachment.warnings[0], /비밀처럼 보이는 값/);
    // Images and other binary files are not read for text.
    assert.equal(s.addPath(put('사진.png', Buffer.concat([PNG, Buffer.from(FAKE_KEY)]))).ok, true);
  } finally {
    done();
  }
});

test('pasted bytes: an image gets an image name, long text becomes a file, both held until sent', () => {
  const s = store();
  const img = s.addData({ data: PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) });
  assert.deepEqual([img.attachment.name, img.attachment.kind], ['붙여넣은 이미지.png', 'image']);
  const named = s.addData({ name: 'clip', data: PNG });
  assert.equal(named.attachment.name, 'clip.png');
  const text = s.addData({ name: '붙여넣은 글.txt', text: '가'.repeat(30000) });
  assert.deepEqual([text.attachment.name, text.attachment.kind, text.attachment.size], ['붙여넣은 글.txt', 'file', 90000]);
  assert.equal(s.addData({ data: Buffer.alloc(0) }).code, 'empty');
  const got = s.take([img.attachment.id, text.attachment.id]);
  assert.equal(got.items.length, 2);
  assert.equal(s.has(img.attachment.id), false);
  assert.equal(s.take([img.attachment.id]).error.code, 'gone');
});

test('the prompt names the copies and says images open with Read', () => {
  const note = attachmentNote([{ name: '사진.png', size: 2048, kind: 'image', path: 'C:\\w\\AI Widgets 첨부\\s-1\\사진.png' }, { name: 'a.pdf', size: 3 * 1048576, kind: 'file', path: 'C:\\w\\a.pdf' }]);
  assert.match(note, /Read tool \(it also shows images, so open each image with Read to see it\)/);
  assert.match(note, /- image, 2 KB: C:\\w\\AI Widgets 첨부\\s-1\\사진\.png/);
  assert.match(note, /- file, 3\.0 MB: C:\\w\\a\.pdf/);
  assert.equal(attachmentNote([]), '');
});

// ---- through a send ----

function attach(t, file) {
  const res = t.call('addAttachment', { path: file });
  assert.equal(res.ok, true, res.message);
  return res;
}

test('sending: the notice first, then copies in the conversation\'s folder, paths in the prompt, names only in the record', async () => {
  const t = ready({ strictResume: true });
  const { put, done } = files();
  try {
    const original = put('보고서.pdf', '%PDF-1.4 secret body');
    const image = put('화면.png', PNG);
    const a = attach(t, original);
    assert.equal(a.needsNotice, true);
    const b = attach(t, image);
    const refused = t.call('send', { prompt: '정리해 줘', cwd: t.ws.cwd, attachmentIds: [a.attachment.id, b.attachment.id] });
    assert.deepEqual([refused.ok, refused.code], [false, 'attach-notice']);
    assert.equal(t.call('list').sessions.length, 0, 'nothing started, nothing consumed');
    assert.equal(t.call('ackAttachNotice'), true);
    assert.equal(t.call('addAttachment', { path: image }).needsNotice, false);
    const sent = t.call('send', { prompt: '정리해 줘', cwd: t.ws.cwd, attachmentIds: [a.attachment.id, b.attachment.id] });
    assert.equal(sent.ok, true);
    assert.deepEqual(sent.attachments, [{ name: '보고서.pdf', size: 20, kind: 'file' }, { name: '화면.png', size: PNG.length, kind: 'image' }]);
    await t.doneOf(sent.sessionId);
    const folder = path.join(t.ws.cwd, ATTACH_DIR, sent.sessionId);
    assert.deepEqual(fs.readdirSync(folder).sort(), ['보고서.pdf', '화면.png']);
    assert.equal(fs.readFileSync(original, 'utf8'), '%PDF-1.4 secret body', 'the original stays where it was');
    const { prompt } = t.ws.calls()[0];
    assert.match(prompt, /^정리해 줘\n\nThe user attached these files/);
    assert.ok(prompt.includes(path.join(folder, '화면.png')));
    const you = t.call('open', sent.sessionId).items.find((i) => i.k === 'you');
    assert.deepEqual(you.attachments, sent.attachments);
    const record = fs.readFileSync(path.join(t.fake.ctx.dataDir, 'sessions', `${sent.sessionId}.jsonl`), 'utf8');
    assert.ok(!record.includes('secret body') && !record.includes(folder), 'no contents, no paths in the record');
  } finally {
    t.cleanup();
    done();
  }
});

test('attachments only, no words: allowed, and the title is the first file\'s name', async () => {
  const t = ready({}, { initial: { attachNoticeSeen: true } });
  const { put, done } = files();
  try {
    const a = attach(t, put('견적서.xlsx', 'PK'));
    const sent = t.call('send', { prompt: '  ', cwd: t.ws.cwd, attachmentIds: [a.attachment.id] });
    assert.equal(sent.ok, true);
    await t.doneOf(sent.sessionId);
    assert.equal(t.call('list').sessions[0].title, '견적서.xlsx');
    assert.match(t.ws.calls()[0].prompt, /^Please look at the attached files\./);
  } finally {
    t.cleanup();
    done();
  }
});

test('same names in one conversation do not overwrite; a later prompt finds the earlier copies still there', async () => {
  const t = ready({ strictResume: true }, { initial: { attachNoticeSeen: true } });
  const { put, done } = files();
  try {
    const file = put('a.txt', '첫');
    const first = t.call('send', { prompt: 'x', cwd: t.ws.cwd, attachmentIds: [attach(t, file).attachment.id] });
    await t.doneOf(first.sessionId);
    fs.writeFileSync(file, '둘');
    const second = t.call('send', { prompt: 'y', sessionId: first.sessionId, attachmentIds: [attach(t, file).attachment.id] });
    await t.doneOf(first.sessionId, 2);
    assert.deepEqual(second.attachments.map((a) => a.name), ['a (2).txt']);
    const folder = path.join(t.ws.cwd, ATTACH_DIR, first.sessionId);
    assert.deepEqual([fs.readFileSync(path.join(folder, 'a.txt'), 'utf8'), fs.readFileSync(path.join(folder, 'a (2).txt'), 'utf8')], ['첫', '둘']);
    assert.ok(t.ws.calls()[1].args.includes('--resume'));
  } finally {
    t.cleanup();
    done();
  }
});

test('deleting the conversation deletes its copies, and only its own; erasing just the Claude record keeps them', async () => {
  const t = ready({ strictResume: true }, { initial: { attachNoticeSeen: true } });
  const { put, done } = files();
  try {
    const file = put('a.txt', 'x');
    const one = t.call('send', { prompt: 'x', cwd: t.ws.cwd, attachmentIds: [attach(t, file).attachment.id] });
    await t.doneOf(one.sessionId);
    const two = t.call('send', { prompt: 'y', cwd: t.ws.cwd, attachmentIds: [attach(t, file).attachment.id] });
    await t.doneOf(two.sessionId);
    const dirOf = (id) => path.join(t.ws.cwd, ATTACH_DIR, id);
    assert.equal(t.call('clearRecord', one.sessionId).ok, true);
    assert.ok(fs.existsSync(dirOf(one.sessionId)), 'the conversation stays readable with its files');
    assert.equal(t.call('remove', one.sessionId).ok, true);
    assert.ok(!fs.existsSync(dirOf(one.sessionId)));
    assert.ok(fs.existsSync(dirOf(two.sessionId)));
    assert.ok(fs.existsSync(file), 'the original is never touched');
  } finally {
    t.cleanup();
    done();
  }
});

test('a refusal before sending keeps the attachments for the next try', () => {
  const t = ready({}, { initial: { attachNoticeSeen: true } });
  const { put, done } = files();
  try {
    const a = attach(t, put('a.txt', 'x'));
    const res = t.call('send', { prompt: 'x', cwd: path.join(t.ws.dir, 'new folder'), attachmentIds: [a.attachment.id] });
    assert.equal(res.code, 'folder-confirm');
    assert.equal(t.call('send', { prompt: 'x', cwd: t.ws.cwd, attachmentIds: [a.attachment.id] }).ok, true);
    assert.equal(t.call('send', { prompt: 'x', cwd: t.ws.cwd, attachmentIds: ['0000'] }).code, 'gone');
  } finally {
    t.cleanup();
    done();
  }
});

test('nothing of an attachment reaches the window but its name, size, kind, warnings and a preview', () => {
  const t = ready();
  const { put, done } = files();
  try {
    const res = attach(t, put('사진.png', PNG));
    assert.deepEqual(Object.keys(res.attachment).sort(), ['id', 'kind', 'mime', 'name', 'size', 'thumb', 'warnings']);
    for (const f of allFiles(t.fake.ctx.dataDir)) assert.ok(!fs.readFileSync(f).includes(PNG), f);
  } finally {
    t.cleanup();
    done();
  }
});
