// Approval and question cards (#129, design 9). What the model or a tool wrote may be crafted to mislead, so a card shows the
// full input with every invisible character made visible. The window gets only this display text; the input that is approved
// stays in the main process, so what runs is exactly what was asked, not something a page sent back.
const crypto = require('crypto');

const MAX_INPUT_TEXT = 256 * 1024; // larger than anyone can check: refused, never approved unseen
const MAX_OPTIONS = 20;
const MAX_FIELD = 4000;
const MAX_ANSWER = 10000;

// Code points a reader cannot see: C0 and C1 controls (not tab or newline), DEL, soft hyphen, zero-width and direction marks,
// separators, invisible fillers, variation selectors, the BOM and tag characters.
const HIDDEN_RANGES = [
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0xe0000, 0xe0fff],
];

/** The text with hidden characters shown as [U+XXXX]. */
function visibleText(text) {
  let hidden = 0;
  let out = '';
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    if (HIDDEN_RANGES.some(([from, to]) => code >= from && code <= to)) {
      hidden++;
      out += `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`;
    } else out += ch;
  }
  return { text: out, hidden };
}

const newId = () => crypto.randomBytes(12).toString('hex');

/** `input` as a card shows it: indented JSON (which already escapes C0) with everything else made visible. */
function inputText(input) {
  let json;
  try {
    json = JSON.stringify(input ?? {}, null, 2);
  } catch {
    json = '';
  }
  return visibleText(json);
}

// Dooray's original fetch. Its own Desk Widgets card is the approval (team lead decision C), so the widget shows no card for it.
const FETCH_TOOL = 'mcp__desk-widgets__dooray_fetch_file';

/** A card for `approve`: { view for the window, input kept here, deny-only when too large to read }. */
function approvalCard(args) {
  const a = args && typeof args === 'object' ? args : {};
  const input = a.input && typeof a.input === 'object' ? a.input : {};
  const tool = visibleText(String(a.tool_name ?? '').slice(0, MAX_FIELD));
  const shown = inputText(input);
  const tooLarge = shown.text.length > MAX_INPUT_TEXT;
  return {
    id: newId(),
    kind: 'approval',
    input,
    tooLarge,
    view: {
      kind: 'approval',
      tool: tool.text,
      inputText: tooLarge ? '' : shown.text,
      hidden: tool.hidden + shown.hidden,
    },
  };
}

/** A card for `ask_user`. */
function questionCard(args) {
  const a = args && typeof args === 'object' ? args : {};
  const question = visibleText(String(a.question ?? '').slice(0, MAX_FIELD));
  const options = (Array.isArray(a.options) ? a.options : []).filter((o) => typeof o === 'string').slice(0, MAX_OPTIONS).map((o) => visibleText(o.slice(0, MAX_FIELD)));
  return {
    id: newId(),
    kind: 'question',
    view: {
      kind: 'question',
      question: question.text,
      options: options.map((o) => o.text),
      hidden: question.hidden + options.reduce((n, o) => n + o.hidden, 0),
    },
  };
}

/**
 * A card for save_memory: the text the model proposes, made visible, with what the checks found. What is saved is what the user
 * leaves in the box when they click, checked again then.
 */
function memoryCard(args, { secrets = [], risks = [], external = false, maxText = 1000 } = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const text = visibleText(String(a.text ?? '').slice(0, maxText));
  const title = visibleText(String(a.title ?? '').slice(0, 80));
  return {
    id: newId(),
    kind: 'memory',
    view: {
      kind: 'memory',
      text: text.text,
      title: title.text,
      hidden: text.hidden + title.hidden,
      external: Boolean(external),
      secrets: secrets.map((s) => s.label),
      risks: risks.map((r) => `${r.label}: ${r.text}`),
    },
  };
}

const allowAnswer = (card) => ({ behavior: 'allow', updatedInput: card.input });
const denyAnswer = (message) => ({ behavior: 'deny', message: message || 'The user denied this action.' });
const cleanAnswer = (text) => String(text ?? '').slice(0, MAX_ANSWER);

module.exports = { FETCH_TOOL, visibleText, inputText, approvalCard, questionCard, memoryCard, allowAnswer, denyAnswer, cleanAnswer, MAX_INPUT_TEXT };
