// Mail services the settings window offers (#65): IMAP server, what to type, how to get an app password or
// turn IMAP on, the webmail address, and what a refused login usually means there. Values marked
// "확인 필요" (verified: false) are not confirmed from the provider's official help; the UI says so.

const PROVIDERS = {
  dooray: {
    label: '두레이 메일 (Dooray!)',
    host: 'imap.dooray.com',
    port: 993,
    security: 'tls',
    smtp: { host: 'smtp.dooray.com', port: 465, security: 'tls', verified: false },
    server: 'optional', // a dedicated (self-hosted) Dooray has its own host
    verified: false,
    userLabel: '아이디 (두레이 메일 주소)',
    passwordLabel: '비밀번호',
    steps: [
      '확인 필요: 두레이 IMAP 서버 이름(imap.dooray.com, 993 SSL)과 사용 조건(조직 플랜·관리자 허용)은 공식 도움말에서 아직 확인하지 못했습니다. 연결 확인이 실패하면 두레이 웹 메일 → 설정에서 IMAP 사용 여부와 서버 이름을 확인하고 서버 칸에 넣어 주세요.',
      '두레이 웹에 로그인 → 메일 → 설정(톱니바퀴)에서 IMAP/POP3(외부 메일 프로그램) 사용을 켭니다(메뉴 이름은 조직 설정에 따라 다를 수 있음).',
      '아이디는 두레이 메일 주소, 비밀번호는 두레이 비밀번호입니다. SSO를 쓰는 조직은 별도 발급 비밀번호가 필요할 수 있습니다(확인 필요).',
    ],
    helpUrl: 'https://helpdesk.dooray.com',
    webmail: '',
    webmailHint: '회사 두레이 주소를 넣으세요. 예: https://회사이름.dooray.com/mail',
    authHint: '두레이가 로그인을 거절했습니다. 메일 설정에서 IMAP 사용이 켜져 있는지, 아이디(메일 주소)·비밀번호(SSO 조직은 별도 발급 비밀번호), 조직에서 외부 메일 프로그램을 허용했는지 확인하세요.',
  },
  naver: {
    label: '네이버 메일',
    host: 'imap.naver.com',
    port: 993,
    security: 'tls',
    smtp: { host: 'smtp.naver.com', port: 465, security: 'tls', verified: true },
    domain: 'naver.com', // the ID is the part before @naver.com
    server: 'fixed',
    verified: true,
    userLabel: '네이버 아이디 (@naver.com 앞부분)',
    passwordLabel: '비밀번호 (2단계 인증이면 애플리케이션 비밀번호)',
    steps: [
      '네이버 메일 → 환경설정 → POP3/IMAP 설정 → IMAP/SMTP 설정에서 "IMAP/SMTP 사용"을 사용함으로 바꾸고 저장합니다.',
      '2단계 인증을 쓰면 네이버 → 내 정보 · 보안 → 2단계 인증 → 애플리케이션 비밀번호에서 비밀번호를 만들어 넣습니다(로그인 비밀번호는 통하지 않음).',
      '아이디에는 @naver.com 앞부분만 넣습니다.',
    ],
    helpUrl: 'https://mail.naver.com',
    webmail: 'https://mail.naver.com/',
    authHint: '네이버가 로그인을 거절했습니다. 네이버 메일 환경설정의 IMAP/SMTP 사용이 켜져 있는지, 2단계 인증을 쓰면 애플리케이션 비밀번호인지 확인하세요.',
  },
  daum: {
    label: '다음(카카오) 메일',
    host: 'imap.daum.net',
    port: 993,
    security: 'tls',
    smtp: { host: 'smtp.daum.net', port: 465, security: 'tls', verified: true },
    server: 'fixed',
    verified: true,
    userLabel: '다음 메일 주소 (아이디@daum.net / hanmail.net)',
    passwordLabel: '비밀번호 (카카오 계정은 앱 비밀번호, 확인 필요)',
    steps: [
      'Daum 메일 → 환경설정 → IMAP/POP3에서 IMAP 사용을 켭니다.',
      '아이디에는 다음 메일 주소를 넣습니다.',
      '확인 필요: 카카오 계정으로 통합된 메일은 로그인 비밀번호 대신 앱(애플리케이션) 비밀번호가 필요하다는 안내가 있습니다. 로그인 비밀번호로 실패하면 카카오 계정 보안 설정에서 앱 비밀번호를 만들어 넣어 보세요.',
    ],
    helpUrl: 'https://mail.daum.net',
    webmail: 'https://mail.daum.net/',
    authHint: '다음(카카오)이 로그인을 거절했습니다. 메일 환경설정의 IMAP 사용, 아이디(메일 주소), 카카오 계정이면 앱 비밀번호를 확인하세요.',
  },
  gmail: {
    label: 'Gmail (앱 비밀번호)',
    host: 'imap.gmail.com',
    port: 993,
    security: 'tls',
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls', verified: true },
    savesSent: true, // Gmail files what its SMTP sends in "Sent Mail" itself
    server: 'fixed',
    verified: true,
    userLabel: 'Gmail 주소',
    passwordLabel: '앱 비밀번호 (16자리)',
    steps: [
      'Google 계정에 2단계 인증이 켜져 있어야 앱 비밀번호를 만들 수 있습니다.',
      'myaccount.google.com/apppasswords 에서 앱 이름(예: Desk Widgets)을 넣고 만들기 → 표시된 16자리를 비밀번호 칸에 넣습니다(띄어쓰기는 상관없음).',
      '회사·학교(Google Workspace) 계정은 관리자가 앱 비밀번호나 IMAP을 막았을 수 있습니다. 그런 계정은 #67(OAuth 로그인)에서 지원 예정입니다.',
    ],
    helpUrl: 'https://myaccount.google.com/apppasswords',
    webmail: 'https://mail.google.com/',
    authHint: 'Gmail이 로그인을 거절했습니다. 평소 비밀번호가 아니라 앱 비밀번호(2단계 인증 필요, myaccount.google.com/apppasswords)인지 확인하세요. 회사 계정은 관리자가 막았을 수 있습니다.',
  },
  other: {
    label: '기타 IMAP 서버',
    host: '',
    port: 993,
    security: 'tls',
    smtp: { host: '', port: 465, security: 'tls', verified: true },
    server: 'required',
    verified: true,
    userLabel: '아이디',
    passwordLabel: '비밀번호 (앱 비밀번호가 있으면 그것)',
    steps: [
      '메일 서비스의 "외부 메일 프로그램(IMAP)" 안내에 나온 받는 메일 서버(IMAP) 이름·포트·보안 방식을 넣습니다.',
      '보안은 SSL/TLS(보통 993) 또는 STARTTLS(보통 143)만 됩니다. 암호화하지 않는 연결은 지원하지 않습니다.',
      '서비스가 앱 비밀번호를 따로 주면 그것을 넣습니다.',
    ],
    helpUrl: '',
    webmail: '',
    webmailHint: '웹메일 주소(선택). 예: https://mail.example.com',
    authHint: '서버가 로그인을 거절했습니다. 아이디와 비밀번호(앱 비밀번호를 쓰는 서비스면 그것), 그 서비스에서 IMAP이 켜져 있는지 확인하세요.',
  },
};

