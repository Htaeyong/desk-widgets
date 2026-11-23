// Files the user attaches to a prompt (#129): dropped, picked with 📎 or pasted. Each is checked when it is added and copied,
// never moved, into the conversation's own attachment folder under its work folder when the prompt is sent. Claude Code is told
// the copies' paths and opens them with its Read tool, which also shows images (design: attachments). The widget's own record
// keeps only names and sizes.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { containsKey, scanSecrets } = require('./recipe-safety');

const ATTACH_DIR = 'AI Widgets 첨부';
const LIMITS = {
  files: 10, // per prompt
  fileBytes: 20 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  pasteBytes: 10 * 1024 * 1024, // a pasted image or text, held in memory until sent
  scanBytes: 1024 * 1024, // text files up to this size are checked for the widget's key and secret-looking text
};
// Programs and scripts: allowed (Claude may need to read one) but marked, since running one is a different thing.
const EXECUTABLE = new Set(['.exe', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.com', '.lnk', '.reg', '.hta', '.jar', '.cpl', '.dll', '.sh', '.py']);
const TEXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.ini', '.cfg', '.conf', '.env', '.xml', '.yaml', '.yml', '.toml', '.ps1', '.bat', '.cmd', '.sh', '.py', '.js', '.ts', '.html', '.css', '.sql', '.reg']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** The image type by its first bytes, or null: the name alone does not make a file an image. */
function imageType(head) {
  const b = Buffer.from(head || []);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return { mime: 'image/gif', ext: '.gif' };
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

/** A file name that is safe to create on Windows: no folders, no reserved names or characters, not too long. */
function safeName(raw, fallback = '첨부') {
  let name = path.basename(String(raw ?? '')).replace(/[<>:"/\\|?*]/g, '_');
  name = [...name].filter((ch) => ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) !== 0x7f).join('').trim().replace(/[. ]+$/, '');
  if (!name || /^\.+$/.test(name)) name = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = `_${name}`;
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 12);
    name = `${name.slice(0, 120 - ext.length)}${ext}`;
  }
  return name;
}

/** "name.ext", "name (2).ext", ... the first one not in the folder. */
function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 10000; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${stem} (${crypto.randomBytes(4).toString('hex')})${ext}`;
}

const readHead = (file) => {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    const n = fs.readSync(fd, head, 0, 16, 0);
    return head.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * @param {object} o
 * @param {function} o.getKey  the widget's key, to refuse a text file that holds it
 * @param {function} [o.thumbnail]  ({ path?, data?, mime }) -> a small data: URL for the preview, or null
 */
function createAttachmentStore({ getKey, thumbnail = () => null, limits = LIMITS }) {
  const pending = new Map(); // id -> item, until sent or removed

  const fail = (message, code = 'refused') => ({ ok: false, code, message });
  const totalBytes = () => [...pending.values()].reduce((sum, it) => sum + it.size, 0);

  /** Checks that apply to every file: count, size, the widget's key in a text file, warnings for programs and odd images. */
  function check({ name, size, head, text }) {
    if (pending.size >= limits.files) return { error: fail(`한 번에 ${limits.files}개까지 첨부할 수 있습니다.`, 'too-many') };
    if (size > limits.fileBytes) return { error: fail(`파일 하나는 ${Math.round(limits.fileBytes / 1048576)}MB까지 첨부할 수 있습니다: ${name}`, 'too-big') };
    if (totalBytes() + size > limits.totalBytes) return { error: fail(`첨부는 모두 합쳐 ${Math.round(limits.totalBytes / 1048576)}MB까지입니다.`, 'too-big') };
    const ext = path.extname(name).toLowerCase();
    const image = imageType(head);
    const warnings = [];
    if (EXECUTABLE.has(ext)) warnings.push('실행 파일이나 스크립트입니다. Claude Code가 내용을 읽을 수 있고, 시키면 실행할 수도 있습니다.');
    if (IMAGE_EXT.has(ext) && !image) warnings.push('이름은 이미지지만 이미지 형식이 아닙니다. 일반 파일로 보냅니다.');
    if (typeof text === 'string') {
      if (containsKey(text, getKey())) return { error: fail(`이 위젯의 API 키가 들어 있어 첨부할 수 없습니다: ${name}`, 'key-in-file') };
      const found = scanSecrets(text, '');
      if (found.length) warnings.push(`비밀처럼 보이는 값이 있습니다(${found[0].label}). 그대로 Anthropic으로 갑니다.`);
    }
    return { image, warnings };
  }

  function remember(item) {
    pending.set(item.id, item);
    const { source, ...view } = item;
    return { ok: true, attachment: view };
  }

  return {
    LIMITS: limits,
    /** A file on this PC, by its path (dropped or picked). Nothing is copied yet. */
    addPath(file) {
      let stat;
      try {
        stat = fs.statSync(String(file));
      } catch {
        return fail('파일을 찾을 수 없습니다.', 'missing');
      }
      if (!stat.isFile()) return fail('폴더는 첨부할 수 없습니다. 파일을 골라 주세요.', 'not-file');
      const name = safeName(file);
      const ext = path.extname(name).toLowerCase();
      let head;
      let text;
      try {
        head = readHead(file);
        if (TEXT.has(ext) && stat.size <= limits.scanBytes) text = fs.readFileSync(file, 'utf8');
      } catch {
        return fail(`파일을 읽을 수 없습니다: ${name}`, 'unreadable');
      }
      const checked = check({ name, size: stat.size, head, text });
      if (checked.error) return checked.error;
      const kind = checked.image ? 'image' : 'file';
      return remember({
        id: crypto.randomBytes(8).toString('hex'), name, size: stat.size, kind, mime: checked.image?.mime || null, warnings: checked.warnings,
        thumb: kind === 'image' ? thumbnail({ path: String(file), mime: checked.image.mime }) : null, source: { path: String(file) },
      });
    },
    /** Bytes from the clipboard or a drop with no path: an image, or long text turned into a file. */
    addData({ name, data, text } = {}) {
      const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : (data || []));
      if (!bytes.length) return fail('빈 내용은 첨부할 수 없습니다.', 'empty');
      if (bytes.length > limits.pasteBytes) return fail(`붙여넣은 내용은 ${Math.round(limits.pasteBytes / 1048576)}MB까지 첨부할 수 있습니다.`, 'too-big');
      const image = imageType(bytes.subarray(0, 16));
      let fileName = safeName(name, image ? `붙여넣은 이미지${image.ext}` : '붙여넣은 내용.txt');
      if (image && !IMAGE_EXT.has(path.extname(fileName).toLowerCase())) fileName += image.ext;
      const checked = check({ name: fileName, size: bytes.length, head: bytes.subarray(0, 16), text: typeof text === 'string' ? text : (TEXT.has(path.extname(fileName).toLowerCase()) ? bytes.toString('utf8') : undefined) });
      if (checked.error) return checked.error;
      const kind = checked.image ? 'image' : 'file';
      return remember({
        id: crypto.randomBytes(8).toString('hex'), name: fileName, size: bytes.length, kind, mime: checked.image?.mime || null, warnings: checked.warnings,
        thumb: kind === 'image' ? thumbnail({ data: bytes, mime: checked.image.mime }) : null, source: { data: bytes },
      });
    },
    remove: (id) => pending.delete(String(id)),
    clear: () => pending.clear(),
    has: (id) => pending.has(String(id)),
    /** Takes the attachments of the prompt being sent out of the waiting list; unknown ids are refused. */
    take(ids) {
      const list = (Array.isArray(ids) ? ids : []).map(String);
      if (list.some((id) => !pending.has(id))) return { error: fail('첨부 파일이 더 이상 없습니다. 다시 첨부해 주세요.', 'gone') };
      if (list.length > limits.files) return { error: fail(`한 번에 ${limits.files}개까지 첨부할 수 있습니다.`, 'too-many') };
      const items = list.map((id) => pending.get(id));
      for (const id of list) pending.delete(id);
      return { items };
    },
    /** Copies (never moves) into the folder, under names that do not clash. Returns what was saved. */
    save(items, folder) {
      fs.mkdirSync(folder, { recursive: true });
      return items.map((it) => {
        const name = uniqueName(folder, it.name);
        const target = path.join(folder, name);
        if (it.source.path) fs.copyFileSync(it.source.path, target, fs.constants.COPYFILE_EXCL);
        else fs.writeFileSync(target, it.source.data, { flag: 'wx' });
        return { name, size: it.size, kind: it.kind, path: target };
      });
    },
  };
}

/** What the prompt says about the copies: where they are, and that images open with Read. */
function attachmentNote(saved) {
  if (!saved.length) return '';
  const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const lines = saved.map((s) => `- ${s.kind === 'image' ? 'image' : 'file'}, ${kb(s.size)}: ${s.path}`);
  return [
    '',
    '',
    'The user attached these files. They are copies saved for this conversation; read the ones you need with the Read tool (it also shows images, so open each image with Read to see it).',
    ...lines,
  ].join('\n');
}

module.exports = { createAttachmentStore, attachmentNote, imageType, safeName, uniqueName, ATTACH_DIR, LIMITS, EXECUTABLE };
