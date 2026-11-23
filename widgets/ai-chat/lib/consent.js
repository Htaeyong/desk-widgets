// The first-run warning, word for word from docs/ai-chat-design.md 8.1 (a test compares them). Raise CONSENT_VERSION
// when the text changes in meaning: everyone is asked again. The strings use **bold** and [text](url), drawn by chat.js.
const CONSENT_VERSION = 1;

const CONSENT = {
  title: 'AI Widgets를 쓰기 전에 확인해 주세요',
  items: [
    '**내 PC에서 실행합니다.** 설치된 Claude Code가 내 Windows 계정 권한으로 파일을 읽고 고치고 명령을 실행합니다. **Windows에서는 이를 막는 샌드박스가 없고, 작업 폴더는 시작 위치일 뿐 격리 공간이 아닙니다.** 파일을 지우거나 망가뜨릴 수 있으니 중요한 자료는 백업하세요.',
    '**비용은 내 몫입니다.** 내 API 키의 Anthropic 조직에 청구됩니다. 금액은 추정이며 넘을 수 있습니다. Console에서 한도를 정하세요.',
    '**내용이 Anthropic으로 갑니다.** 내 명령과 작업 중 읽은 파일·명령 결과, 저장한 요약의 제목과 "언제 쓰는지"가 전달됩니다. Desk Widgets 개발자에게는 가지 않습니다.',
    '**AI는 틀릴 수 있고, 읽은 글에 속을 수 있습니다.** 메일·웹·남의 파일에 숨은 지시를 따를 수 있습니다. 결과를 확인하세요. 법률·의료·금융 판단은 전문가에게 확인하세요.',
    '**키**는 이 PC에 암호화해 저장하지만 실행한 프로그램이 빼낼 가능성을 없앨 수 없습니다. 전용 키와 낮은 한도를 쓰세요.',
    'Anthropic 약관과 [사용 정책](https://www.anthropic.com/legal/aup)이 적용됩니다.',
  ],
};

const consentGiven = (stored) => Boolean(stored && stored.version === CONSENT_VERSION);

module.exports = { CONSENT, CONSENT_VERSION, consentGiven };
