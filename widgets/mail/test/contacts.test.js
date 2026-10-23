// The address book (#70): learned from mail headers and sends, edits and deletes, search (초성 too), and
// vCard / CSV import (UTF-8 or EUC-KR files). Local only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ContactBook, parseVcard, parseCsv, parseContactsFile, decodeFile, initials } = require('../lib/contacts');

const book = () => new ContactBook(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mail-book-')), 'contacts.json'));
const h = (from, to = [], cc = [], date = Date.now()) => ({ from, to, cc, date });

test('learning from received mail: once per message, own and automated addresses left out', () => {
  const b = book();
  const items = [
    { key: 'a|mid:1', h: h({ name: '김부장', address: 'boss@y.test' }, [{ name: '나', address: 'me@x.test' }, { name: '', address: 'kim@y.test' }]) },
    { key: 'a|mid:2', h: h({ name: '두레이 알림', address: 'noreply@dooray.test' }) },
    { key: 'a|mid:3', h: h({ name: 'Boss', address: 'BOSS@y.test' }) },
  ];
  b.learnHeaders(items, ['me@x.test']);
  b.learnHeaders(items, ['me@x.test']); // a re-sync counts nothing twice
  assert.deepEqual(b.search('', 10).map((c) => [c.address, c.received]), [['boss@y.test', 2], ['kim@y.test', 1]]);
  assert.equal(b.search('boss')[0].name, 'Boss', 'the latest name');
  const again = new ContactBook(b.file);
  assert.equal(again.size(), 2, 'saved');
});

test('sent counts more; edited names stay; deleted addresses do not come back from received mail', () => {
  const b = book();
  b.learnHeaders([{ key: 'k1', h: h({ name: 'A', address: 'a@x.test' }) }, { key: 'k2', h: h({ name: 'B', address: 'b@x.test' }) }]);
  b.learnSent([{ name: '', address: 'b@x.test' }]);
  assert.deepEqual(b.search('', 5).map((c) => c.address), ['b@x.test', 'a@x.test'], 'sent ranks first');
  b.rename('a@x.test', '에이 고객');
  b.learnHeaders([{ key: 'k3', h: h({ name: 'Mr A', address: 'a@x.test' }) }]);
  assert.equal(b.search('a@x')[0].name, '에이 고객', 'the user\'s name wins');
  assert.equal(b.remove('b@x.test'), true);
  b.learnHeaders([{ key: 'k4', h: h({ name: 'B', address: 'b@x.test' }) }]);
  assert.equal(b.search('b@x').length, 0, 'not re-learned from received mail');
  b.learnSent([{ name: 'B', address: 'b@x.test' }]);
  assert.equal(b.search('b@x').length, 1, 'sending to it brings it back');
  assert.throws(() => b.rename('nobody@x.test', 'x'), /없는/);
});

test('search: prefix first, contains, 초성, exclude (already chips), limit', () => {
  const b = book();
  b.importContacts([
    { name: '홍길동', address: 'hong@x.test' },
    { name: '김홍도', address: 'kim@x.test' },
    { name: 'Alice', address: 'alice@hong.test' },
  ]);
  assert.deepEqual(b.search('홍').map((c) => c.address), ['hong@x.test', 'kim@x.test']);
  assert.deepEqual(b.search('hong').map((c) => c.address), ['hong@x.test', 'alice@hong.test']);
  assert.deepEqual(b.search('ㅎㄱㄷ').map((c) => c.address), ['hong@x.test']);
  assert.equal(initials('홍길동 A'), 'ㅎㄱㄷ a');
  assert.deepEqual(b.search('hong', 8, ['HONG@x.test']).map((c) => c.address), ['alice@hong.test']);
  assert.equal(b.search('', 2).length, 2);
});

test('vCard: 3.0 folded lines, several EMAILs, Korean N, 2.1 quoted-printable, escapes', () => {
  const v = [
    'BEGIN:VCARD', 'VERSION:3.0', 'N:홍;길동;;;', 'FN:홍길동', 'EMAIL;TYPE=INTERNET;TYPE=WORK:hong@work.test', 'item1.EMAIL;type=INTERNET:hong@home.te', ' st', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'N:Kim;John;;;', 'EMAIL:john@x.test', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:2.1', 'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=EA=B9=80;=EC=B2=A0=EC=88=98;;;', 'EMAIL;PREF;INTERNET:cs@x.test', 'END:VCARD',
    'BEGIN:VCARD', 'FN:Smith\\, Jane', 'EMAIL:not-an-address', 'END:VCARD',
  ].join('\r\n');
  assert.deepEqual(parseVcard(v), [
    { name: '홍길동', address: 'hong@work.test' },
    { name: '홍길동', address: 'hong@home.test' },
    { name: 'John Kim', address: 'john@x.test' },
    { name: '김철수', address: 'cs@x.test' },
  ]);
});

test('CSV: Google, Outlook, Korean headers, quoted commas, no header; EUC-KR files', () => {
  const google = 'Name,Given Name,Family Name,E-mail 1 - Type,E-mail 1 - Value\r\n"Kim, J",J,Kim,* Work,k@y.test ::: k2@y.test\r\n';
  assert.deepEqual(parseCsv(google), [{ name: 'Kim, J', address: 'k@y.test' }, { name: 'Kim, J', address: 'k2@y.test' }]);
  const outlook = 'First Name,Last Name,E-mail Address\nJane,Doe,jane@x.test\n';
  assert.deepEqual(parseCsv(outlook), [{ name: 'Jane Doe', address: 'jane@x.test' }]);
  const korean = '이름,이메일,전화\n홍길동,hong@x.test,010\n';
  assert.deepEqual(parseCsv(korean), [{ name: '홍길동', address: 'hong@x.test' }]);
  assert.deepEqual(parseCsv('홍길동;hong@x.test\nnobody\n'), [{ name: '홍길동', address: 'hong@x.test' }]);
  const euc = Buffer.concat([Buffer.from('c0ccb8a72cc0ccb8dec0cf0a', 'hex'), Buffer.from('c8abb1e6b5bf2c686f6e6740782e746573740a', 'hex')]); // "이름,이메일\n홍길동,hong@x.test\n"
  assert.equal(decodeFile(euc).split('\n')[0], '이름,이메일');
  assert.deepEqual(parseContactsFile('naver.csv', euc), [{ name: '홍길동', address: 'hong@x.test' }]);
  assert.deepEqual(parseContactsFile('x.vcf', Buffer.from('﻿BEGIN:VCARD\nFN:A\nEMAIL:a@x.test\nEND:VCARD')), [{ name: 'A', address: 'a@x.test' }]);
});

test('import: new and updated counts, imported names fill empty ones', () => {
  const b = book();
  b.learnHeaders([{ key: 'k', h: h({ name: '', address: 'a@x.test' }) }]);
  assert.deepEqual(b.importContacts([{ name: '에이', address: 'a@x.test' }, { name: '비', address: 'b@x.test' }, { name: 'x', address: 'bad' }]), { added: 1, updated: 1 });
  assert.equal(b.search('a@x')[0].name, '에이');
});
