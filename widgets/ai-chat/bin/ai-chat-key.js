// apiKeyHelper of the AI chat widget (#129). Claude Code runs it through ai-chat-key.cmd and reads the key from stdout.
// The key comes over a local pipe from the widget, which answers once per run. This file, its arguments and the settings
// hold only the pipe's id and a one-run value, never the key. It prints nothing but the key, as the helper contract requires.
'use strict';

const net = require('net');

const [id, nonce] = process.argv.slice(2);
if (!/^[0-9a-f]{16,64}$/.test(id || '') || !/^[0-9a-f]{16,64}$/.test(nonce || '')) process.exit(1);

let value = '';
const socket = net.connect(`\\\\.\\pipe\\ai-chat-key-${id}`);
socket.setEncoding('utf8');
socket.setTimeout(10000, () => socket.destroy());
socket.on('connect', () => socket.write(`${nonce}\n`));
socket.on('data', (chunk) => { value += chunk; });
socket.on('error', () => process.exit(1));
socket.on('close', () => {
  if (!value) process.exit(1);
  process.stdout.write(value, () => process.exit(0));
});
