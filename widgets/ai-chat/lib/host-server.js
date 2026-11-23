// The widget's end of ai-chat-host (#129): a named pipe for one run with a random name and token. Only a connection that gives
// the token first can ask anything, and asking only ever puts a card in front of the user. Anything still waiting when the run
// ends is answered "no" (null).
const crypto = require('crypto');
const net = require('net');

const MAX_LINE = 8 * 1024 * 1024;

function createHostServer(onCall) {
  const id = crypto.randomBytes(12).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const expected = Buffer.from(token);
  const sockets = new Set();
  const tokenOk = (given) => {
    const b = Buffer.from(String(given ?? ''));
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let trusted = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const handle = (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (!trusted) {
        if (!tokenOk(m?.token)) {
          socket.destroy();
          return;
        }
        trusted = true;
        return;
      }
      Promise.resolve()
        .then(() => onCall(String(m.method), m.args))
        .catch(() => null)
        .then((result) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify({ id: m.id, result: result ?? null })}\n`);
        });
    };
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line.trim()) handle(line);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(`\\\\.\\pipe\\ai-chat-host-${id}`, () => resolve({
      id,
      token,
      close: () => new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
    }));
  });
}

module.exports = { createHostServer };