// Shown in the list but not selectable yet.
const UNAVAILABLE = [
  {
    id: 'outlook',
    label: 'Outlook.com · Microsoft 365 (준비 중)',
    reason: 'Microsoft는 Outlook.com·Microsoft 365의 IMAP에 비밀번호 로그인을 막았습니다. OAuth 로그인(#67)이나 Outlook 클래식 연동(#66)이 나오면 쓸 수 있습니다.',
  },
];

const PROVIDER_IDS = Object.keys(PROVIDERS);

/** What the settings window needs (no secrets here). */
const providerList = () => [
  ...PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    return { id, label: p.label, host: p.host, port: p.port, security: p.security, smtp: p.smtp, domain: p.domain || '', server: p.server, verified: p.verified, userLabel: p.userLabel, passwordLabel: p.passwordLabel, steps: p.steps, helpUrl: p.helpUrl, webmail: p.webmail, webmailHint: p.webmailHint || '' };
  }),
  ...UNAVAILABLE.map((u) => ({ ...u, unavailable: true })),
];

/**
 * Hint for a refused login or a server message. Gmail and others put the reason in the NO text
 * ("[ALERT] Application-specific password required", "IMAP access is disabled", ...).
 */
function loginHint(providerId, err) {
  const p = PROVIDERS[providerId] || PROVIDERS.other;
  const text = String(err?.message || '');
  if (/application-specific password|app password/i.test(text)) return `${p.authHint} (서버: 앱 비밀번호가 필요합니다)`;
  if (/imap.*(disabled|not enabled|사용.*않)/i.test(text)) return `IMAP이 꺼져 있습니다. ${p.label} 웹메일 설정에서 IMAP 사용을 켜 주세요.`;
  return p.authHint;
}

module.exports = { PROVIDERS, PROVIDER_IDS, UNAVAILABLE, providerList, loginHint };
