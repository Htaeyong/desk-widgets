// CalDAV providers the settings window offers: server, what to type, how to issue the app password,
// and what a 401 means there. Wording and facts ported from my_calendar_sync (docs/provider-auth.md,
// its Korean strings). server: 'fixed' (no field), 'optional' (blank = default), 'required'.

const PROVIDERS = {
  icloud: {
    label: 'Apple iCloud',
    baseUrl: 'https://caldav.icloud.com/',
    server: 'fixed',
    userLabel: 'Apple ID (이메일)',
    passwordLabel: '앱 암호',
    steps: [
      'Apple ID에 2단계 인증이 켜져 있어야 앱 암호를 만들 수 있습니다.',
      'account.apple.com에 로그인 → 로그인 및 보안 → 앱 암호 → 만들기',
      '표시된 16자리 암호(abcd-efgh-ijkl-mnop)를 아래 비밀번호 칸에 넣습니다. Apple ID 비밀번호는 통하지 않습니다.',
    ],
    helpUrl: 'https://account.apple.com',
    authHint: 'iCloud가 로그인을 거절했습니다. 아이디는 Apple ID 이메일, 비밀번호는 평소 비밀번호가 아니라 account.apple.com에서 만든 앱 암호인지 확인하세요(2단계 인증 필요).',
  },
  naver: {
    label: '네이버',
    baseUrl: 'https://caldav.calendar.naver.com/',
    server: 'fixed',
    userLabel: '네이버 아이디',
    passwordLabel: '애플리케이션 비밀번호',
    steps: [
      '네이버 로그인 → 내 정보 · 보안 → 2단계 인증 → 애플리케이션 비밀번호 → 생성',
      '아이디에는 네이버 아이디(@naver.com 앞부분), 비밀번호에는 발급된 애플리케이션 비밀번호를 넣습니다.',
      '2단계 인증을 쓰는 계정은 네이버 로그인 비밀번호로는 연결되지 않습니다.',
    ],
    helpUrl: 'https://nid.naver.com',
    authHint: '네이버가 로그인을 거절했습니다. 아이디와 애플리케이션 비밀번호(내 정보 · 보안 → 2단계 인증 → 애플리케이션 비밀번호)를 확인하세요.',
  },
  naverworks: {
    label: '네이버 웍스 (NAVER WORKS)',
    baseUrl: 'https://caldav.worksmobile.com/',
    server: 'fixed',
    userLabel: '웍스 이메일',
    passwordLabel: '외부 앱 비밀번호',
    steps: [
      '네이버 웍스 보안 설정 열기 → 외부 앱 비밀번호 → 생성',
      '아이디에는 웍스 이메일 주소, 비밀번호에는 발급된 외부 앱 비밀번호를 넣습니다. 로그인 비밀번호는 통하지 않습니다.',
      '조직 관리자가 Admin → 보안 → 서비스 권한에서 CalDAV를 허용해야 하고, 플랜에도 포함돼 있어야 합니다.',
    ],
    helpUrl: 'https://common.worksmobile.com/security-settings',
    authHint: '네이버 웍스가 로그인을 거절했습니다. 서버가 세 가지 원인에 똑같이 답하므로 각각 확인하세요: 로그인 비밀번호가 아니라 외부 앱 비밀번호인지, 관리자가 Admin → 보안 → 서비스 권한에서 CalDAV를 허용했는지, 플랜에 포함돼 있는지.',
  },
  dooray: {
    label: '두레이 (Dooray!)',
    baseUrl: 'https://caldav.dooray.com/',
    server: 'optional',
    serverHint: '자체 구축(전용) 두레이가 아니면 비워 두세요. 자체 구축이면 두레이 캘린더 > CalDav 화면에 나온 https 서버 주소를 넣습니다.',
    userLabel: 'CalDAV 아이디',
    passwordLabel: '비밀번호 (SSO 조직은 비밀번호 키)',
    steps: [
      '두레이 웹에 로그인해 이름 옆 톱니바퀴 → 캘린더 → CalDav를 엽니다.',
      '거기 표시된 아이디를 아이디 칸에 넣습니다(이메일과 다를 수 있습니다).',
      'SSO를 쓰는 조직이면 접속 비밀번호가 아니라 그 화면에서 발급한 비밀번호 키를, 그 밖에는 평소 두레이 비밀번호를 넣습니다.',
      'CalDAV는 Business 플랜 이상에서만 제공되고, 내 캘린더만 연동됩니다.',
    ],
    helpUrl: 'https://helpdesk.dooray.com/share/pages/9wWo-xwiR66BO5LGshgVTg/3097910382949102872',
    authHint: '두레이가 로그인을 거절했습니다. 서버가 세 가지 원인에 똑같이 답하므로 각각 확인하세요: 캘린더 > CalDav 화면의 아이디(이메일과 다를 수 있음), SSO 조직이면 별도 발급한 비밀번호 키, 그리고 조직 플랜(Business 미만은 CalDAV 불가).',
  },
  other: {
    label: '기타 CalDAV 서버',
    baseUrl: '',
    server: 'required',
    serverHint: '서버 주소를 넣으세요. 예: https://cal.example.com — 캘린더는 위젯이 찾습니다. https만 됩니다.',
    userLabel: '아이디',
    passwordLabel: '비밀번호 (앱 비밀번호가 있으면 그것)',
    steps: [
      'Nextcloud, Radicale, SOGo, Fastmail, 사내 그룹웨어 등 CalDAV를 지원하는 서버용입니다.',
      '그 서버가 쓰는 아이디·비밀번호(서비스가 앱 비밀번호를 따로 주면 그것)를 넣습니다.',
      '동작 여부는 서버에 달려 있어 위의 지원 서비스처럼 보장되지는 않습니다.',
    ],
    helpUrl: '',
    authHint: '서버가 로그인을 거절했습니다. 아이디와 비밀번호(앱 비밀번호를 쓰는 서비스면 그것)를 확인하세요.',
  },
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

/** The server URL of an account: the provider's own, or the checked user value. Returns { url } or { error }. */
function serverOf(providerId, input, checkServer) {
  const p = PROVIDERS[providerId];
  if (!p) return { error: '알 수 없는 캘린더 서비스입니다.' };
  const typed = String(input || '').trim();
  if (p.server === 'fixed') return { url: p.baseUrl };
  if (p.server === 'optional' && !typed) return { url: p.baseUrl };
  return checkServer(typed);
}

/** What the settings window needs to draw the provider choice and guide. */
const providerList = () =>
  PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    return { id, label: p.label, server: p.server, serverHint: p.serverHint || '', userLabel: p.userLabel, passwordLabel: p.passwordLabel, steps: p.steps, helpUrl: p.helpUrl, baseUrl: p.baseUrl };
  });

module.exports = { PROVIDERS, PROVIDER_IDS, serverOf, providerList };
