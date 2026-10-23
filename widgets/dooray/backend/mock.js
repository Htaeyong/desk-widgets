// Fictional Dooray data for theme development and screenshots (--mock-data).
// Output has the same shape as the raw Dooray API so it goes through the real aggregator.

const DOMAIN = 'example.dooray.com';
const DAY_MS = 24 * 60 * 60 * 1000;

const MEMBERS = [
  { id: 'm-1', name: '김민준' },
  { id: 'm-2', name: '이서연' },
  { id: 'm-3', name: '박지호' },
  { id: 'm-4', name: '최유나' },
  { id: 'm-5', name: '정하준' },
];
const ME = MEMBERS[0];

const WORKFLOWS = {
  backlog: { id: 'wf-b', name: '대기' },
  registered: { id: 'wf-r', name: '접수' },
  working: { id: 'wf-w', name: '처리중' },
  review: { id: 'wf-v', name: '검토중' },
};

const TAGS = [
  { id: 'tag-c1', name: '고객사: 예시시청', color: 'ECF7FF', tagGroup: { name: '고객사' } },
  { id: 'tag-c2', name: '고객사: 예시군청', color: 'ECF7FF', tagGroup: { name: '고객사' } },
  { id: 'tag-c3', name: '고객사: 예시재단', color: 'ECF7FF', tagGroup: { name: '고객사' } },
  { id: 'tag-p1', name: '제품: 문서관리', color: 'FFF2EB', tagGroup: { name: '제품' } },
  { id: 'tag-p2', name: '제품: 전자결재', color: 'FFF2EB', tagGroup: { name: '제품' } },
  { id: 'tag-u', name: '긴급', color: 'FFEBF0', tagGroup: null },
];

// [code, description, openTaskCount, closedRecently]
const PROJECTS = [
  ['모바일앱-리뉴얼', '고객용 모바일 앱 2.0 개편', 14, 6],
  ['사내포털-고도화', '그룹웨어 연동 및 검색 개선', 9, 3],
  ['보안점검-2026', '하반기 정기 보안 점검', 6, 8],
  ['고객지원-자동화', '문의 분류 자동화 PoC', 4, 1],
  ['인프라-이전', '클라우드 이전 2단계', 11, 2],
  ['주간-업무보고', '', 0, 0],
];

const SUBJECTS = [
  '로그인 화면 레이아웃 수정',
  '푸시 알림 수신 오류 확인',
  'API 응답 속도 개선',
  '관리자 권한 정책 정리',
  '배포 스크립트 점검',
  '검색 결과 정렬 기준 변경',
  '방화벽 정책 신청',
  '데이터 백업 주기 검토',
  '사용자 가이드 문서 작성',
  '결제 모듈 테스트 케이스 보완',
  '접근 로그 보관 기간 확인',
  '대시보드 차트 색상 정리',
  '운영 서버 인증서 갱신',
  'DB 인덱스 재구성',
  '고객 문의 템플릿 개선',
];

// Small deterministic PRNG so the sample looks the same every time.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function localMidnight(now, addDays) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + addDays * DAY_MS);
}

function member(m) {
  return { type: 'member', member: { organizationMemberId: m.id, name: m.name } };
}

function build(now = new Date()) {
  const rand = rng(20261016);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const projects = [];
  const posts = {};
  const closedRecently = {};

  PROJECTS.forEach(([code, description, openCount, closed], pi) => {
    const id = `p-${pi + 1}`;
    projects.push({ id, code, description, state: 'active' });
    closedRecently[id] = closed;
    posts[id] = [];

    for (let i = 0; i < openCount; i++) {
      const r = rand();
      const cls = r < 0.2 ? 'backlog' : r < 0.5 ? 'registered' : 'working';
      const wf = cls === 'working' && rand() < 0.3 ? WORKFLOWS.review : WORKFLOWS[cls];

      const dueRoll = rand();
      let dueDate = null;
      if (dueRoll < 0.2) dueDate = localMidnight(now, -1 - Math.floor(rand() * 5)); // overdue
      else if (dueRoll < 0.4) dueDate = localMidnight(now, Math.floor(rand() * 3)); // due soon
      else if (dueRoll < 0.6) dueDate = localMidnight(now, 5 + Math.floor(rand() * 20));

      const assigneeRoll = rand();
      const to = assigneeRoll < 0.1 ? [] : assigneeRoll < 0.35 ? [member(ME)] : [member(pick(MEMBERS.slice(1)))];
      if (rand() < 0.15 && to.length) {
        const extra = pick(MEMBERS);
        if (!to.some((t) => t.member.organizationMemberId === extra.id)) to.push(member(extra));
      }

      const updatedAt = new Date(now.getTime() - Math.floor(rand() * 10 * DAY_MS));
      posts[id].push({
        id: `${id}-t${i + 1}`,
        subject: SUBJECTS[(pi * 5 + i) % SUBJECTS.length],
        project: { id, code },
        taskNumber: `${code}/${100 + i}`,
        number: 100 + i,
        closed: false,
        createdAt: new Date(updatedAt.getTime() - 3 * DAY_MS).toISOString(),
        updatedAt: updatedAt.toISOString(),
        dueDate: dueDate ? dueDate.toISOString() : null,
        dueDateFlag: Boolean(dueDate),
        priority: pick(['none', 'none', 'normal', 'high', 'highest', 'low']),
        users: { from: member(pick(MEMBERS)), to, cc: [] },
        tags: [TAGS[Math.floor(rand() * 3)], ...(rand() < 0.5 ? [TAGS[3 + Math.floor(rand() * 2)]] : []), ...(rand() < 0.15 ? [TAGS[5]] : [])]
          .filter(() => rand() < 0.85)
          .map((t) => ({ id: t.id })),
        workflowClass: cls,
        workflow: wf,
      });
    }
  });

  // Two sample categories spanning several projects.
  const categories = [
    { id: 'c-focus', name: '이번 주 집중', color: '#ffbd59' },
    { id: 'c-report', name: '보고 필요', color: '#c792ea' },
  ];
  const assignments = {};
  const assign = (taskId, ids) => (assignments[taskId] = { categoryIds: ids, task: null, addedAt: now.toISOString() });
  ['p-1-t1', 'p-2-t3', 'p-3-t2', 'p-5-t4'].forEach((id) => assign(id, ['c-focus']));
  ['p-1-t5', 'p-3-t2', 'p-4-t1'].forEach((id) => assign(id, [...(assignments[id]?.categoryIds || []), 'c-report']));

  return { me: { id: ME.id, name: ME.name }, projects, posts, closedRecently, categories, assignments, tags: TAGS };
}

module.exports = { DOMAIN, build };
