// --mock-data (#65): fictional accounts and mail so themes can be built and tried without any account.
// MockAccount has the same surface as AccountSync (lib/account.js); nothing leaves the process. One new
// message "arrives" shortly after start so the new-mail card can be seen.
const { EventEmitter } = require('events');
const crypto = require('crypto');

// The same folder key as lib/account.js (#80); kept here so the mock needs no IMAP code.
const folderKeyOf = (raw) => crypto.createHash('sha1').update(String(raw)).digest('hex').slice(0, 8);
// #80: one account has a rule-sorted mailbox chosen, so folder names and counts can be seen with --mock-data.
const MOCK_FOLDERS = { 'mock-daum': [{ raw: 'Cafe', name: '카페 알림' }] };

const MOCK_ACCOUNTS = [
  { id: 'mock-work', name: '회사 (두레이)', provider: 'dooray', host: 'imap.dooray.com', port: 993, security: 'tls', smtpHost: 'smtp.dooray.com', smtpPort: 465, smtpSecurity: 'tls', saveSent: 'auto', senderName: '나', signature: '나\n회사 개발팀', username: 'me@company.example', email: 'me@company.example', color: '#4f8cff', enabled: true, notify: true, compose: 'mailto', openWith: 'widget', webmail: 'https://company.dooray.com/mail' },
  { id: 'mock-naver', name: '개인 (네이버)', provider: 'naver', host: 'imap.naver.com', port: 993, security: 'tls', smtpHost: 'smtp.naver.com', smtpPort: 465, smtpSecurity: 'tls', saveSent: 'auto', senderName: '', signature: '', username: 'me', email: 'me@naver.example', color: '#3ccf8e', enabled: true, notify: true, compose: 'webmail', openWith: 'widget', webmail: 'https://mail.naver.com/' },
  { id: 'mock-gmail', name: 'Gmail', provider: 'gmail', host: 'imap.gmail.com', port: 993, security: 'tls', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecurity: 'tls', saveSent: 'auto', senderName: '', signature: '', username: 'me@gmail.example', email: 'me@gmail.example', color: '#ff6b6b', enabled: true, notify: true, compose: 'webmail', openWith: 'widget', webmail: 'https://mail.google.com/' },
  // #72: more accounts so the 계정 대시보드 grid can be tried (one of them in an error state).
  { id: 'mock-daum', name: '다음 메일', provider: 'daum', host: 'imap.daum.net', port: 993, security: 'tls', smtpHost: 'smtp.daum.net', smtpPort: 465, smtpSecurity: 'tls', saveSent: 'auto', senderName: '', signature: '', username: 'me@daum.example', email: 'me@daum.example', color: '#ff9f43', enabled: true, notify: true, compose: 'widget', openWith: 'widget', webmail: 'https://mail.daum.net/' },
  { id: 'mock-team', name: '팀 공용 (두레이)', provider: 'dooray', host: 'imap.dooray.com', port: 993, security: 'tls', smtpHost: 'smtp.dooray.com', smtpPort: 465, smtpSecurity: 'tls', saveSent: 'auto', senderName: '개발팀', signature: '개발팀 드림', username: 'team@company.example', email: 'team@company.example', color: '#a78bfa', enabled: true, notify: true, compose: 'widget', openWith: 'widget', webmail: 'https://company.dooray.com/mail' },
  { id: 'mock-shop', name: '쇼핑 (Gmail)', provider: 'gmail', host: 'imap.gmail.com', port: 993, security: 'tls', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecurity: 'tls', saveSent: 'auto', senderName: '', signature: '', username: 'shop@gmail.example', email: 'shop@gmail.example', color: '#2dd4bf', enabled: true, notify: false, compose: 'widget', openWith: 'widget', webmail: 'https://mail.google.com/' },
  { id: 'mock-old', name: '예전 회사 (기타 IMAP)', provider: 'other', host: 'imap.old.example', port: 993, security: 'tls', smtpHost: 'smtp.old.example', smtpPort: 465, smtpSecurity: 'tls', saveSent: 'auto', senderName: '', signature: '', username: 'me@old.example', email: 'me@old.example', color: '#f472b6', enabled: true, notify: true, compose: 'widget', openWith: 'widget', webmail: '', mockError: '서버가 로그인을 거절했습니다 (예시 오류, --mock-data)' },
];

