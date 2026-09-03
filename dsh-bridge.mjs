// dsh-bridge.mjs
// 把 Anthropic 兼容格式的 /v1/messages 请求翻译成 DeepSeek Harness Web 的 RPC 调用。
// 微信接入端（wechat-bot.mjs）把 AI 接口指向本服务即可。
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const DSH_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080';
const SESSION_ID = process.env.DSH_SESSION_ID ??
  'session-97c4ed62-9020-4150-bf9d-3dcf04b3d7bd'; // 默认：当前网页会话
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3081);
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 10 * 60 * 1000);
const POLL_MS = Number(process.env.POLL_MS ?? 500);

const log = (...a) => console.log(new Date().toISOString(), '[bridge]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- DSH RPC 一元调用（POST /api/<method>，信封：client-request）----
async function rpc(method, payload) {
  const rpcId = randomUUID();
  const res = await fetch(`${DSH_URL}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`DSH ${method}: HTTP ${res.status}`);
  const full = await res.json();
  if (full?.type !== 'server-response' || full.rpcId !== rpcId) {
    throw new Error(`DSH ${method}: 意外响应`);
  }
  if (!full.result.ok) {
    throw new Error(`DSH ${method} 业务错误: ${JSON.stringify(full.result.error)}`);
  }
  return full.result.value;
}

// ---- 提取文本 ----
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

// 从会话历史尾页读取当前最大的 turn 号（用于定位“我们这次投递所触发的新 turn”）。
// maxMessages 只统计 user/assistant 表层消息，但会带上大量 assistant/chunk 流事件，取小值以限制载荷。
async function latestTurnNumber() {
  const { events } = await rpc('session.history', { sessionId: SESSION_ID, maxMessages: 3 });
  let t = 0;
  for (const { event } of events ?? []) {
    const turn = event?.data?.turn;
    if (typeof turn === 'number') t = Math.max(t, turn);
  }
  return t;
}

// ---- 投递消息并等待本轮回复（轮询 history，简单可靠）----
async function promptAndCollect(text) {
  const t0 = await latestTurnNumber();
  await rpc('session.prompt', {
    sessionId: SESSION_ID,
    mode: 'queue',
    content: [{ type: 'text', text }],
  });

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let lastText = '';
  let sawNewTurn = false;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let events;
    try {
      ({ events } = await rpc('session.history', { sessionId: SESSION_ID, maxMessages: 3 }));
    } catch (e) {
      continue; // 会话可能正在 flush；下一轮再读
    }
    const mine = (events ?? []).filter(({ event }) => {
      const turn = event?.data?.turn;
      return typeof turn === 'number' && turn > t0;
    });

    for (const { event } of mine) {
      if (event.type === 'assistant/message') {
        const txt = extractText(event.data?.message?.content);
        if (txt) lastText = txt;
      } else if (event.type === 'turn/start') {
        sawNewTurn = true;
      }
    }
    if (mine.some(({ event }) => event.type === 'turn/end')) {
      return lastText || (sawNewTurn ? '（本轮没有文本输出）' : '（未收到回复）');
    }
  }
  return lastText || '（等待回复超时）';
}

// ---- Anthropic 请求体解析 ----
function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) =>
      typeof b === 'string' ? b : b && b.type === 'text' ? b.text : ''
    ).join('');
  }
  return String(content ?? '');
}

function lastUserText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') {
      const t = normalizeContent(m.content).trim();
      if (t) return t;
    }
  }
  return '';
}

// ---- 串行化：同一时刻只投递一条（避免 turn 定位歧义）----
let chain = Promise.resolve();
function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

async function handleMessages(body) {
  const userText = lastUserText(body?.messages);
  if (!userText) {
    return { error: '没有可用的用户消息', status: 400 };
  }
  const reply = await promptAndCollect(userText);
  const model = body?.model ?? 'dsh';
  return {
    status: 200,
    body: {
      id: 'msg_' + randomUUID(),
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: reply }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

// ---- HTTP 服务 ----
const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,x-api-key,anthropic-version',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    return res.end(JSON.stringify({
      ok: true, service: 'dsh-wechat-bridge',
      dshUrl: DSH_URL, sessionId: SESSION_ID,
    }));
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch {
        res.writeHead(400, { 'content-type': 'application/json', ...cors });
        return res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
      serialized(async () => {
        try {
          const r = await handleMessages(body);
          res.writeHead(r.status, { 'content-type': 'application/json', ...cors });
          res.end(JSON.stringify(r.error ? { error: r.error } : r.body));
        } catch (e) {
          log('处理失败:', e?.message ?? e);
          res.writeHead(500, { 'content-type': 'application/json', ...cors });
          res.end(JSON.stringify({ error: 'bridge error: ' + (e?.message ?? e) }));
        }
      });
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json', ...cors });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, HOST, () => {
  log(`桥接器已启动: http://${HOST}:${PORT}/v1/messages`);
  log(`→ DSH: ${DSH_URL}  会话: ${SESSION_ID}`);
});
