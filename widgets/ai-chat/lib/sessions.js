// The widget's conversations on this PC (design 11): an index plus one .jsonl per session in the widget's data folder.
// Never synced. Tool results are not kept at all, only a tool's name and a short input. Claude Code's own full record of a
// session lives in that session's own CLAUDE_CONFIG_DIR, so one session's record can be erased by removing one folder,
// without knowing how Claude Code lays out its files.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_ID = /^s-[0-9a-f]{16}$/;
const ATTACH_DIR = 'AI Widgets 첨부'; // lib/attachments.js: <work folder>\AI Widgets 첨부\<session id>
const MAX_TEXT = 256 * 1024;
const MAX_TOOL_INPUT = 200;
const MAX_TITLE = 40;

const titleOf = (prompt) => {
  const line = String(prompt).trim().split(/\r?\n/)[0];
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE)}…` : line;
};

/** A tool's input, one short line. */
function shortInput(input) {
  let text;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  } catch {
    text = '';
  }
  return text.length > MAX_TOOL_INPUT ? `${text.slice(0, MAX_TOOL_INPUT)}…` : text;
}

function createSessionStore({ dir, configRoot, now = Date.now }) {
  const indexFile = path.join(dir, 'index.json');
  const logFile = (id) => {
    if (!SESSION_ID.test(id)) throw new Error('Invalid session id');
    return path.join(dir, `${id}.jsonl`);
  };
  const configDirOf = (id) => {
    if (!SESSION_ID.test(id)) throw new Error('Invalid session id');
    return path.join(configRoot, id);
  };

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      return Array.isArray(raw.sessions) ? raw.sessions.filter((s) => SESSION_ID.test(s?.id)) : [];
    } catch {
      return [];
    }
  }

  function write(sessions) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessions }));
    fs.renameSync(tmp, indexFile);
  }

  const get = (id) => load().find((s) => s.id === id) || null;

  function update(id, patch) {
    const sessions = load();
    const at = sessions.findIndex((s) => s.id === id);
    if (at < 0) return null;
    sessions[at] = { ...sessions[at], ...patch };
    write(sessions);
    return sessions[at];
  }

  const removeTree = (folder) => fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

  return {
    configDirOf,
    get,
    update,
    list: () => load().sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastAt - a.lastAt),

    create({ prompt, cwd, model, mode }) {
      const at = now();
      const session = {
        id: `s-${crypto.randomBytes(8).toString('hex')}`, title: titleOf(prompt), cwd, runner: 'claude', runnerSessionId: null, model, mode,
        createdAt: at, lastAt: at, status: 'idle', resumable: true, pinned: false, estUsd: 0, satisfied: false, external: false, usedRecipes: [], excludedRecipes: [],
      };
      write([...load(), session]);
      return session;
    },

    /** One line of the conversation. Text is cut to a size a window can draw. */
    append(id, item) {
      const line = { at: now(), ...item };
      if (typeof line.text === 'string' && line.text.length > MAX_TEXT) line.text = `${line.text.slice(0, MAX_TEXT)}…`;
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(logFile(id), `${JSON.stringify(line)}\n`);
      update(id, { lastAt: line.at });
      return line;
    },

    /** The conversation's lines; a broken line is skipped. */
    read(id) {
      const file = logFile(id);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return [];
      }
      const out = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch { /* a line cut by a crash */ }
      }
      return out;
    },

    hasClaudeRecord: (id) => fs.existsSync(configDirOf(id)),

    /** Erases only Claude Code's record: the conversation stays readable but cannot be continued (S9). */
    clearClaudeRecord(id) {
      removeTree(configDirOf(id));
      return update(id, { runnerSessionId: null, resumable: false });
    },

    /** Removes the conversation and Claude Code's record of it. */
    remove(id) {
      const session = get(id);
      if (session?.cwd && path.isAbsolute(session.cwd)) removeTree(path.join(session.cwd, ATTACH_DIR, id));
      removeTree(configDirOf(id));
      fs.rmSync(logFile(id), { force: true });
      write(load().filter((s) => s.id !== id));
    },

    /** Removes what is older than `days` (0: nothing), except pinned sessions and those in `keep`. Returns the ids removed. */
    prune(days, keep = new Set()) {
      if (!days) return [];
      const limit = now() - days * 86400000;
      const old = load().filter((s) => !s.pinned && !keep.has(s.id) && s.lastAt < limit).map((s) => s.id);
      for (const id of old) this.remove(id);
      return old;
    },
  };
}

module.exports = { createSessionStore, shortInput, titleOf, SESSION_ID };
