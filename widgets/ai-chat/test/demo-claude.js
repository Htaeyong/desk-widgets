// Dev-only: a scripted `claude` for the AI Widgets screenshots (screenshots.electron.js). demo.json beside it says what this run
// shows: steps of folded tool calls and answer text, a cost, and optionally an approval it asks for and waits on. Every word is
// made up for the picture. It never contacts a server and never asks the key helper for a key.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo.json'), 'utf8'));
if (args[0] === '--version') {
  console.log('2.1.309 (Claude Code)');
  process.exit(0);
}

const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

/** Calls one tool of ai-chat-host the way Claude Code does (initialize, then tools/call) and resolves with its answer. */
function callHost(tool, toolArgs) {
  const server = JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8')).mcpServers['ai-chat-host'];
  const child = cp.spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buffer = '';
  return new Promise((resolve) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const m = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (m.id === 2) resolve(m.result);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: toolArgs } })}\n`);
  });
}

process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', async () => {
  const sid = opt('--resume') || demo.sessionId;
  emit({
    type: 'system', subtype: 'init', session_id: sid, model: opt('--model'), apiKeySource: 'apiKeyHelper', permissionMode: opt('--permission-mode'),
    tools: opt('--tools').split(','), mcp_servers: [{ name: 'ai-chat-host', status: 'connected' }],
  });
  let n = 0;
  let last = '';
  for (const step of demo.steps || []) {
    if (step.tools) for (const [name, input] of step.tools) emit({ type: 'assistant', session_id: sid, message: { id: `m${n}`, content: [{ type: 'tool_use', id: `t${n++}`, name, input }] } });
    if (step.text) {
      last = step.text;
      emit({ type: 'assistant', session_id: sid, message: { id: `m${n++}`, content: [{ type: 'text', text: step.text }], usage: { input_tokens: 1200, output_tokens: 300 } } });
    }
  }
  if (demo.approve) {
    await callHost('approve', { tool_name: demo.approve.tool, input: demo.approve.input, tool_use_id: 'demo' });
    process.exit(0);
  }
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: last, num_turns: 1, total_cost_usd: demo.cost, usage: { input_tokens: 1200, output_tokens: 300 }, permission_denials: [] });
  process.exit(0);
});
