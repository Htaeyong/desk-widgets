// What a recipe (a saved summary) must be checked for before it is kept (#129, design 12). A recipe is reused as guidance in later
// work, so a planted line is worse than one bad answer. These checks point things out for a person to judge; they are not a
// guarantee, and nothing here returns a whole secret.
const path = require('path');
const { visibleText } = require('./cards');

const SECRET_PATTERNS = [
  ['anthropic-key', 'Anthropic API 키 모양', /sk-ant-[A-Za-z0-9_-]{8,}/g],
  ['api-key', 'API 키 모양', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['github-token', 'GitHub 토큰 모양', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ['aws-key', 'AWS 키 모양', /\bAKIA[0-9A-Z]{16}\b/g],
  ['slack-token', 'Slack 토큰 모양', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['google-key', 'Google 키 모양', /\bAIza[0-9A-Za-z_-]{30,}/g],
  ['jwt', '토큰(JWT) 모양', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g],
  ['private-key', '개인 키', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['bearer', '인증 헤더 값', /\b(?:bearer|authorization)\s*[:=]?\s+[A-Za-z0-9._~+/=-]{12,}/gi],
  ['assignment', '비밀번호나 토큰 값', /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|token)\s*[:=]\s*\S{3,}/gi],
  ['assignment', '비밀번호나 토큰 값', /(?:비밀번호|암호|토큰)\s*(?:[:=]|은|는)\s*\S{3,}/g],
];
const LONG_RANDOM = /[A-Za-z0-9+/_=-]{32,}/g;

const RISK_PATTERNS = [
  ['url', '주소', /\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/i],
  ['command', '명령', /\b(?:rm\s+-|del\s+\/|rmdir|format\s+[a-z]:|powershell|cmd(?:\.exe)?\s+\/c|curl|wget|invoke-(?:webrequest|expression|restmethod)|iex\b|reg\s+(?:add|delete)|schtasks|chmod|sudo|mshta|certutil)\b/i],
  ['send', '외부 전송', /\b(?:upload|webhook|exfiltrat\w*|send\s+(?:it|this|the|to)|post\s+(?:it|this|the|to)|e-?mail\s+(?:it|this|the|to))\b|전송|업로드|보내\s*(?:라|기|줘|주세요|십시오)|올려\s*(?:라|줘|주세요)/i],
  ['permission', '권한 변경', /\b(?:bypass\w*|permission\w*|allowedtools|settings\.json|administrator|disable\s+\w*(?:guard|safety|check|sandbox)\w*)\b|권한|승인\s*없이|묻지\s*말|확인\s*없이/i],
  ['override', '지시 무시', /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:previous|above|prior|earlier|instruction|instructions|rule|rules|user|request)\b|system\s*prompt|do\s+not\s+(?:tell|inform|mention)|무시\s*(?:하|해)|이전\s*지시|사용자에게\s*(?:알리지|말하지)/i],
];

const entropy = (text) => {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
};

/** A long string that looks generated: mixed characters, high entropy. A path or a repeated run is not. */
const looksRandom = (text) => !/[/\\]{1}.*[/\\]/.test(text) && /[0-9]/.test(text) && /[A-Za-z]/.test(text) && entropy(text) >= 3.5;

const mask = (text) => `${text.slice(0, 4)}…(${text.length}자)`;
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** True when the widget's own key is in the text, even broken up by spaces or line breaks, or as Base64. */
function containsKey(text, key) {
  if (!key) return false;
  const plain = String(text);
  if (plain.includes(key)) return true;
  if (plain.replace(/\s+/g, '').includes(key)) return true;
  return plain.includes(Buffer.from(key).toString('base64').replace(/=+$/, ''));
}

/**
 * What looks like a secret. `hard` is the widget's own key: it can never be saved. Others stop the save until they are removed or
 * the user says, one click at a time, that they are not secrets.
 */
function scanSecrets(text, key) {
  const s = String(text ?? '');
  const out = [];
  const seen = new Set();
  if (containsKey(s, key)) out.push({ kind: 'widget-key', label: '이 위젯의 API 키', hard: true, line: 0, sample: '' });
  const add = (kind, label, m) => {
    if (seen.has(m[0])) return;
    seen.add(m[0]);
    out.push({ kind, label, hard: false, line: lineOf(s, m.index), sample: mask(m[0]) });
  };
  for (const [kind, label, re] of SECRET_PATTERNS) for (const m of s.matchAll(re)) add(kind, label, m);
  for (const m of s.matchAll(LONG_RANDOM)) {
    if (looksRandom(m[0]) && ![...seen].some((found) => found.includes(m[0]) || m[0].includes(found))) add('random', '긴 무작위 문자열', m);
  }
  return out;
}

/** Lines a person should read with care. One finding per kind per line, in the visible form of that line. */
function scanRisks(text) {
  const out = [];
  String(text ?? '').split('\n').forEach((line, i) => {
    for (const [kind, label, re] of RISK_PATTERNS) {
      if (re.test(line)) out.push({ kind, label, line: i + 1, text: visibleText(line.slice(0, 300)).text });
    }
    const hidden = visibleText(line).hidden;
    if (hidden) out.push({ kind: 'hidden', label: '보이지 않는 글자', line: i + 1, text: visibleText(line.slice(0, 300)).text });
  });
  return out.slice(0, 200);
}

/**
 * Whether this tool call brought in content from outside what the user gave: the web, a widget's data (mail, other people's tasks),
 * a file outside the work folder, or a shell command that fetches. A recipe made after that deserves a second look.
 */
function isExternalRead({ name, input }, cwd) {
  const tool = String(name || '');
  if (tool === 'WebFetch' || tool === 'WebSearch' || tool.startsWith('mcp__desk-widgets__')) return true;
  if (tool === 'Bash' || tool === 'PowerShell') return /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|git\s+clone|https?:\/\/)/i.test(String(input?.command ?? ''));
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
    const target = String(input?.file_path ?? input?.path ?? '');
    if (!/^[A-Za-z]:[\\/]|^[\\/]/.test(target)) return false;
    // Resolved first, so "<work folder>\..\elsewhere" counts as outside.
    const norm = (p) => path.win32.resolve(p).toLowerCase();
    return !norm(target).startsWith(`${norm(String(cwd || '')).replace(/\\+$/, '')}\\`);
  }
  return false;
}

module.exports = { scanSecrets, scanRisks, containsKey, isExternalRead };
