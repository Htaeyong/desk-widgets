const test = require('node:test');
const assert = require('node:assert/strict');

// widgets/dooray/renderer/search.js is a browser script that registers window.TaskSearch.
global.window = {};
require('../renderer/search.js');
const { parse, matches, toChosung } = window.TaskSearch;

const task = {
  subject: '로그인 화면 레이아웃 수정',
  key: '모바일앱-리뉴얼/101',
  projectName: '모바일앱-리뉴얼',
  workflowName: '처리중',
  assignees: [{ id: 'm-2', name: '이서연' }],
  author: { id: 'm-1', name: '김민준' },
};

test('chosung keeps length and maps syllables', () => {
  assert.equal(toChosung('로그인 abc'), 'ㄹㄱㅇ abc');
  assert.equal(toChosung('가힣').length, 2);
});

test('parse splits on whitespace and lowercases', () => {
  assert.deepEqual(parse('  API   응답 '), ['api', '응답']);
  assert.deepEqual(parse(''), []);
});

test('all terms must match across fields', () => {
  assert.ok(matches(task, parse('로그인')));
  assert.ok(matches(task, parse('레이아웃 이서연')), 'subject + assignee');
  assert.ok(matches(task, parse('/101')), 'task number');
  assert.ok(matches(task, parse('리뉴얼 처리중')), 'project + workflow');
  assert.ok(matches(task, parse('김민준')), 'author');
  assert.ok(!matches(task, parse('로그인 박지호')), 'AND semantics');
});

test('initial consonant search', () => {
  assert.ok(matches(task, parse('ㄹㄱㅇ')));
  assert.ok(matches(task, parse('ㅇㅅㅇ')), 'assignee chosung');
  assert.ok(!matches(task, parse('ㅂㅈㅎ')));
});

test('tags are searchable, including chosung', () => {
  const tagged = { ...task, tags: [{ id: 't', name: '고객사: 예시시청', color: '', group: '고객사' }] };
  assert.ok(matches(tagged, parse('예시시청')));
  assert.ok(matches(tagged, parse('ㅇㅅㅅㅊ')));
  assert.ok(matches(tagged, parse('고객사 로그인')));
  assert.ok(!matches(task, parse('예시시청')), 'untagged task');
});
