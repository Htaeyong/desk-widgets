// MIME decoding (#65): encoded words (euc-kr, ks_c_5601-1987, cp949, iso-2022-jp), QP / base64, RFC 2231
// parameters, which parts to show and which are attachments.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/mime');

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const eucKr = (hex) => Buffer.from(hex, 'hex');
const HANGUL_EUCKR = 'c7d1b1db'; // "한글"

test('encoded words: B and Q, UTF-8 and Korean legacy charsets, adjacent words joined', () => {
  assert.equal(M.decodeWords('=?UTF-8?B?7ZWc6riA?='), '한글');
  assert.equal(M.decodeWords(`=?euc-kr?B?${b64(eucKr(HANGUL_EUCKR))}?=`), '한글');
  assert.equal(M.decodeWords(`=?ks_c_5601-1987?B?${b64(eucKr(HANGUL_EUCKR))}?=`), '한글', 'Outlook / Korean webmail label');
  assert.equal(M.decodeWords(`=?cp949?B?${b64(eucKr(HANGUL_EUCKR))}?=`), '한글', 'cp949 is mapped to euc-kr');
  assert.equal(M.decodeWords('=?utf-8?Q?=ED=95=9C=EA=B8=80_=EC=A0=9C=EB=AA=A9?='), '한글 제목', 'Q: "_" is a space');
  assert.equal(M.decodeWords('Re: =?UTF-8?B?7ZWc?= =?UTF-8?B?6riA?= 끝'), 'Re: 한글 끝', 'whitespace between words dropped, around kept');
  // A multi-byte character split across two words is decoded with both halves.
  const bytes = Buffer.from('한', 'utf8');
  assert.equal(M.decodeWords(`=?UTF-8?B?${b64(bytes.subarray(0, 2))}?= =?UTF-8?B?${b64(bytes.subarray(2))}?=`), '한');
  assert.equal(M.decodeWords('=?iso-2022-jp?B?GyRCRnxLXDhsGyhC?='), '日本語');
  assert.equal(M.decodeWords('=?UTF-8*ko?B?7ZWc6riA?='), '한글', 'RFC 2231 language suffix');
  assert.equal(M.decodeWords('=?x-made-up?B?YWJj?='), 'abc', 'unknown charset falls back to UTF-8');
  assert.equal(M.decodeWords('plain subject'), 'plain subject');
});

test('quoted-printable and base64 bodies, partial (snippet) fetches', () => {
  assert.equal(M.decodeQP('caf=C3=A9 soft=\r\nbreak =3D ok').toString('utf8'), 'café softbreak = ok');
  assert.equal(M.decodeQP('cut =E').toString(), 'cut ', 'a cut-off escape at the end is dropped');
  assert.equal(M.decodeBase64('7ZWc6riA\r\n7KCc66qp').toString(), '한글제목');
  assert.equal(M.decodeBase64('7ZWc6riA7').toString(), '한글', 'a lone trailing character of a cut fetch is dropped');
  assert.equal(M.partText({ encoding: 'base64', params: { charset: 'euc-kr' } }, Buffer.from(b64(eucKr(HANGUL_EUCKR)))), '한글');
  assert.equal(M.partText({ encoding: 'quoted-printable', params: { charset: 'ks_c_5601-1987' } }, Buffer.from('=C7=D1=B1=DB')), '한글');
  assert.equal(M.partText({ encoding: '8bit', params: {} }, eucKr(HANGUL_EUCKR)), '한글', 'no charset: UTF-8 if valid, else EUC-KR');
});

test('headers and parameters: folding, quoted values, RFC 2231 continuations with charset', () => {
  const h = M.parseHeaders('Subject: =?UTF-8?B?7ZWc6riA?=\r\n continued\r\nContent-Type: text/plain;\r\n\tcharset="euc-kr"\r\n\r\nbody: not a header');
  assert.deepEqual(h.get('subject'), ['=?UTF-8?B?7ZWc6riA?= continued']);
  assert.equal(M.parseHeaderParams(h.get('content-type')[0]).params.charset, 'euc-kr');
  assert.equal(h.has('body'), false);
  const p = M.parseHeaderParams("attachment; filename*0*=UTF-8''%EB%B3%B4%EA%B3%A0; filename*1*=%EC%84%9C.pdf");
  assert.deepEqual([p.value, p.params.filename], ['attachment', '보고서.pdf']);
  assert.equal(M.parseHeaderParams('inline; filename="=?UTF-8?B?7ZWc6riA?=.txt"').params.filename, '한글.txt', 'encoded word in a quoted name (common, non-standard)');
});

const leaf = (type, subtype, part, extra = {}) => ({ type, subtype, part, params: {}, encoding: '7bit', size: 10, disposition: null, ...extra });

test('which parts to show: html over plain in alternative, related images by cid, attachments by name', () => {
  const tree = {
    type: 'multipart',
    subtype: 'mixed',
    part: '',
    children: [
      {
        type: 'multipart',
        subtype: 'alternative',
        part: '1',
        children: [leaf('text', 'plain', '1.1'), { type: 'multipart', subtype: 'related', part: '1.2', children: [leaf('text', 'html', '1.2.1'), leaf('image', 'png', '1.2.2', { id: 'logo@x' })] }],
      },
      leaf('application', 'pdf', '2', { disposition: { type: 'attachment', params: { filename: '계약서.pdf' } }, encoding: 'base64', size: 4000 }),
      leaf('image', 'jpeg', '3', { params: { name: 'photo.jpg' } }),
      leaf('message', 'rfc822', '4', { envelope: { subject: '원본 메일' } }),
    ],
  };
  const shown = M.displayParts(tree);
  assert.deepEqual(shown.html.map((p) => p.part), ['1.2.1']);
  assert.deepEqual(shown.text.map((p) => p.part), ['1.1'], 'the plain alternative for text preview / snippets');
  assert.deepEqual(shown.images.map((p) => p.id), ['logo@x']);
  assert.equal(M.snippetPart(tree).part, '1.1');
  assert.deepEqual(M.attachments(tree), [
    { name: '계약서.pdf', size: 3000, type: 'application/pdf' },
    { name: 'photo.jpg', size: 10, type: 'image/jpeg' },
    { name: '원본 메일.eml', size: 10, type: 'message/rfc822' },
  ]);
  const single = { ...leaf('text', 'html', '1'), root: true };
  assert.equal(M.sectionOf(single), 'TEXT', 'single-part body is fetched as TEXT');
  assert.equal(M.sectionOf(shown.html[0]), '1.2.1');
});
