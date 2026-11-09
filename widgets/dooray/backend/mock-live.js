// Sample answers for the AI tools that ask Dooray (#131) when the engine runs with --mock-data:
// the shapes of Dooray's public API, made-up content, no network.

function mockLiveClient(now = Date.now()) {
  const day = (offsetDays, h, m = 0) => {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays, h, m).toISOString();
  };
  const ok = (result, totalCount) => ({ header: { isSuccessful: true, resultCode: 0, resultMessage: '' }, result, ...(totalCount !== undefined ? { totalCount } : {}) });
  const pages = {
    w1: [{ id: 'pg1', subject: 'Home', root: true }],
    'w1:pg1': [
      { id: 'pg2', subject: '개발 환경 설정', parentPageId: 'pg1' },
      { id: 'pg3', subject: '배포 절차', parentPageId: 'pg1' },
    ],
  };
  const files = {
    root: [
      { id: 'fd1', name: '회의록', type: 'folder', updatedAt: day(-3, 10) },
      { id: 'f1', name: '일정표.csv', type: 'file', mimeType: 'text/csv', size: 120, updatedAt: day(-1, 9) },
      { id: 'f2', name: '제안서.pdf', type: 'file', mimeType: 'application/pdf', size: 204800, updatedAt: day(-2, 14) },
    ],
    fd1: [{ id: 'f3', name: '주간회의.md', type: 'file', mimeType: 'text/markdown', size: 64, updatedAt: day(-1, 11) }],
  };
  const fileText = { f1: '날짜,할 일\n월,기획 회의\n화,디자인 검토\n', f3: '# 주간회의\n\n- 배포 일정 확인\n- 다음 주 데모 준비\n', a1: '체크리스트\n- 서버 점검\n' };
  const allFiles = Object.values(files).flat();

  return {
    async request(pathname, query = {}) {
      if (pathname === '/wiki/v1/wikis') return ok([{ id: 'w1', name: '샘플 프로젝트', project: { id: 'p1' }, home: { pageId: 'pg1' } }], 1);
      let m = /^\/wiki\/v1\/wikis\/(\w+)\/pages$/.exec(pathname);
      if (m) return ok(pages[query.parentPageId ? `${m[1]}:${query.parentPageId}` : m[1]] || []);
      m = /^\/wiki\/v1\/wikis\/(\w+)\/pages\/(\w+)$/.exec(pathname);
      if (m) {
        return ok({
          id: m[2],
          wikiId: m[1],
          subject: m[2] === 'pg2' ? '개발 환경 설정' : '샘플 위키 페이지',
          body: { mimeType: 'text/x-markdown', content: '## 준비\n\n1. 저장소를 받습니다.\n2. `npm install`\n\n![구성도](/page-files/123)\n' },
          updatedAt: day(-1, 15),
          files: [{ id: 'a1', name: '체크리스트.txt', size: 24 }],
          images: [{ id: 'i1', name: '구성도.png', size: 1000 }],
        });
      }
      if (pathname === '/drive/v1/drives') {
        return ok(query.type === 'project' ? [{ id: 'd2', name: '샘플 프로젝트', type: 'project', project: { id: 'p1' } }] : [{ id: 'd1', name: null, type: 'private', project: { id: null } }]);
      }
      m = /^\/drive\/v1\/drives\/(\w+)\/files$/.exec(pathname);
      if (m) {
        if (query.subTypes === 'root') return ok([{ id: 'root', name: '/', type: 'folder' }]);
        const list = files[query.parentId] || [];
        return ok(list, list.length);
      }
      m = /^\/drive\/v1\/drives\/(\w+)\/files\/(\w+)$/.exec(pathname);
      if (m) return ok(allFiles.find((f) => f.id === m[2]) || null);
      if (pathname === '/calendar/v1/calendars') return ok([{ id: 'c1', name: '내 캘린더', type: 'private' }, { id: 'c2', name: '샘플 프로젝트', type: 'project' }]);
      if (pathname === '/calendar/v1/calendars/*/events') {
        return ok([
          { id: 'e1', subject: '주간 회의', startedAt: day(0, 10), endedAt: day(0, 11), location: '3층 회의실', calendar: { id: 'c2', name: '샘플 프로젝트' }, category: 'general' },
          { id: 'e2', subject: '휴가', startedAt: day(2, 0), endedAt: day(3, 0), wholeDayFlag: true, calendar: { id: 'c1', name: '내 캘린더' }, category: 'general' },
        ]);
      }
      throw Object.assign(new Error('not found'), { status: 404 });
    },
    // Originals for fetch_file: the text samples plus a tiny made-up "pdf".
    async openFile(pathname) {
      const id = pathname.split('/').pop();
      const body = id === 'f2' ? Buffer.from('%PDF-1.4 sample', 'latin1') : fileText[id] && Buffer.from(fileText[id], 'utf8');
      if (!body) throw Object.assign(new Error('not found'), { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-type': id === 'f2' ? 'application/pdf' : 'text/plain', 'content-length': String(body.length) } });
    },
    async requestBytes(pathname) {
      const id = pathname.split('/').pop();
      if (!fileText[id]) throw Object.assign(new Error('not found'), { status: 404 });
      return { bytes: Buffer.from(fileText[id], 'utf8'), contentType: 'text/plain' };
    },
  };
}

module.exports = { mockLiveClient };
