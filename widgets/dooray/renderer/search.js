// Task search shared by app-owned windows. Mirrors the glass theme's search behaviour:
// all terms must match (AND); a term made only of initial consonants matches 초성.
(() => {
  const CHOSUNG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

  function toChosung(text) {
    let out = '';
    for (const ch of text) {
      const code = ch.charCodeAt(0) - 0xac00;
      out += code >= 0 && code < 11172 ? CHOSUNG[Math.floor(code / 588)] : ch;
    }
    return out;
  }

  const isChosungTerm = (term) => /^[ㄱ-ㅎ]+$/.test(term);

  function parse(query) {
    return String(query || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  function matches(task, terms) {
    const text = [
      task.subject,
      task.key,
      task.projectName,
      task.workflowName,
      ...(task.assignees || []).map((a) => a.name),
      task.author?.name,
      ...(task.tags || []).map((t) => t.name),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const cho = toChosung(text);
    return terms.every((term) => (isChosungTerm(term) ? cho : text).includes(term));
  }

  /** Appends text to `parent`, wrapping matched parts in <mark>. */
  function appendHighlighted(parent, text, terms) {
    const lower = text.toLowerCase();
    const cho = toChosung(lower);
    const marks = new Array(text.length).fill(false);
    for (const term of terms) {
      const source = isChosungTerm(term) ? cho : lower;
      for (let i = source.indexOf(term); i >= 0; i = source.indexOf(term, i + 1)) {
        for (let k = i; k < i + term.length; k++) marks[k] = true;
      }
    }
    let start = 0;
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || marks[i] !== marks[start]) {
        const part = text.slice(start, i);
        if (marks[start]) {
          const m = document.createElement('mark');
          m.textContent = part;
          parent.append(m);
        } else {
          parent.append(part);
        }
        start = i;
      }
    }
  }

  window.TaskSearch = { parse, matches, appendHighlighted, toChosung };
})();