const H = 3600000;
const person = (name, address) => ({ name, address });

/** Sample mail per account: [hoursAgo, from, subject, { unread, flagged, attachments, html | text }] */
function seed(now) {
  const m = (uid, hoursAgo, from, subject, opts = {}) => ({
    uid,
    date: now - hoursAgo * H,
    sentDate: now - hoursAgo * H,
    subject,
    from,
    to: [person('나', 'me@company.example')],
    cc: opts.cc || [],
    replyTo: [],
    messageId: `<mock-${uid}@desk-widgets.invalid>`,
    unread: Boolean(opts.unread),
    flagged: Boolean(opts.flagged),
    answered: false,
    hasAttachments: Boolean(opts.attachments?.length),
    snippet: null,
    body: { html: opts.html || '', text: opts.text || '', attachments: opts.attachments || [] },
  });
  const boss = person('김부장', 'boss@company.example');
  return {
    'mock-work': [
      m(108, 0.2, boss, '[긴급] 내일 오전 10시 고객사 회의 자료 부탁드립니다', {
        unread: true,
        flagged: true,
        text: '안녕하세요,\n\n내일 오전 10시 고객사 회의에 쓸 자료를 오늘 중으로 공유 부탁드립니다.\n지난주 보고서의 3장 수치를 최신으로 바꿔 주세요.\n\n감사합니다.\n김부장 드림',
      }),
      m(107, 1.5, person('두레이 알림', 'noreply@dooray.example'), '[프로젝트] 업무 "위젯 테마 검토"에 댓글이 달렸습니다', {
        unread: true,
        html: '<div style="font-family:sans-serif"><h2 style="color:#2a62d3">업무 댓글</h2><p><b>이디자인</b>님이 댓글을 남겼습니다.</p><blockquote>다크 글래스 시안 좋습니다. 글자 대비만 조금 올려 주세요.</blockquote><p><a href="https://company.dooray.example/project/1">두레이에서 보기</a></p><img src="https://tracker.example.com/pixel.gif" width="1" height="1"><img src="https://cdn.example.com/banner.png" alt="배너"></div>',
      }),
      m(106, 5, person('박대리', 'park@company.example'), '주간 보고서 초안 (첨부)', {
        attachments: [{ name: '주간보고_10월3주.xlsx', size: 48211, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, { name: '그래프.png', size: 120300, type: 'image/png' }],
        text: '부장님, 주간 보고서 초안 첨부합니다.\n검토 부탁드립니다.\n\n박대리',
      }),
      m(105, 26, boss, 'Re: 휴가 일정', { text: '네, 그 주는 괜찮습니다. 일정 공유해 주세요.\n\n> 다음 달 둘째 주에 휴가를 쓰려고 합니다.' }),
      m(104, 50, person('인사팀', 'hr@company.example'), '[공지] 연말정산 안내', { html: '<p>2026년 연말정산 일정 안내입니다.</p><table border="1" cellpadding="4"><tr><th>항목</th><th>기한</th></tr><tr><td>자료 제출</td><td>1월 20일</td></tr><tr><td>확인</td><td>1월 31일</td></tr></table><script>alert(1)</script><p onclick="steal()">문의: 인사팀</p>' }),
    ],
    'mock-naver': [
      m(53, 0.6, person('네이버페이', 'pay@naver.example'), '주문하신 상품이 발송되었습니다', { unread: true, html: '<p>주문하신 <b>무선 키보드</b>가 발송되었습니다.</p><p>배송 조회: <a href="https://delivery.example.com/track?id=1">바로가기</a></p><p><a href="javascript:alert(1)">위험한 링크</a></p>' }),
      m(52, 9, person('엄마', 'mom@naver.example'), '주말에 올 거니?', { unread: true, text: '이번 주말에 올 수 있으면 연락 줘.\n김치 담갔어.' }),
      m(51, 30, person('동창회', 'class@naver.example'), '동창회 장소 투표', { flagged: true, text: '장소 투표 부탁해!\n1. 강남\n2. 홍대\n3. 종로' }),
    ],
    'mock-gmail': [
      m(31, 3, person('GitHub', 'noreply@github.example'), '[desk-widgets] New issue: 메일 위젯 테마 제안', { unread: true, text: 'A new issue was opened.\n\n메일 위젯에 작은 카드 테마가 있으면 좋겠습니다.\nhttps://github.example/desk-widgets/issues/1' }),
      m(30, 20, person('Google', 'no-reply@accounts.google.example'), '보안 알림: 새 기기에서 로그인', { html: '<div style="max-width:480px"><p>새 Windows 기기에서 Google 계정에 로그인했습니다.</p><p style="background:url(https://img.example.com/bg.png)">본인이 아니면 <a href="https://myaccount.google.example/security">보안 확인</a>을 하세요.</p></div>' }),
      m(29, 72, person('Newsletter', 'news@letter.example'), 'This week in desktop widgets', { text: 'Hello,\n\nThis week: themes, notification cards and more.\n' }),
    ],
    'mock-daum': [
      m(73, 2, person('다음 카페', 'cafe@daum.example'), '[카페] 새 글 알림: 주말 등산 모임', { unread: true, text: '주말 등산 모임 공지가 올라왔습니다.' }),
      m(72, 40, person('은행', 'bank@bank.example'), '10월 카드 이용 내역', { flagged: true, text: '10월 카드 이용 내역을 안내드립니다.' }),
    ],
    'mock-team': [
      m(93, 0.4, person('배포 봇', 'deploy@company.example'), '[배포] 메일 위젯 0.0.1 빌드 완료', { unread: true, text: '빌드가 끝났습니다.' }),
      m(92, 1, person('이디자인', 'lee@company.example'), '대시보드 시안 공유드립니다', { unread: true, flagged: true, attachments: [{ name: '대시보드.png', size: 300000, type: 'image/png' }], text: '시안 첨부합니다. 의견 주세요.' }),
      m(91, 6, person('박대리', 'park@company.example'), '회의록 (10/19)', { text: '오늘 회의록입니다.' }),
      m(90, 30, person('김부장', 'boss@company.example'), '다음 주 일정', { unread: true, text: '다음 주 일정 확인 부탁합니다.' }),
    ],
    'mock-shop': [
      m(13, 4, person('쇼핑몰', 'shop@mall.example'), '주문이 확인되었습니다', { unread: true, text: '주문 번호 1234' }),
      m(12, 50, person('쇼핑몰', 'shop@mall.example'), '가을 세일 안내', { text: '최대 50% 할인' }),
    ],
    'mock-old': [],
  };
}

/** The message that "arrives" after start. */
const arrival = (now) => ({
  uid: 109,
  date: now,
  sentDate: now,
  subject: '점심 같이 하실래요? 🍜',
  from: person('이디자인', 'lee@company.example'),
  to: [person('나', 'me@company.example')],
  cc: [],
  replyTo: [],
  messageId: '<mock-109@desk-widgets.invalid>',
  unread: true,
  flagged: false,
  answered: false,
  hasAttachments: false,
  snippet: null,
  body: { html: '', text: '12시에 1층에서 만나요!\n\n이디자인', attachments: [] },
});

class MockAccount extends EventEmitter {
  constructor({ account, now = Date.now, arriveAfterMs = 20000, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout }) {
    super();
    this.account = account;
    this.now = now;
    this.st = st;
    this.ct = ct;
    this.arriveAfterMs = arriveAfterMs;
    this.all = (seed(now())[account.id] || []).sort((a, b) => b.date - a.date);
    this.loaded = Math.min(this.all.length, 4);
    const now0 = now();
    this.folderMsgs = (MOCK_FOLDERS[account.id] || []).flatMap((f, i) =>
      [0, 1].map((n) => ({
        uid: 300 + i * 10 + n,
        date: now0 - (n * 5 + 1) * 3600000,
        sentDate: now0,
        subject: n ? '[카페] 지난주 모임 사진' : '[카페] 이번 주 모임 장소 변경',
        from: { name: '다음 카페', address: 'cafe@daum.example' },
        to: [],
        cc: [],
        replyTo: [],
        messageId: `<mock-folder-${i}-${n}@desk-widgets.invalid>`,
        unread: n === 0,
        flagged: false,
        answered: false,
        hasAttachments: false,
        snippet: null,
        folder: f.name,
        folderKey: folderKeyOf(f.raw),
        body: { html: '', text: '서버 규칙으로 "카페 알림" 메일함에 들어간 메일입니다.', attachments: [] },
      })),
    );
    this.status = { state: 'off', error: null, kind: null, lastSync: null };
    this.timer = null;
  }

  get messages() {
    return new Map(this.all.slice(0, this.loaded).map((m) => [m.uid, m]));
  }

  get unread() {
    return this.all.filter((m) => m.unread).length;
  }

  get flagged() {
    return this.all.filter((m) => m.flagged).length;
  }

  get hasMore() {
    return this.loaded < this.all.length;
  }

  list() {
    for (const m of [...this.all, ...this.folderMsgs]) if (m.snippet === null) m.snippet = (m.body.text || m.body.html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 160);
    return [...this.all.slice(0, this.loaded), ...this.folderMsgs].sort((a, b) => b.date - a.date);
  }

  find(uid, folderKey = '') {
    return (folderKey ? this.folderMsgs.find((m) => m.uid === uid && m.folderKey === folderKey) : this.all.find((m) => m.uid === uid)) || null;
  }

  /** #83: the made-up server's 안 읽음 / 중요 mail (all of it, loaded or not), like AccountSync.markedList. */
  markedList(kinds = {}) {
    this.list();
    const headers = [...this.all, ...this.folderMsgs].filter((m) => (!kinds.unread || m.unread) && (!kinds.flagged || m.flagged)).sort((a, b) => b.date - a.date);
    return { headers, total: headers.length, missing: false };
  }

  demandMarked() {
    return Promise.resolve(0);
  }

  any(uid) {
    return this.all.find((x) => x.uid === uid) || this.folderMsgs.find((x) => x.uid === uid);
  }

  totalUnread() {
    return this.markedList({ unread: true }).total;
  }

  totalFlagged() {
    return this.markedList({ flagged: true }).total;
  }

  folderInfo() {
    return (MOCK_FOLDERS[this.account.id] || []).map((f) => ({ key: folderKeyOf(f.raw), name: f.name, unread: this.folderMsgs.filter((m) => m.folderKey === folderKeyOf(f.raw) && m.unread).length, error: null }));
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.status = this.account.mockError ? { ...this.status, state: 'error', error: this.account.mockError, kind: 'auth' } : { ...this.status, state: 'ok', lastSync: this.now() };
    this.emit('changed');
    if (this.account.id === 'mock-work' && this.arriveAfterMs > 0) {
      this.timer = this.st(() => {
        const m = arrival(this.now());
        this.all.unshift(m);
        this.loaded++;
        this.list();
        this.emit('changed');
        this.emit('new', [m]);
      }, this.arriveAfterMs);
    }
  }

  stop() {
    this.started = false;
    this.ct(this.timer);
    this.status = { ...this.status, state: 'off' };
  }

  setPaused() {}

  refresh() {
    if (this.account.mockError) return Promise.resolve({ ok: false, message: this.account.mockError });
    this.status = { ...this.status, lastSync: this.now() };
    this.emit('changed');
    return Promise.resolve({ ok: true, fresh: 0 });
  }

  async loadMore(count) {
    const before = this.loaded;
    this.loaded = Math.min(this.all.length, this.loaded + count);
    this.emit('changed');
    return this.loaded - before;
  }

  async body(uid) {
    const m = this.any(uid);
    if (!m) throw new Error('메일을 찾지 못했습니다.');
    return { html: m.body.html, text: m.body.text, cid: {}, attachments: m.body.attachments, truncated: false, references: [] };
  }

  async setFlag(uid, flag, on = true) {
    const m = this.any(uid);
    if (m && flag === '\\Answered') m.answered = on;
    this.emit('changed');
  }

  /** Forwarding: the sample attachments as small made-up files. */
  async attachmentsOf(uid, maxBytes) {
    const m = this.any(uid);
    const list = m?.body.attachments || [];
    const total = list.reduce((n, a) => n + a.size, 0);
    if (total > maxBytes) return { parts: [], skipped: list.map((a) => a.name) };
    return { parts: list.map((a) => ({ name: a.name, type: a.type, data: Buffer.alloc(Math.min(a.size, 1024), 0x20) })), skipped: [] };
  }

  async setSeen(uid, seen) {
    const m = this.any(uid);
    if (m) m.unread = !seen;
    this.emit('changed');
  }
}

module.exports = { MOCK_ACCOUNTS, MOCK_FOLDERS, MockAccount, seed };
