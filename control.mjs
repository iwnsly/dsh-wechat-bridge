// control.mjs
// DSH ↔ 微信 ClawBot 控制服务：内嵌微信 Bot（扫码绑定/解绑）+ DSH 会话路由 + 配置网页 + 服务监控。
// 启动: node control.mjs   →  配置页 http://127.0.0.1:3083
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createDecipheriv, createCipheriv, createHash, randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WX_BASE = 'https://ilinkai.weixin.qq.com';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3083);
const DSH_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080';
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 10 * 60 * 1000);
const POLL_MS = Number(process.env.POLL_MS ?? 500);
const CONFIG_PATH = process.env.CONFIG_PATH ?? path.join(__dirname, 'config.json');
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startTime = Date.now();
const log = (...a) => {
  const msg = a.join(' ');
  console.log(`[${new Date().toISOString()}] ${msg}`);
  ring.push({ t: Date.now(), line: msg });
  if (ring.length > 300) ring.splice(0, ring.length - 300);
};
const ring = [];

// ---------------- 配置持久化 ----------------
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const c = JSON.parse(raw);
    return {
      dsh: { url: DSH_URL, ...(c.dsh ?? {}) },
      wechat: c.wechat ?? {},
      defaultSessionId: c.defaultSessionId ?? null,
    };
  } catch {
    return { dsh: { url: DSH_URL }, wechat: {}, defaultSessionId: null };
  }
}
function saveConfig() {
  const tmp = CONFIG_PATH + '.tmp';
  const persisted = {
    dsh: { url: DSH_URL },
    wechat: config.wechat,
    defaultSessionId: config.defaultSessionId ?? null,
  };
  fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}
let config = loadConfig();

// ---------------- 微信发送凭证持久化（重启后仍可继续同步推送） ----------------
const STATE_PATH = CONFIG_PATH.replace(/config\.json$/, 'state.json');
// 待补发队列（发送失败暂存，凭证刷新后自动补发；持久化到 state.json 跨重启不丢）
const pendingReplies = new Map(); // peerId -> string[]
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) ?? {}; } catch { return {}; }
}
function saveState() {
  try {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      peerTokens: Object.fromEntries(peerTokens),
      lastActivePeer,
      pendingReplies: Object.fromEntries(pendingReplies),
    }, null, 2));
    fs.renameSync(tmp, STATE_PATH);
    try { fs.chmodSync(STATE_PATH, 0o600); } catch {}
  } catch (e) { log('保存 state.json 失败:', e.message); }
}

// ---------------- DSH 客户端 ----------------
async function dshRpc(method, payload, timeoutMs = 60_000) {
  const rpcId = randomUUID();
  const res = await fetch(`${config.dsh.url}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`DSH ${method}: HTTP ${res.status}`);
  const full = await res.json();
  if (full?.type !== 'server-response' || full.rpcId !== rpcId) throw new Error(`DSH ${method}: 意外响应`);
  if (!full.result.ok) throw new Error(`DSH ${method} 业务错误: ${JSON.stringify(full.result.error)}`);
  return full.result.value;
}
async function dshStatus() {
  try {
    await dshRpc('session.list', {}, 8000);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
async function listSessions() {
  const { items } = await dshRpc('session.list', {}, 15_000);
  // 与 DSH 网页完全一致的可见规则：
  // 1. 已归档（删除/隐藏）的会话不显示
  // 2. 空白会话（无任何对话内容）不显示、不可选
  // 3. 子任务会话（parentSessionId 非空）不显示——它们是某会话派生的子任务，不出现在工作区/界面
  // 4. 只显示归属于某个工作区（workspace.sessionIds）的会话，与界面左侧列表一致
  let archived = new Set();
  let inWorkspace = new Set();
  try {
    const wl = await dshRpc('workspace.list', {}, 15_000);
    archived = new Set(wl.archivedSessionIds ?? []);
    for (const w of wl.items ?? []) for (const sid of w.sessionIds ?? []) inWorkspace.add(sid);
  } catch {}
  return items
    .filter((s) => !archived.has(s.sessionId))
    .filter((s) => !s.blank)
    .filter((s) => !s.parentSessionId)
    .filter((s) => inWorkspace.has(s.sessionId))
    .map((s) => ({
    sessionId: s.sessionId,
    title: s.projections?.values?.title ?? null,
    cwd: s.cwd ?? null,
    running: !!s.running,
    blank: !!s.blank,
    updatedAt: s.updatedAt,
  }));
}
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}
async function latestTurnNumber(sessionId) {
  const { events } = await dshRpc('session.history', { sessionId, maxMessages: 3 });
  let t = 0;
  for (const { event } of events ?? []) {
    const turn = event?.data?.turn;
    if (typeof turn === 'number') t = Math.max(t, turn);
  }
  return t;
}
// 优雅停机：收到停止信号时，让在途任务先把“中断通知”发回微信，避免最终回复静默丢失
let shuttingDown = false;
process.on('SIGTERM', () => {
  shuttingDown = true;
  log('收到停止信号，进入优雅停机（若在途任务会收到中断通知）…');
  setTimeout(() => { log('停机宽限结束，强制退出'); process.exit(0); }, 8000);
});
process.on('SIGINT', () => { shuttingDown = true; process.exit(0); });

// 轮询窗口：一次拉取最近 N 条“消息级”事件（DSH 的 session.history 的 maxMessages 语义≈
// 返回尾部往前 N 条消息/回合的全量事件，事件条数非线性——实测 5→约 2 千条、50→约 2 万条、
// 200→约 8.5 万条）。窗口需大于“相邻两次拉取之间新增的事件数”（500ms 最多约数千条），
// 且越小负载越低；50 足以防漏（曾用 200 实测漏 2 条源于游标初始化/解析问题而非窗口大小）。
const HISTORY_WINDOW = 50;
// 连续多少次 history 查询失败即判定 DSH 失联/报错（还需持续 ≥4 秒，避免重启瞬间误报）
const MAX_POLL_ERRORS = 3;

// ---------------- 绑定会话回复同步 ----------------
// 目标：绑定（默认）会话里由 DSH 网页端发起的对话，其回复也同步推送到微信。
// 机制：会话级共享 seq 游标（微信任务轮询与监听循环共用，保证每条回复只发一次）；
//       engagedSessions 闸门：微信发起的任务在跑时，监听循环对该会话让路。
const sessionRelay = new Map(); // sessionId -> { lastSeq, lastText }
const engagedSessions = new Set();
const prevState = loadState();
// 恢复待补发队列（跨重启不丢；发送失败的回复在凭证刷新后自动补发）
if (prevState?.pendingReplies && typeof prevState.pendingReplies === 'object') {
  for (const [peer, arr] of Object.entries(prevState.pendingReplies)) {
    if (Array.isArray(arr) && arr.length) pendingReplies.set(peer, arr.filter(Boolean));
  }
}
const peerTokens = new Map(Object.entries(prevState.peerTokens ?? {})); // peerId -> context_token
let lastActivePeer = prevState.lastActivePeer ?? null;                 // 最近发来消息的联系人

function relayCursor(sessionId) {
  let st = sessionRelay.get(sessionId);
  if (!st) {
    st = {
      lastSeq: 0, lastText: '', lastSent: '', lastPushAt: 0, initialized: false,
      lastFailAt: 0, lastLoggedAt: 0,   // 失败冷却/日志节流
      lastSentAt: Date.now(),           // 视为“刚发送过”，30 秒后才可能发状态（避免启动即发“已等待 N 秒”）
      lastEventAt: 0, taskStartAt: 0,   // 30 秒状态：最新事件时间 / 任务起点
    };
    sessionRelay.set(sessionId, st);
  }
  return st;
}
// 把 DSH 的 turn/end reason 翻译成要给微信看的文案；正常结束返回 null
function relayReasonText(reason) {
  if (!reason) return null;
  if (reason.kind === 'error') {
    const d = reason.error
      ? String(reason.error.message ?? JSON.stringify(reason.error)).slice(0, 200)
      : '未知错误';
    return `（DSH 处理出错：${d}）`;
  }
  if (reason.kind === 'aborted') return '（任务已被中断，未完成；可能是网页端停止了该会话，或执行被中止。）';
  if (reason.kind === 'interrupted') return '（任务被中断，未完成。）';
  return null;
}

async function promptAndCollect(sessionId, text, isCancelled, onStage, deliveredRef = {}) {
  engagedSessions.add(sessionId); // 本会话由微信任务接管，监听循环让路
  try {
    const t0 = await latestTurnNumber(sessionId);
    await dshRpc('session.prompt', {
      sessionId, mode: 'queue', content: [{ type: 'text', text }],
    });
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    const st = relayCursor(sessionId); // 与监听循环共享的游标
    let lastText = '';
    let deliveredText = '';
    let sawNewTurn = false;
    let hasEnd = false;
    let turnReason = null;
    let failStreak = 0;
    let firstFailAt = 0;
    while (Date.now() < deadline) {
      if (isCancelled?.()) return ''; // 被微信「取消」中断
      if (shuttingDown) return '（⚠️ 服务正在升级重启，本条任务已被中断，请稍后重发。）';
      await sleep(POLL_MS);
      let events;
      try {
        ({ events } = await dshRpc('session.history', { sessionId, maxMessages: HISTORY_WINDOW }));
        failStreak = 0;
      } catch (e) {
        failStreak++;
        if (firstFailAt === 0) firstFailAt = Date.now();
        // DSH 失联/报错：停止轮询，把错误发回微信，不再干等到超时
        if (failStreak >= MAX_POLL_ERRORS && Date.now() - firstFailAt >= 4000) {
          const down = new Error(`DSH 连续 ${failStreak} 次查询失败，服务可能已停止：${e.message ?? e}`);
          down.dshDown = true;
          throw down;
        }
        continue;
      }
      let newMaxSeq = st.lastSeq;
      for (const { event } of events ?? []) {
        const seq = Number(event?.seq ?? 0);
        if (seq <= st.lastSeq) continue;
        newMaxSeq = Math.max(newMaxSeq, seq);
        const turn = event?.data?.turn;
        if (typeof turn !== 'number' || turn <= t0) continue;
        if (event.type === 'assistant/message') {
          const txt = extractText(event.data?.message?.content);
          if (txt) {
            lastText = txt;
            // 阶段回复：每个 assistant 步骤的定稿文本一出现就发给微信，不等 turn/end
            if (onStage && txt !== deliveredText) {
              try {
                await onStage(txt);
                deliveredText = txt; // 发送成功才推进；失败则最终回复会补发这段内容，不丢失
                noteAssistantText(sessionId, txt); // 检测"编号选项提问"→记录待回答状态
                maybeNotifyConfirm(sessionId); // 权限/确认类请求 → 微信推「是/否」提示
              } catch { /* 阶段发送失败：留待最终回复兜底 */ }
            }
          }
        } else if (event.type === 'turn/start') {
          sawNewTurn = true;
        } else if (event.type === 'turn/end') {
          hasEnd = true;
          turnReason = event.data?.reason ?? null;
        }
      }
      st.lastSeq = Math.max(st.lastSeq, newMaxSeq);
      if (hasEnd) {
        if (isCancelled?.()) return ''; // 用户已发「取消」，静默收尾（取消回执已发送）
        deliveredRef.current = deliveredText; // 供外层判断最终文本是否已随阶段回复发出
        // DSH 端报错/中断：把原因发回微信，绝不静默
        const relayed = relayReasonText(turnReason);
        if (relayed) return relayed;
        return lastText || (sawNewTurn ? '（本轮没有文本输出）' : '（未收到回复）');
      }
    }
    return lastText || '（等待回复超时）';
  } finally {
    engagedSessions.delete(sessionId);
  }
}
// 按会话串行化，避免同一会话并发导致 turn 定位歧义；不同会话可并行。
const sessionChains = new Map();
function runPrompt(sessionId, text, isCancelled, onStage, deliveredRef) {
  const prev = sessionChains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(() => promptAndCollect(sessionId, text, isCancelled, onStage, deliveredRef));
  sessionChains.set(sessionId, next.catch(() => {}));
  return next;
}

// 等待 DSH 回复期间，若距上次发到微信已超过 30 秒（且期间没有再发过任何消息），
// 才发一条“处理中”状态；每次给微信发消息都会重置 30 秒计时。
const WX_STATUS_INTERVAL_MS = 30_000;
const WX_STATUS_CHECK_MS = 10_000; // 每 10 秒检查一次是否已满 30 秒无消息
async function promptWithStatus(peerId, contextToken, sessionId, text, isCancelled, onStage, deliveredRef = {}, sentRef = {}, startAt = Date.now()) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    const lastAt = typeof sentRef.at === 'number' ? sentRef.at : Date.now();
    const since = Date.now() - lastAt;
    // 30 秒内发过消息（回执/阶段回复/状态本身）→ 不提示，等待下一个窗口
    if (isCancelled?.() || since < WX_STATUS_INTERVAL_MS) { busy = false; return; }
    // 显示的秒数是“从用户发消息开始”的总等待时间（不是距上次消息的时间）
    const waited = Math.round((Date.now() - startAt) / 1000);
    try {
      await Promise.race([
        sendText(peerId, contextToken, `⏳ 正在处理中，请稍候…（已等待 ${waited} 秒）`),
        sleep(10_000).then(() => { throw new Error('状态发送超时'); }),
      ]);
      sentRef.at = Date.now(); // 状态提示本身也算一次发送，重新计时
      log(`状态提醒已发送 [${peerId}]: ⏳ 已等待 ${waited} 秒`);
    } catch (e) {
      log('状态提醒发送失败:', e.message);
    }
    busy = false;
  }, WX_STATUS_CHECK_MS);
  try {
    const reply = await runPrompt(sessionId, text, isCancelled, onStage, deliveredRef);
    return reply ?? '（对话返回为空）';
  } finally {
    clearInterval(timer);
  }
}

async function sessionContextLabel(sessionId) {
  if (!sessionId) return '';
  try {
    const [wl, sl] = await Promise.all([
      dshRpc('workspace.list', {}, 15_000).catch(() => null),
      dshRpc('session.list', {}, 15_000).catch(() => null),
    ]);
    const wsTitle = (wl?.items ?? []).find((w) => (w.sessionIds ?? []).includes(sessionId))?.title;
    const ses = (sl?.items ?? []).find((x) => x.sessionId === sessionId);
    const sTitle = ses?.projections?.values?.title ?? ses?.title ?? '';
    const name = sTitle && sTitle.trim() ? sTitle : sessionId.slice(0, 12);
    return [wsTitle ? `工作区「${wsTitle}」` : null, `会话「${name}」`].filter(Boolean).join(' · ');
  } catch { return ''; }
}

// 超过 2 小时未收到微信消息时，回执附带当前工作区/会话名
const IDLE_CONTEXT_MS = 2 * 60 * 60 * 1000;
async function ackText(sessionId, withContext) {
  if (!withContext) return '✅ 已收到，开始处理…';
  const label = await sessionContextLabel(sessionId);
  return label ? `✅ 已收到，开始处理。当前对话：${label}` : '✅ 已收到，开始处理…';
}

// ---- 全局 iLink 发送风控自动冷却 ----
// 连续多次 prepare failed（ret=-2）说明 iLink 正在风控；此时若继续高频打请求只会加重风控。
// 触发冷却后，冷却期内所有发送请求直接跳过（不请求），避免恶化；冷却结束后自动恢复并补发。
const RATE_LIMIT_COOLDOWN_MS = 3 * 60 * 1000;
let rateLimitUntil = 0;
let rateLimitStreak = 0;
function noteSendFailure(err) {
  if (err && /prepare failed|ret=-2/.test(String(err.message ?? ''))) {
    rateLimitStreak++;
    if (rateLimitStreak >= 3) {
      rateLimitUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      log(`检测到 iLink 发送风控（连续 ${rateLimitStreak} 次失败），暂停发送 ${RATE_LIMIT_COOLDOWN_MS / 60000} 分钟，到期自动恢复`);
      rateLimitStreak = 0;
    }
  } else {
    rateLimitStreak = 0;
  }
}
function sendRateLimited() { return Date.now() < rateLimitUntil; }

// 发送带超时与自动重试（针对“结果没发回微信”的兜底）
async function sendTextWithRetry(peerId, contextToken, text, tries = 2) {
  if (sendRateLimited()) throw new Error('iLink 发送风控冷却中，稍后自动重试'); // 冷却期不发请求，避免加重
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      await Promise.race([
        sendText(peerId, contextToken, text),
        sleep(15_000).then(() => { throw new Error('发送超时'); }),
      ]);
      return true;
    } catch (e) {
      lastErr = e;
      log(`发送消息重试 ${i + 1}/${tries}: ${e.message}`);
      noteSendFailure(e); // 连续 prepare failed → 触发全局冷却
      await sleep(2000);
    }
  }
  throw lastErr;
}

// 发送失败的回复先暂存，等用户下次发微信消息（刷新 context_token）后自动补发，
// 解决"长任务期间凭证失效导致回复静默丢失"的问题（两次实锤过）。
// 声明见顶部 state 区（持久化用）；此处仅定义操作函数。
function enqueuePendingReply(peerId, text) {
  if (!peerId || !text) return;
  let arr = pendingReplies.get(peerId);
  if (!arr) { arr = []; pendingReplies.set(peerId, arr); }
  if (arr.includes(text)) return; // 去重
  if (arr.length >= 10) arr.shift(); // 上限
  arr.push(text);
  log(`待补发入队 [${peerId}]: ${text.slice(0, 30)}${text.length > 30 ? '…' : ''}`);
}
async function flushPendingReplies(peerId, contextToken) {
  const arr = pendingReplies.get(peerId);
  if (!arr || !arr.length || !contextToken) return;
  const last = arr[arr.length - 1]; // 只补发最后一条（最新/最终结果），不刷屏
  pendingReplies.delete(peerId); // 清空积压
  try {
    await sendTextWithRetry(peerId, contextToken, `（补发）${last}`);
    log(`补发成功 [${peerId}]: ${last.slice(0, 40)}${last.length > 40 ? '…' : ''}`);
  } catch (e) {
    pendingReplies.set(peerId, [last]); // 失败保留，等下次发消息再补
    log('补发失败（保留待下次）:', e.message);
  }
}

// ---------------- 微信 iLink 客户端 ----------------
function wxHeaders(token) {
  const uin = BigInt(Math.floor(Math.random() * 0xFFFFFFFF)).toString();
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(uin).toString('base64'),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
async function wxPost(path, body, token) {
  const res = await fetch(`${WX_BASE}/${path}`, {
    method: 'POST',
    headers: wxHeaders(token),
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------------- 微信 Bot 状态机 ----------------
let token = config.wechat.botToken ?? null;
let boundAt = config.wechat.boundAt ?? null;
let bindGen = 0;
let binding = null; // { gen, qrcode, message }
let updatesBuf = '';
const typingTickets = new Map();
let lastPollAt = 0;
let lastMessageAt = Date.now(); // 初始视为“刚聊过”，避免重启后误报 2 小时空闲
let handledCount = 0;
let errorCount = 0;

async function startBind() {
  if (token) return { ok: true, already: true };
  const gen = ++bindGen;
  binding = { gen, qrcode: null, message: '正在获取二维码…' };
  (async () => {
    try {
      const { qrcode, qrcode_img_content } = await fetch(
        `${WX_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`
      ).then((r) => r.json());
      if (gen !== bindGen) return;

      let qr = null;
      if (qrcode_img_content) {
        const content = String(qrcode_img_content);
        if (content.startsWith('data:image/')) qr = content;
        else if (content.startsWith('http')) qr = content;
        else if (content.startsWith('<svg')) qr = 'data:image/svg+xml;base64,' + Buffer.from(content).toString('base64');
        else qr = 'data:image/png;base64,' + content;
      }
      binding.qrcode = qr;
      binding.message = '请用手机微信扫码，并在手机上确认连接授权';

      while (gen === bindGen) {
        const status = await fetch(
          `${WX_BASE}/ilink/bot/get_qrcode_status?qrcode=${qrcode}`
        ).then((r) => r.json());
        if (status.status === 'confirmed') {
          token = status.bot_token;
          boundAt = Date.now();
          binding = null;
          config.wechat = { botToken: token, boundAt };
          saveConfig();
          log('微信绑定成功');
          return;
        }
        if (status.status === 'expired' || status.status === 'canceled') {
          binding.message = '二维码已失效，点击"绑定微信"重新生成';
          return;
        }
        await sleep(1500);
      }
    } catch (e) {
      if (gen === bindGen) binding.message = '获取二维码失败: ' + (e.message ?? e);
    }
  })();
  return { ok: true };
}

function doUnbind() {
  bindGen++; // 使进行中的绑定流程失效
  token = null;
  boundAt = null;
  binding = null;
  typingTickets.clear();
  config.wechat = {};
  saveConfig();
  log('微信已解绑');
  return { ok: true };
}

// 单人单绑定：路由只认默认会话，不再按好友区分
function resolveSession() {
  return config.defaultSessionId ?? null;
}

// ---- 微信命令 ----
// 「切换对话」（语音识别可能带标点或旧叫法，做兼容匹配）
const SWITCH_CMD = '切换对话';
const SWITCH_ALIASES = ['切换会话', '切换到对话', '切换到会话'];
const NEW_CMD = '新对话';
const NEW_ALIASES = ['新建对话', '新开会话', '新开对话'];
const STATUS_CMD = '状态';
const STATUS_ALIASES = ['当前状态', '状态查询', '任务状态', 'status', 'Status'];
const HELP_CMD = '指令';
const HELP_ALIASES = ['帮助', '菜单', 'help', 'Help', '指令列表', '有哪些指令', '怎么用'];

// —— DSH 交互选择模拟 ——
// DSH 无内建"等待用户输入"机制（无相关事件/API，prompt 仅支持 queue 模式）。
// 方案：检测 agent 回复里的"编号选项提问"（含明确提示词且解析出 ≥2 个编号项）→
// 记住待回答状态；微信回复序号时，把对应选项内容作为新消息注入 DSH 会话（queue），
// agent 在下一轮据此继续。
const INTERACT_FRESH_MS = 10 * 60 * 1000; // 待回答提问的有效期
const pendingInteraction = new Map(); // sessionId -> { type:'options'|'yesno', options?, question, at }
const INTERACT_HINT = /请选择|请回复|回复[序号数字]|回复\s*[0-9一二两三四五六七八九十]|你选|你希望|想让你|需要你选择|选一个|麻烦选|哪个(方案|选项)|告诉我选/;
// 权限/确认类请求：agent 需要用户"是/否"拍板（DSH 无权限批准 API，采用文本注入告知用户决策）
const PERM_HINT = /需要(你)?(的)?(权限|授权|批准)|请求(你)?(的)?(权限|授权)|需要更高权限|是否(允许|继续|执行|同意|可以|删除|需要|完成)|请(授权|批准|确认)|permission/i;
// 从文本解析编号选项列表（1. xxx / 1、xxx / 1) xxx），不足 2 项返回 null
function parseOptions(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const opts = [];
  let expect = 1;
  const re = /^(\d{1,2})[\.、\)）]\s*(.+)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n === expect) { opts.push(m[2].trim()); expect++; }
  }
  return opts.length >= 2 ? opts : null;
}
// 记录/作废"待回答提问"：agent 每产生一条新回复都调用。
// 类型：'options'=编号选项选择；'yesno'=权限/确认类（是/否）。
function noteAssistantText(sessionId, text) {
  if (!text) return;
  const options = INTERACT_HINT.test(text) ? parseOptions(text) : null;
  if (options) {
    pendingInteraction.set(sessionId, { type: 'options', options, question: text.slice(0, 200), at: Date.now() });
    return;
  }
  if (PERM_HINT.test(text)) {
    pendingInteraction.set(sessionId, { type: 'yesno', question: text.slice(0, 200), at: Date.now() });
    return;
  }
  pendingInteraction.delete(sessionId); // 有新实质回复，旧的待回答提问作废
}
// 若是/否确认待回答 → 微信推一条提示（不阻塞；同一条文本只触发一次）
function maybeNotifyConfirm(sessionId) {
  const peerId = lastActivePeer;
  if (!peerId) return;
  const pend = pendingInteraction.get(sessionId);
  if (pend?.type !== 'yesno') return;
  const ctx = peerTokens.get(peerId);
  if (!ctx) return;
  void sendTextWithRetry(peerId, ctx, '⚡ DSH 需要你的确认：回复「是」或「否」').catch(() => {});
}
const SWITCH_PENDING_TTL_MS = 2 * 60 * 1000;
const switchPending = new Map(); // peerId -> { kind: 'session'|'workspace', expireAt, ... }
// 正在等待 DSH 回复的执行：sessionId -> { cancelled }；微信「取消」会标记并调 DSH session.cancel
const activeRuns = new Map();
// 「取消」词集合（语音识别可能带标点，先 stripPunct 再匹配）
const CANCEL_WORDS = ['取消', '取消吧', '停', '停止', '算了'];

// 去常见中英文标点/空格后再比较（语音识别友好："切换对话。"也算命令）
const stripPunct = (s) => String(s).replace(/[\s，。！？!?,.、：:；;~～]+/g, '');
function isCmd(t, cmd, aliases = []) {
  const n = stripPunct(t);
  return n === stripPunct(cmd) || aliases.some((a) => n === stripPunct(a));
}

// 语音识别可能把数字听成中文（"二"→2）；支持 0-99
function parseChoiceNum(t) {
  const s = String(t ?? '').trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  if (!/^[零一二两三四五六七八九十]+$/.test(s)) return -1;
  if (s.length === 1) return CN[s] ?? -1;
  const parts = s.split('十');
  if (parts.length === 2) {
    const tens = parts[0] ? (CN[parts[0]] ?? 1) : 1;
    const ones = parts[1] ? (CN[parts[1]] ?? 0) : 0;
    return tens * 10 + ones;
  }
  return -1;
}

async function buildSwitchList() {
  // listSessions 已过滤归档 + 空白会话（与 DSH 网页一致）
  const items = await listSessions();
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

function fmtSessionList(peerId, sessions, currentId) {
  const lines = sessions.map((s, i) => {
    const name = s.title && s.title.trim() ? s.title : s.sessionId;
    const cur = s.sessionId === currentId ? '（当前）★' : '';
    return `${i + 1}. ${name} ${cur}`.trimEnd();
  });
  return ['📋 可切换的对话清单：', '0. ➕ 新对话', ...lines, '', '回复编号切换；回复 0 新开对话；回复「取消」放弃。'].join('\n');
}

const BUSY_ACTIVE_TYPES = new Set(['assistant/chunk', 'assistant/message', 'tool/call', 'tool/result', 'step/start', 'step/end', 'turn/start', 'user/message']);
const BUSY_FRESH_MS = 120_000; // 无 turn 边界事件时，最近活跃事件距今小于此值视为仍在执行
// 纯函数：从一批 history 事件判断会话是否正在执行任务（附最新阶段回复/正在执行的命令）
// 判断依据：最新 turn/start 是否晚于最新 turn/end（有 start 无 end → 执行中）；
// 窗口内无 turn 边界事件时（超长任务把 turn/start 挤出窗口）按「最近活跃事件距今」推断。
// sessionBusyInfo 与同步推送的 30 秒状态共用同一判定，保证"空闲会话不再误发处理中"。
function busyFromEvents(evs) {
  let lastStartSeq = -1;
  let lastEndSeq = -1;
  let lastActiveAt = 0;
  let lastMessage = '';
  let lastCommand = '';
  for (const { event } of evs) {
    const seq = Number(event?.seq ?? 0);
    const t = new Date(event?.time ?? 0).getTime();
    if (event?.type === 'turn/start') lastStartSeq = Math.max(lastStartSeq, seq);
    else if (event?.type === 'turn/end') lastEndSeq = Math.max(lastEndSeq, seq);
    else if (event?.type === 'assistant/message') {
      const txt = extractText(event?.data?.message?.content);
      if (txt) lastMessage = txt; // 保留最新一条阶段/最终文本
    } else if (event?.type === 'tool/call') {
      // 实测 DSH 结构：{ data: { name: 'bash', arguments: '{"command":"…"}' } }
      const toolName = event?.data?.name ?? event?.data?.tool?.name ?? '';
      const args = event?.data?.arguments ?? event?.data?.tool?.input ?? event?.data?.input;
      let cmd = '';
      if (typeof args === 'string') {
        try { const a = JSON.parse(args); cmd = a.command ?? a.cmd ?? a.script ?? JSON.stringify(a); }
        catch { cmd = args; }
      } else if (args && typeof args === 'object') {
        cmd = args.command ?? args.cmd ?? args.script
          ?? (Object.keys(args).length ? JSON.stringify(args) : '');
      }
      if (cmd) lastCommand = `${toolName ? toolName + ': ' : ''}${cmd}`;
    }
    if (BUSY_ACTIVE_TYPES.has(event?.type)) lastActiveAt = Math.max(lastActiveAt, t || 0);
  }
  let busy;
  if (lastStartSeq === -1) {
    // 窗口内没有 turn/start：见到了 turn/end → 空闲；否则凭最近活跃时间（超长任务的 start 可能已挤出窗口）
    busy = lastEndSeq === -1 ? (Date.now() - lastActiveAt < BUSY_FRESH_MS) : false;
  } else {
    busy = lastEndSeq === -1 || lastStartSeq > lastEndSeq;
  }
  return busy ? { busy: true, lastMessage, lastCommand } : { busy: false };
}

async function sessionBusyInfo(sessionId) {
  const { events } = await dshRpc('session.history', { sessionId, maxMessages: HISTORY_WINDOW });
  return busyFromEvents(events ?? []);
}

// 「切换对话」命令只回清单；状态查询移到「选中编号切换成功后」（applySwitchChoice 回目标会话状态）
async function handleSwitchCmd(peerId) {
  try {
    const sessions = await buildSwitchList();
    if (!sessions.length) return '（当前没有可切换的对话。）';
    switchPending.set(peerId, { kind: 'session', sessions, expireAt: Date.now() + SWITCH_PENDING_TTL_MS });
    log(`微信请求切换对话 [${peerId}]：共 ${sessions.length} 个`);
    return fmtSessionList(peerId, sessions, resolveSession());
  } catch (e) {
    log('获取会话清单失败:', e.message);
    return '（获取会话清单失败：' + (e.message ?? e) + '）';
  }
}

// 「指令」：回复当前可用的指令清单，单条发送。
// 微信 iLink 文本：单换行 \n 会被折叠成空格，只有双换行 \n\n（空行）才渲染换行，
// 因此每条指令之间用空行分隔（用户实测"可用指令："后换行正是双换行生效）。
function handleHelpCmd() {
  return [
    '📋 可用指令：',
    '🔀 切换对话｜切换会话 — 列出对话，发编号切换',
    '➕ 新对话｜新建对话 — 新建会话',
    '📊 状态｜当前状态 — 当前绑定会话状态',
    '📄 发文件 <文件名/路径> — 发送本地文件到微信',
    '⏹ 取消｜停｜停止 — 中断当前任务',
    '🔢 编号（1/2/一/二）— 切换选择 / DSH 交互选择',
    '⚡ 是/否 — 回复 DSH 的权限/确认请求',
    '❓ 指令｜帮助 — 显示本菜单',
    '直接发文字/语音 = 让 DSH 处理，回复自动同步到微信。',
  ].join('\n\n');
}

// 「状态」指令：查询当前绑定对话的状态与正在执行的任务
async function handleStatusCmd(peerId) {
  const sessionId = resolveSession();
  if (!sessionId) return '（还没有配置默认会话。请先发「切换对话」选择，或在配置页 http://127.0.0.1:3083 设置。）';
  try {
    const sessions = await buildSwitchList().catch(() => []);
    const cur = sessions.find((s) => s.sessionId === sessionId);
    const name = (cur?.title && cur.title.trim()) ? cur.title : sessionId;
    const info = await sessionBusyInfo(sessionId);
    if (info.busy) {
      const lines = [`⏳ 对话「${name}」正在执行任务：`];
      if (info.lastMessage) lines.push(`📝 最新阶段回复：\n${info.lastMessage.slice(0, 300)}`);
      if (info.lastCommand) lines.push(`🔧 正在执行的命令：\n${info.lastCommand.slice(0, 200)}`);
      return lines.join('\n');
    }
    return `✅ 对话「${name}」状态空闲`;
  } catch (e) {
    log('查询会话状态失败:', e.message);
    return '（查询会话状态失败：' + (e.message ?? e) + '）';
  }
}

async function applySwitchChoice(peerId, contextToken, n) {
  const pend = switchPending.get(peerId);
  switchPending.delete(peerId);
  if (!pend) return null;
  if (n === 0) return handleWorkspaceList(peerId); // 进入「选择工作区新建对话」流程
  const s = pend.sessions[n - 1];
  if (!s) return `编号 ${n} 不在清单里，请再发一次「切换对话」重新选择。`;
  setDefaultSession(s.sessionId);
  log(`微信切换对话 [${peerId}] → ${s.sessionId}`);
  const name = (s.title && s.title.trim()) ? s.title : s.sessionId;
  // 切换成功后回复「将要切换到的」目标会话的状态（空闲 / 正在执行的阶段回复 + 当前命令）
  if (contextToken) {
    try {
      const info = await sessionBusyInfo(s.sessionId);
      if (info.busy) {
        const lines = [`✅ 已切换到对话「${name}」，当前正在执行任务：`];
        if (info.lastMessage) lines.push(`📝 最新阶段回复：\n${info.lastMessage.slice(0, 300)}`);
        if (info.lastCommand) lines.push(`🔧 正在执行的命令：\n${info.lastCommand.slice(0, 200)}`);
        await sendTextWithRetry(peerId, contextToken, lines.join('\n'));
      } else {
        await sendTextWithRetry(peerId, contextToken, `✅ 已切换到对话「${name}」，状态空闲。`);
      }
      return ''; // 状态消息已含切换完成信息，不再回"继续聊吧"（空串不会被外层发送）
    } catch (e) {
      log('查询目标会话状态失败:', e.message);
    }
  }
  return `✅ 已切换到对话「${name}」，继续聊吧。`;
}

// ---- 微信命令：选择工作区并新建会话 ----
async function listWorkspaces() {
  const v = await dshRpc('workspace.list', {}, 15_000);
  const items = v.items ?? [];
  return items.map((w) => ({
    workspaceId: w.workspaceId,
    title: (w.title && w.title.trim()) ? w.title : w.path,
    path: w.path,
  }));
}

function fmtWorkspaceList(workspaces) {
  const lines = workspaces.map((w, i) => `${i + 1}. ${w.title}（${w.path}）`);
  return ['📁 选择要在哪个工作区开启新对话：', ...lines, '', '回复编号；回复「取消」放弃。'].join('\n');
}

async function handleWorkspaceList(peerId) {
  try {
    const workspaces = await listWorkspaces();
    if (!workspaces.length) return '（当前没有可用的工作区。）';
    switchPending.set(peerId, { kind: 'workspace', workspaces, expireAt: Date.now() + SWITCH_PENDING_TTL_MS });
    log(`微信选择新建工作区 [${peerId}]：共 ${workspaces.length} 个`);
    return fmtWorkspaceList(workspaces);
  } catch (e) {
    log('获取工作区清单失败:', e.message);
    return '（获取工作区清单失败：' + (e.message ?? e) + '）';
  }
}

async function applyWorkspaceChoice(peerId, n) {
  const pend = switchPending.get(peerId);
  switchPending.delete(peerId);
  if (!pend) return null;
  const w = pend.workspaces?.[n - 1];
  if (!w) return `编号 ${n} 不在清单里，请再发一次「新对话」或「切换对话」→ 0 重新选择工作区。`;
  try {
    // 传 workspaceId 创建，DSH 会自动建在对应工作区目录并归入该工作区
    const created = await dshRpc('session.create', { workspaceId: w.workspaceId }, 30_000);
    // 返回 { sessionId, agentPreset }；兼容返回裸字符串的旧版本
    const sessionId = created?.sessionId ?? created;
    setDefaultSession(sessionId);
    log(`微信新开对话 [${peerId}] 工作区「${w.title}」→ ${sessionId}`);
    return `✅ 已在工作区「${w.title}」新开对话窗口，继续聊吧。（新对话在收到第一条消息前不会出现在清单里）`;
  } catch (e) {
    log('新建会话失败:', e.message);
    return '（新建会话失败：' + (e.message ?? e) + '）';
  }
}

function setDefaultSession(sessionId) {
  config.defaultSessionId = sessionId;
  saveConfig();
}

// proto MessageItemType.VOICE = 3（内容类型）；语音转写文本在 voice_item.text
const ITEM_VOICE = 3;

async function sendText(peerId, contextToken, text) {
  const clientId = `openclaw-weixin-${Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0')}`;
  const base = {
    msg: {
      from_user_id: '', to_user_id: peerId, client_id: clientId,
      message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: { channel_version: '1.0.2' },
  };
  // 先带 context_token 发送（保持会话上下文）。实测：token 过期时返回 ret=-2，
  // 此时 fallback 改为不带 token 发送——不带 token 可正常送达（已实测），
  // 因此主动/定时推送与长任务收尾不再受 token 时效限制。
  if (contextToken) {
    const r1 = await wxPost('ilink/bot/sendmessage', { ...base, msg: { ...base.msg, context_token: contextToken } }, token);
    const c1 = r1 && (r1.errcode ?? r1.ret);
    if (typeof c1 !== 'number' || c1 === 0) return;
    log(`context_token 失效(ret=${c1})，改用无 token 发送`);
  }
  const r2 = await wxPost('ilink/bot/sendmessage', base, token);
  const c2 = r2 && (r2.errcode ?? r2.ret);
  if (typeof c2 === 'number' && c2 !== 0) {
    throw new Error(`iLink sendmessage ret=${c2} ${r2?.errmsg ?? ''}`.trim());
  }
}

// ---- 媒体（图片/文件/视频）接收并保存到当前工作区 ----
const MEDIA_TYPES = new Set([2, 4, 5]); // proto MessageItemType: IMAGE=2 FILE=4 VIDEO=5
const MEDIA_KIND = { 2: '图片', 4: '文件', 5: '视频' };

function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`aes_key 无法解析 (len=${decoded.length})`);
}

function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------------- 发送文件/图片到微信（iLink 媒体上传+发送）----------------
// 链路：AES-128-ECB 加密文件 → getuploadurl 申请上传凭证 → 加密内容上传到微信 CDN →
//       sendmessage 携带媒体项（图片 type:2 / 文件 type:4）。
// 参考 weixinProxy（AndySkaura/weixinProxy，iLink 协议）的发送实现。
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const MEDIA_SEND_IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MEDIA_SEND_DOCS = new Set(['.csv', '.xlsx', '.xls', '.txt', '.md', '.pdf', '.json', '.zip', '.yaml', '.yml', '.html', '.htm', '.xml']);
const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 单个文件上限 20MB

function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
function md5Hex(buf) { return createHash('md5').update(buf).digest('hex'); }
function encodeOutboundAesKey(key) { return Buffer.from(key.toString('hex'), 'utf8').toString('base64'); }

// 发送一个本地文件/图片到微信；成功返回 true，失败抛错（调用方决定是否吞掉）
async function sendMediaFile(peerId, contextToken, filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`不是有效文件: ${filePath}`);
  if (stat.size > MAX_MEDIA_BYTES) throw new Error(`文件过大(${Math.round(stat.size / 1024 / 1024)}MB>20MB): ${filePath}`);
  const plaintext = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const kind = MEDIA_SEND_IMAGES.has(ext) ? 'image' : 'file';
  const mediaType = kind === 'image' ? 1 : 3; // 上传类型：image=1 file=3
  const aesKey = randomBytes(16);
  const ciphertext = encryptAesEcb(plaintext, aesKey);
  const filekey = randomBytes(16).toString('hex');
  const resp = await wxPost('ilink/bot/getuploadurl', {
    filekey,
    media_type: mediaType,
    to_user_id: peerId,
    rawsize: plaintext.length,
    rawfilemd5: md5Hex(plaintext),
    filesize: ciphertext.length,
    no_need_thumb: true,
    aeskey: aesKey.toString('hex'),
    base_info: { channel_version: '1.0.2' },
  }, token);
  const r = Number(resp?.ret ?? 0); // 成功时响应通常无 ret 字段（只有 upload_param），缺失视为 0
  if (r !== 0 || (!resp.upload_param && !resp.upload_full_url)) {
    throw new Error(`getuploadurl ret=${resp?.ret} ${resp?.errmsg ?? ''}`.trim());
  }
  const upUrl = resp.upload_full_url
    || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(resp.upload_param)}&filekey=${filekey}`;
  const upRes = await fetch(upUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: ciphertext,
    signal: AbortSignal.timeout(30_000),
  });
  if (!upRes.ok) throw new Error(`CDN 上传失败: HTTP ${upRes.status}`);
  const encryptedParam = upRes.headers.get('x-encrypted-param');
  if (!encryptedParam) throw new Error('CDN 上传未返回 x-encrypted-param');
  const media = { encrypt_query_param: encryptedParam, aes_key: encodeOutboundAesKey(aesKey), encrypt_type: 1 };
  let item;
  if (kind === 'image') {
    item = { type: 2, image_item: { media, aeskey: aesKey.toString('hex'), mid_size: ciphertext.length, hd_size: ciphertext.length } };
  } else {
    item = { type: 4, file_item: { media, file_name: path.basename(filePath), md5: md5Hex(plaintext), len: String(plaintext.length) } };
  }
  const clientId = `openclaw-weixin-${Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0')}`;
  const smBase = {
    msg: {
      from_user_id: '', to_user_id: peerId, client_id: clientId,
      message_type: 2, message_state: 2,
      item_list: [item],
    },
    base_info: { channel_version: '1.0.2' },
  };
  // 与 sendText 一致：带 context_token 失败（token 过期 ret=-2）时 fallback 不带 token 发送
  if (contextToken) {
    const r1 = await wxPost('ilink/bot/sendmessage', { ...smBase, msg: { ...smBase.msg, context_token: contextToken } }, token);
    const c1 = r1 && (r1.errcode ?? r1.ret);
    if (typeof c1 === 'number' && c1 !== 0) log(`媒体 context_token 失效(ret=${c1})，改用无 token 发送`);
    else { log(`媒体已发送 [${peerId}]: ${kind} ${path.basename(filePath)} (${Math.round(plaintext.length / 1024)}KB)`); return true; }
  }
  const r2 = await wxPost('ilink/bot/sendmessage', smBase, token);
  const c2 = r2 && (r2.errcode ?? r2.ret);
  if (typeof c2 === 'number' && c2 !== 0) {
    throw new Error(`iLink sendmessage ret=${c2} ${r2?.errmsg ?? ''}`.trim());
  }
  log(`媒体已发送 [${peerId}]: ${kind} ${path.basename(filePath)} (${Math.round(plaintext.length / 1024)}KB)`);
  return true;
}

// 从回复文本中提取"本地存在的产出文件路径"（存在性过滤，去重，最多 5 个）
const FILE_HINT_RE = /([^\s"'`\u3002\uFF0C\uFF1B\uFF1A:;,，；：、()（）【】]+\.(?:png|jpe?g|gif|webp|bmp|csv|xlsx?|txt|md|pdf|json|zip|ya?ml|html?|xml))/gi;
function extractFilePaths(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  for (const m of String(text).matchAll(FILE_HINT_RE)) {
    let p = m[1].trim().replace(/^[（(\[]+|[）)\]]+$/g, '');
    if (!p || seen.has(p)) continue;
    try {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
    } catch { continue; }
    if (/node_modules|\/\.git\/|logs[\\/]|\.DS_Store/.test(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= 5) break;
  }
  return out;
}

// 「发文件」输入解析：1) 直接路径存在则用之；2) 否则在候选工作目录（绑定会话 cwd + 桥接 cwd）里
// 按文件名精确匹配；3) 仍找不到则按包含匹配；唯一命中才返回，否则返回 null（避免发错文件）。
async function candidateDirs() {
  const dirs = new Set([process.cwd()]);
  const sessionId = resolveSession();
  if (sessionId) {
    try {
      const { items } = await dshRpc('session.list', {}, 15_000);
      const s = (items ?? []).find((x) => x.sessionId === sessionId);
      if (s?.cwd && fs.existsSync(s.cwd)) dirs.add(s.cwd);
    } catch {}
  }
  return [...dirs];
}
async function resolveFileToSend(input) {
  const t = String(input ?? '').trim();
  if (!t) return null;
  if (fs.existsSync(t) && fs.statSync(t).isFile()) return t;
  const dirs = await candidateDirs();
  const seen = new Set();
  const exact = [];
  for (const dir of dirs) {
    const cand = path.join(dir, t);
    if (seen.has(cand)) continue;
    seen.add(cand);
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) exact.push(cand);
  }
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // 多个同名：让用户给完整路径
  // 包含匹配（basename 含关键字）
  const kw = path.basename(t).toLowerCase();
  const fuzzy = [];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const full = path.join(dir, n);
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        if (fs.statSync(full).isFile() && n.toLowerCase().includes(kw)) fuzzy.push(full);
      } catch {}
    }
  }
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

// 推送文本后自动发送其中提到的"最后一个"文件（结果里可能多个路径，通常最后一个才是最终产出）；
// 需要其它文件用手动指令「发文件 <路径>」。10 分钟内不重复发同一文件。
const sentFileCache = new Map(); // filePath -> lastSentAt
async function sendReplyFiles(peerId, contextToken, text) {
  if (!peerId || !contextToken) return;
  const files = extractFilePaths(text);
  if (!files.length) return;
  const f = files[files.length - 1]; // 只发最后一个
  if (Date.now() - (sentFileCache.get(f) || 0) < 10 * 60 * 1000) return;
  try {
    await sendMediaFile(peerId, contextToken, f);
    sentFileCache.set(f, Date.now());
  } catch (e) {
    log('发送文件失败:', f, '|', e.message);
  }
}

function sanitizeFileName(name) {
  const s = String(name ?? '').replace(/[\x00-\x1f/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').trim();
  return s || null;
}

function sniffExt(buf) {
  if (!buf || buf.length < 4) return '.bin';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return '.mp4';
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return '.mp3';
  if (buf[0] === 0x23 && buf[1] === 0x21) return '.amr';
  return '.bin';
}

function extFor(type, buf) {
  const sniffed = sniffExt(buf);
  if (sniffed !== '.bin') return sniffed;
  if (type === 5) return '.mp4';
  if (type === 2) return '.img';
  return '.bin';
}

async function sessionCwdOf(sessionId) {
  if (!sessionId) return null;
  try {
    const { items } = await dshRpc('session.list', {}, 15_000);
    const s = items.find((x) => x.sessionId === sessionId);
    return s?.cwd ?? null;
  } catch { return null; }
}

async function handleMediaMessage(peerId, contextToken, msg, first) {
  const type = first.type;
  if (!MEDIA_TYPES.has(type)) return false;

  // 目标目录：当前默认会话的工作目录
  const sessionId = resolveSession();
  const cwd = await sessionCwdOf(sessionId);
  if (!cwd) {
    await sendText(peerId, contextToken, '（收到媒体消息，但还没有默认会话，不知道保存到哪个工作区；请发「切换会话」选择或到配置页设置。）');
    return true;
  }

  const media = first.image_item?.media ?? first.file_item?.media ?? first.video_item?.media ?? null;
  if (!media?.full_url) {
    await sendText(peerId, contextToken, '（收到媒体消息，但缺少下载地址，无法保存。）');
    return true;
  }

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dir = path.join(cwd, 'wechat-media', day);
  try {
    await fs.promises.mkdir(dir, { recursive: true });

    const res = await fetch(media.full_url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`CDN 下载 ${res.status} ${media.full_url.slice(0, 80)}`);
    const encrypted = Buffer.from(await res.arrayBuffer());

    // ImageItem.aeskey 为 16 字节 hex；media.aes_key 为 base64（16 原始字节 或 base64(32位hex)）
    const aeskeyHex = first.image_item?.aeskey ?? null;
    const key = aeskeyHex ? Buffer.from(aeskeyHex, 'hex') : parseAesKey(media.aes_key ?? '');
    const plain = decryptAesEcb(encrypted, key);

    let base = type === 4 ? sanitizeFileName(first.file_item?.file_name) : null;
    if (!base) base = `media-${msg.seq ?? msg.message_id ?? Date.now()}-${Date.now()}` + extFor(type, plain);
    const savePath = path.join(dir, base);
    await fs.promises.writeFile(savePath, plain);
    log(`微信媒体保存 [${peerId}] type=${type} → ${savePath} (${plain.length} B)`);
    await sendText(peerId, contextToken, `📥 已收到${MEDIA_KIND[type] ?? '媒体'}，已保存到工作区：\n${savePath}`);
    return true;
  } catch (e) {
    errorCount++;
    log('媒体保存失败:', e.message);
    await sendText(peerId, contextToken, '（媒体保存失败：' + (e.message ?? e) + '）');
    return true;
  }
}

async function handleMessage(msg) {
  // message_type: 1=用户消息 2=机器人消息（proto MessageType）
  if (msg.message_type !== 1) return;
  const peerId = msg.from_user_id;
  const contextToken = msg.context_token;
  if (!peerId) return;
  // 记录发送凭证与最近联系人：供“绑定会话回复同步”推送使用（并持久化，重启不丢）
  if (contextToken) {
    peerTokens.set(peerId, contextToken);
    lastActivePeer = peerId;
    saveState();
    await flushPendingReplies(peerId, contextToken); // 凭证已刷新：补发之前发送失败的回复
  }

  // 提取文字：文本消息直接取 text_item.text；
  // 语音消息（item.type=3）取平台自带的转写文本 voice_item.text（官方同款逻辑，无需额外识别引擎）
  const first = msg.item_list?.[0] ?? {};
  let text = first.text_item?.text ?? '';
  let voiceFlag = false;
  if (!text && first.type === ITEM_VOICE) {
    const vt = first.voice_item?.text ?? '';
    if (vt) { text = vt; voiceFlag = true; }
  }
  const t = String(text).trim();
  if (!t) {
    // 图片/文件/视频：下载、解密并保存到当前工作区；其余类型明确提示，不再“没反应”
    lastMessageAt = Date.now();
    handledCount++;
    if (await handleMediaMessage(peerId, contextToken, msg, first)) return;
    log(`收到无法转写的消息 [${peerId}]: item_type=${first.type} keys=${Object.keys(first).join(',')}`);
    try {
      await sendText(peerId, contextToken, '（收到无法解析的消息类型；支持：文字、带平台转写的语音，以及图片/文件/视频的自动保存。）');
    } catch (e) { log('发送提示失败:', e.message); }
    return;
  }
  const idleGap = Date.now() - lastMessageAt;
  lastMessageAt = Date.now();
  handledCount++;
  log(`收到消息 [${peerId}]: ${voiceFlag ? '🎙️(语音转文字) ' : ''}${t}`);

  if (!typingTickets.has(peerId)) {
    try {
      const cfg = await wxPost('ilink/bot/getconfig',
        { ilink_user_id: peerId, context_token: contextToken, base_info: { channel_version: '1.0.2' } }, token);
      typingTickets.set(peerId, cfg.typing_ticket ?? '');
    } catch {}
  }
  const ticket = typingTickets.get(peerId) ?? '';
  if (ticket) await wxPost('ilink/bot/sendtyping',
    { ilink_user_id: peerId, typing_ticket: ticket, status: 1 }, token).catch(() => {});

  // 「取消」：优先停止当前正在执行的任务（不进正常对话流程）
  if (CANCEL_WORDS.includes(stripPunct(t))) {
    const target = resolveSession();
    const run = target ? activeRuns.get(target) : undefined;
    if (run) {
      run.cancelled = true; // 先停掉本地的等待轮询
      try { await dshRpc('session.cancel', { sessionId: target }, 10_000); }
      catch (e) { log('DSH 取消执行失败:', e.message); }
      log(`微信取消执行 [${peerId}]：会话 ${target} 的进行中任务`);
      try { await sendTextWithRetry(peerId, contextToken, '⏹ 已取消当前对话的执行。'); }
      catch (e) { log('取消回执发送失败:', e.message); }
      if (ticket) await wxPost('ilink/bot/sendtyping',
        { ilink_user_id: peerId, typing_ticket: ticket, status: 2 }, token).catch(() => {});
      return;
    }
    // 没有正在执行的任务：继续往下走（待选状态里的「取消」/ 兜底提示）
  }

  // ---- DSH 交互选择：微信回复序号 → 把对应选项内容注入 DSH 会话（queue）----
  const boundSid = resolveSession();
  const isChoiceInput = /^\d{1,2}$/.test(t.trim()) || /^[一二两三四五六七八九十]{1,2}$/.test(t.trim());
  if (boundSid && isChoiceInput) {
    const pend = pendingInteraction.get(boundSid);
    if (pend && Date.now() - pend.at < INTERACT_FRESH_MS) {
      const n = parseChoiceNum(t);
      if (n >= 1 && n <= pend.options.length) {
        const picked = pend.options[n - 1];
        pendingInteraction.delete(boundSid);
        log(`微信选择交互 [${peerId}]: 会话 ${boundSid.slice(0, 12)} 编号 ${n} → ${picked}`);
        try {
          await dshRpc('session.prompt', {
            sessionId: boundSid, mode: 'queue', content: [{ type: 'text', text: `用户选择：${picked}` }],
          }, 15_000);
          await sendTextWithRetry(peerId, contextToken, `✅ 已把你的选择「${picked}」发送给 DSH。`);
        } catch (e) {
          log('注入用户选择失败:', e.message);
          await sendTextWithRetry(peerId, contextToken, '（把选择发送给 DSH 失败：' + (e.message ?? e) + '）');
        }
        return;
      }
      // 数字超出选项范围：保留待回答状态，按普通消息继续（可改发文字或重新选号）
    }
  }

  // ---- DSH 权限/确认请求：微信回复「是/否」→ 注入用户决策给 DSH ----
  if (boundSid) {
    const pend = pendingInteraction.get(boundSid);
    if (pend && pend.type === 'yesno' && Date.now() - pend.at < INTERACT_FRESH_MS) {
      const k = stripPunct(t).toLowerCase();
      const YES = ['是', '是的', '可以', '同意', 'ok', '好', '行', '确定', '允许', '批准', '对'];
      const NO = ['否', '不', '不行', '不要', '拒绝', '不同意', '取消', 'no', '不对'];
      if (YES.includes(k)) {
        pendingInteraction.delete(boundSid);
        log(`微信确认 [${peerId}]: 是`);
        try {
          await dshRpc('session.prompt', {
            sessionId: boundSid, mode: 'queue', content: [{ type: 'text', text: '用户确认：是' }],
          }, 15_000);
          await sendTextWithRetry(peerId, contextToken, '✅ 已把你的确认「是」发送给 DSH。');
        } catch (e) {
          log('注入用户确认失败:', e.message);
          await sendTextWithRetry(peerId, contextToken, '（把确认发送给 DSH 失败：' + (e.message ?? e) + '）');
        }
        return;
      }
      if (NO.includes(k)) {
        pendingInteraction.delete(boundSid);
        log(`微信确认 [${peerId}]: 否`);
        try {
          await dshRpc('session.prompt', {
            sessionId: boundSid, mode: 'queue', content: [{ type: 'text', text: '用户确认：否' }],
          }, 15_000);
          await sendTextWithRetry(peerId, contextToken, '✅ 已把你的确认「否」发送给 DSH。');
        } catch (e) {
          log('注入用户确认失败:', e.message);
          await sendTextWithRetry(peerId, contextToken, '（把确认发送给 DSH 失败：' + (e.message ?? e) + '）');
        }
        return;
      }
    }
  }

  // ---- 微信命令：切换对话 / 新对话 / 编号选择（不触碰 DSH 代码）----
  let reply = null;
  if (isCmd(t, SWITCH_CMD, SWITCH_ALIASES)) {
    reply = await handleSwitchCmd(peerId);
  } else if (isCmd(t, NEW_CMD, NEW_ALIASES)) {
    reply = await handleWorkspaceList(peerId); // 直接进入工作区选择并新开对话
  } else if (isCmd(t, STATUS_CMD, STATUS_ALIASES)) {
    reply = await handleStatusCmd(peerId);
  } else if (isCmd(t, HELP_CMD, HELP_ALIASES)) {
    reply = handleHelpCmd();
  } else if (/^(发文件|发送文件|发图片|发送图片)/.test(t.trim())) {
    // 手动发送指定文件/图片到微信
    const rest = t.replace(/^(发文件|发送文件|发图片|发送图片)/, '').trim().replace(/[。！？!?,.，；;]+$/g, '');
    if (rest) {
      try {
        const fp = await resolveFileToSend(rest);
        if (!fp) {
          reply = `（在当前工作目录未找到「${rest}」，请用完整路径：发文件 /完整/路径/文件）`;
        } else {
          await sendMediaFile(peerId, contextToken, fp);
          reply = '';
        }
      } catch (e) { reply = `（发送文件失败：${e.message}）`; }
    } else {
      reply = '（用法：发文件 <文件名或路径>，如：发文件 每日分析.csv）';
    }
  } else {
    const pend = switchPending.get(peerId);
    if (pend && Date.now() < pend.expireAt) {
      const n = parseChoiceNum(t);
      if (n >= 0) {
        reply = pend.kind === 'workspace'
          ? await applyWorkspaceChoice(peerId, n)
          : await applySwitchChoice(peerId, contextToken, n);
      } else if (CANCEL_WORDS.includes(stripPunct(t))) {
        switchPending.delete(peerId);
        reply = '已取消，继续当前对话。';
      } else {
        switchPending.delete(peerId); // 发来普通消息，退出切换模式
      }
    }
  }

  const sessionId = resolveSession();
  if (reply === null) {
    if (!sessionId) {
      reply = '（还没有配置默认会话。请在配置页 http://127.0.0.1:3083 设置，或发送「切换对话」选择，或发「新对话」新建。）';
    } else if (CANCEL_WORDS.includes(stripPunct(t))) {
      // 没有正在执行的任务：“取消”不进对话，给个说明
      reply = '（当前没有正在执行的任务，无需取消；发「取消」只在任务执行中生效。）';
    } else {
      // 回执：已收到，开始处理；超过 2 小时未发言时附带当前工作区/会话名
      try {
        await sendTextWithRetry(peerId, contextToken, await ackText(sessionId, idleGap >= IDLE_CONTEXT_MS));
      } catch (e) { log('回执发送失败:', e.message); }
      const run = { cancelled: false };
      activeRuns.set(sessionId, run);
      const deliveredRef = { current: '' };
      const sentRef = { at: Date.now() }; // 微信渠道最近一次发消息时间（回执刚发过）
      const startAt = Date.now(); // 本条消息的接收时间：状态提示显示从这一刻起的总等待秒数
      try {
        // 阶段回复 onStage：DSH 每步定稿文本一出现就立即发微信，不等最终结果；
        // 发送失败会抛错（不推进 deliveredText，最终回复会补发该内容，不丢失）
        reply = await promptWithStatus(peerId, contextToken, sessionId, t, () => run.cancelled,
          async (txt) => {
            // 先发送成功，再记录日志（失败抛错→deliveredText 不推进→最终回复补发，日志不产生误导）
            await sendTextWithRetry(peerId, contextToken, txt);
            sentRef.at = Date.now(); // 每次发给微信后重置 30 秒状态计时
            log(`阶段回复已发送 [${peerId}]: ${txt.slice(0, 40)}${txt.length > 40 ? '…' : ''}`);
            void sendReplyFiles(peerId, contextToken, txt); // 自动发送回复中提到的文件/图片
          },
          deliveredRef, sentRef, startAt);
        if (reply && reply === deliveredRef.current) reply = ''; // 最终文本已随阶段回复发出，避免重复
      } catch (e) {
        errorCount++;
        log('DSH 调用失败:', e.message);
        reply = e.dshDown
          ? '（DSH 服务似乎已停止或报错，已停止等待。原错误：' + (e.message ?? e) + '。如 DSH 已恢复请重发。）'
          : '（DSH 调用失败：' + (e.message ?? e) + '）';
      } finally {
        if (activeRuns.get(sessionId) === run) activeRuns.delete(sessionId);
      }
    }
  }

  if (reply) {
    try {
      await sendTextWithRetry(peerId, contextToken, reply);
    } catch (e) {
      errorCount++;
      log('发送消息失败:', e.message);
      enqueuePendingReply(peerId, reply); // 最终回复发送失败：暂存，等下次发消息后补发
    }
    log(`已回复 [${peerId}]: ${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}`);
  } else {
    log(`本轮无最终回复（已取消或已随阶段回复发出）[${peerId}]`);
  }

  if (ticket) await wxPost('ilink/bot/sendtyping',
    { ilink_user_id: peerId, typing_ticket: ticket, status: 2 }, token).catch(() => {});
}

// 监听绑定会话里“非微信发起”的回复：DSH 网页端发起的对话，其回复也同步推送到微信。
// 与 promptAndCollect 共用会话级 seq 游标（sessionRelay），并由 engagedSessions 闸门避让，
// 保证任何一条回复只推送到微信一次。
async function watchForeignReplies() {
  while (true) {
    if (shuttingDown) return;
    await sleep(POLL_MS);
    const sessionId = config.defaultSessionId;
    if (!sessionId) continue;
    // 微信发起的任务正在处理该会话时让路，避免与轮询重复发送
    if (engagedSessions.has(sessionId)) continue;
    const st = relayCursor(sessionId);
    // 首次关注该会话：起点设为当前最新 seq，不推送旧历史。
    // 注意：初始化失败必须保持“未初始化”（下轮重试），否则游标为 0 会把
    // 窗口内全部历史阶段回复误推一遍。
    if (!st.initialized) {
      try {
        const h = await dshRpc('session.history', { sessionId, maxMessages: 10 });
        st.lastSeq = Math.max(0, ...(h?.events ?? []).map((e) => Number(e?.event?.seq ?? 0)));
        st.initialized = true;
        st.taskStartAt = Date.now(); // 任务起点近似=关注时刻（30 秒状态的累计秒数基准）
      } catch { continue; }
      continue;
    }
    let events;
    try {
      ({ events } = await dshRpc('session.history', { sessionId, maxMessages: HISTORY_WINDOW }));
    } catch { continue; }
    let cursor = st.lastSeq;
    for (const { event } of events ?? []) {
      const seq = Number(event?.seq ?? 0);
      if (seq <= cursor) continue;
      // 网页端又发了新消息 = 新任务起点（30 秒状态的累计等待秒数从此刻起算）
      if (event.type === 'user/message') {
        const t = new Date(event?.time ?? 0).getTime();
        if (t) st.taskStartAt = t;
      }
      if (event.type === 'assistant/message') {
        const txt = extractText(event.data?.message?.content);
        if (txt && txt !== st.lastText) {
          st.lastText = txt; // 始终记录最新文本（节流跳过时也更新）
          // 推送节流：距上次推送 <60s 则跳过（避免高频触发 iLink 风控）；
          // turn/end 时会把最新未推文本补推（最终必达），故中间被节流的不会丢最终。
          const throttled = st.lastPushAt !== 0 && Date.now() - st.lastPushAt < PUSH_THROTTLE_MS;
          if (!throttled && txt !== st.lastSent) {
            const pushed = await syncPush(txt, st);
            if (pushed) { st.lastSent = txt; st.lastPushAt = Date.now(); }
            // 发送失败：文本已入队待补发（syncPush 内部 enqueue），游标继续推进
          }
          cursor = seq;
          noteAssistantText(sessionId, txt); // 检测"编号选项提问"→记录待回答状态
          maybeNotifyConfirm(sessionId); // 权限/确认类请求 → 微信推「是/否」提示
          // 自动发送回复中提到的本地文件/图片（不阻塞文本推送）
          void sendReplyFiles(lastActivePeer, lastActivePeer ? peerTokens.get(lastActivePeer) : null, txt);
        }
      } else if (event.type === 'turn/end') {
        // 最终必达：turn 结束，把最新未推的文本补推（即使之前被节流/失败跳过）
        if (st.lastText && st.lastText !== st.lastSent) {
          const pushed = await syncPush(st.lastText, st);
          if (pushed) { st.lastSent = st.lastText; st.lastPushAt = Date.now(); }
        }
        const notice = relayReasonText(event.data?.reason ?? null);
        if (notice && notice !== st.lastSent) {
          if (await syncPush(notice, st)) st.lastSent = notice;
        }
        cursor = seq;
      }
      cursor = Math.max(cursor, seq);
    }
    st.lastSeq = cursor;
    // ---- 30 秒无推送时的“正在处理中”提示（网页端发起任务的累计等待秒数）----
    // 触发条件：距上次成功推送/状态 ≥30 秒，且会话仍有活跃输出（最近事件 <90 秒，避免空闲时打扰）
    const lastEvt = events[events.length - 1]?.event;
    if (lastEvt) { const lt = new Date(lastEvt?.time ?? 0).getTime(); if (lt) st.lastEventAt = lt; }
    // 只有任务确实在执行中、且该会话已有实质回复（st.lastText 非空）才发状态：
    // 1) 修复“任务已结束但事件很新”导致的空闲误发；2) 修复“DSH 空消息自动续跑 turn”
    // 无实质输出时不该发“正在处理中”（避免切换后莫名收到状态）。
    const { busy: taskBusy } = busyFromEvents(events ?? []);
    if (taskBusy && st.lastText && st.taskStartAt && !st.lastFailAt
        && Date.now() - (st.lastSentAt ?? 0) >= WX_STATUS_INTERVAL_MS) {
      const peerId = lastActivePeer;
      const ctx = peerId ? peerTokens.get(peerId) : null;
      if (peerId && ctx) {
        const waited = Math.round((Date.now() - st.taskStartAt) / 1000);
        try {
          await sendTextWithRetry(peerId, ctx, `⏳ 正在处理中，请稍候…（已等待 ${waited} 秒）`);
          st.lastSentAt = Date.now(); // 状态本身也算一次发送
          log(`同步状态提醒已发送 [${peerId}]: ⏳ 已等待 ${waited} 秒`);
        } catch { /* 发送失败静默，等下一窗口重试 */ }
      }
    }
  }
}

// 同步推送一条文本到微信；返回 true=发送成功（游标可推进），false=失败/冷却中（下轮重试）。
// 失败后 30 秒内不再重试，日志最多每 30 秒一次，避免刷屏。
// 失败后重试冷却：曾用 30 秒，但高频失败重试会向 iLink 持续打请求（曾累计 239 次失败），
// 反而加重发送风控（prepare failed）并刷屏日志。改为 5 分钟一次低频重试，帮助风控恢复；
// 不丢消息：失败文本已入待补发队列，凭证/风控恢复后自动补发。
const SYNC_RETRY_MS = 5 * 60 * 1000;
// 同步推送节流：网页端任务阶段回复每 30 秒最多推 1 条（避免高频触发 iLink 风控，节奏更及时）；
// turn/end 时最新未推文本会补推（最终必达），中间被节流的不会丢最终。
const PUSH_THROTTLE_MS = 30_000;
async function syncPush(text, st) {
  if (st.lastFailAt && Date.now() - st.lastFailAt < SYNC_RETRY_MS) return false; // 冷却中
  const peerId = lastActivePeer;
  const ctx = peerId ? peerTokens.get(peerId) : null;
  if (!peerId || !ctx) {
    // 尚无发送凭证：等用户发一条微信消息后自动就绪（凭证已持久化，重启不丢）
    if (!st.lastLoggedAt || Date.now() - st.lastLoggedAt >= SYNC_RETRY_MS)
      log('同步推送待发送：尚无微信发送凭证（请先在微信发一条消息）:', text.slice(0, 30));
    st.lastLoggedAt = Date.now();
    st.lastFailAt = Date.now();
    return false;
  }
  try {
    await sendTextWithRetry(peerId, ctx, text);
    st.lastFailAt = 0;
    st.lastLoggedAt = 0;
    st.lastSentAt = Date.now(); // 同步推送成功也算一次“发送”，重置 30 秒计时
    log(`同步推送已发送 [${peerId}]: ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`);
    return true;
  } catch (e) {
    enqueuePendingReply(peerId, text); // 发送失败：暂存，等下次发消息刷新凭证后补发
    if (!st.lastLoggedAt || Date.now() - st.lastLoggedAt >= SYNC_RETRY_MS)
      log('同步推送失败（将自动重试+待补发）:', e.message, '|', text.slice(0, 30));
    st.lastLoggedAt = Date.now();
    st.lastFailAt = Date.now();
    return false;
  }
}

async function botLoop() {
  while (true) {
    if (!token) { await sleep(1200); continue; }
    let resp;
    try {
      resp = await wxPost('ilink/bot/getupdates',
        { get_updates_buf: updatesBuf, base_info: { channel_version: '1.0.2' } }, token);
    } catch (e) {
      errorCount++;
      log('getupdates 网络错误:', e.message);
      await sleep(3000);
      continue;
    }
    lastPollAt = Date.now();
    if (resp.errcode === -14) {
      log('微信登录过期，已自动解绑，请重新扫码绑定');
      token = null;
      boundAt = null;
      config.wechat = {};
      saveConfig();
      continue;
    }
    updatesBuf = resp.get_updates_buf ?? updatesBuf;
    // 并发处理消息：不能阻塞在这里等回复，否则「取消」消息永远没机会被处理
    for (const msg of resp.msgs ?? []) {
      handleMessage(msg).catch((e) => { errorCount++; log('处理消息出错:', e.message); });
    }
  }
}

// ---------------- HTTP 服务 ----------------
function json(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  });
  res.end(JSON.stringify(obj));
}

function statusPayload() {
  return {
    ok: true,
    now: Date.now(),
    dshUrl: config.dsh.url,
    bot: {
      state: binding ? 'binding' : token ? 'bound' : 'unbound',
      hasToken: !!token,
      boundAt,
      qrcode: binding?.qrcode ?? null,
      bindMessage: binding?.message ?? null,
      lastPollAt,
      lastMessageAt,
      handled: handledCount,
      errors: errorCount,
    },
    control: {
      uptimeMs: Date.now() - startTime,
      port: PORT,
    },
    config: {
      defaultSessionId: config.defaultSessionId ?? null,
    },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'content-type' });
    return res.end();
  }

  if (req.method === 'GET' && pathname === '/') {
    let html;
    try {
      html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    } catch (e) {
      return json(res, 500, { error: 'index.html 缺失: ' + e.message });
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    const dsh = await dshStatus();
    return json(res, 200, { ...statusPayload(), dsh });
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    try {
      return json(res, 200, { ok: true, items: await listSessions() });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, items: [] });
    }
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return json(res, 200, { ok: true, defaultSessionId: config.defaultSessionId ?? null });
  }

  if (req.method === 'POST' && pathname === '/api/bind') {
    return json(res, 200, await startBind());
  }
  if (req.method === 'POST' && pathname === '/api/unbind') {
    return json(res, 200, doUnbind());
  }

  if (req.method === 'POST' && pathname === '/api/config') {
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    if ('defaultSessionId' in body) {
      config.defaultSessionId = body.defaultSessionId ? String(body.defaultSessionId) : null;
      saveConfig();
      log('默认会话设为:', config.defaultSessionId ?? '无');
      return json(res, 200, { ok: true, defaultSessionId: config.defaultSessionId });
    }
    return json(res, 400, { error: '未知配置项' });
  }

  if (req.method === 'GET' && pathname === '/api/logs') {
    const since = Number(url.searchParams.get('since') ?? 0);
    return json(res, 200, { ok: true, logs: ring.filter((l) => l.t > since) });
  }

  // POST /api/send  { text: '...', peerId?: 'o9cq...' }
  // 主动给微信发一条文本消息（外部系统触发；默认发给最近联系人，可指定 peerId）。
  // 注意：发送凭证 context_token 有效约 90-160 秒且仅在有新消息时刷新——若长时间没收到微信消息，
  // 发送会失败并进入待补发队列（enqueued:true），你下次发微信消息后自动补发。
  if (req.method === 'POST' && pathname === '/api/send') {
    let body = {};
    try { body = await readJson(req); } catch {}
    const text = String(body.text ?? body.message ?? '').trim();
    const peerId = body.peerId || lastActivePeer;
    if (!text) return json(res, 200, { ok: false, error: '缺少 text 字段' });
    if (!peerId || !peerTokens.get(peerId)) {
      return json(res, 200, { ok: false, error: '尚无微信发送凭证（请先在微信发一条消息）' });
    }
    try {
      await sendTextWithRetry(peerId, peerTokens.get(peerId), text, 2);
      log(`API 主动发送 [${peerId}]: ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`);
      return json(res, 200, { ok: true, sent: text });
    } catch (e) {
      enqueuePendingReply(peerId, text); // 凭证过期等失败：暂存，等下次发消息补发
      return json(res, 200, { ok: false, error: e.message, enqueued: true });
    }
  }

  // POST /api/send-file  { path: '文件路径或文件名', peerId?: 'o9cq...' }
  // 主动把本地文件/图片发到微信（外部系统触发）；path 支持工作目录搜索（同「发文件」指令）。
  // 凭证过期时会直接返回错误（文件不进待补发队列），需用户发条微信消息刷新凭证后重试。
  if (req.method === 'POST' && pathname === '/api/send-file') {
    let body = {};
    try { body = await readJson(req); } catch {}
    const filePath = String(body.path ?? body.file ?? '').trim();
    const peerId = body.peerId || lastActivePeer;
    if (!filePath) return json(res, 200, { ok: false, error: '缺少 path 字段' });
    if (!peerId || !peerTokens.get(peerId)) {
      return json(res, 200, { ok: false, error: '尚无微信发送凭证（请先在微信发一条消息）' });
    }
    try {
      const fp = await resolveFileToSend(filePath);
      if (!fp) return json(res, 200, { ok: false, error: `未找到文件「${filePath}」（可用完整路径或工作目录内文件名）` });
      await sendMediaFile(peerId, peerTokens.get(peerId), fp);
      log(`API 发送文件 [${peerId}]: ${fp}`);
      return json(res, 200, { ok: true, sent: fp });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  return json(res, 404, { error: 'not found' });
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

server.listen(PORT, HOST, () => {
  log(`控制服务已启动: http://${HOST}:${PORT}`);
  log(`DSH: ${config.dsh.url}  |  微信已绑定: ${!!token}`);
  botLoop();              // 后台跑微信长轮询
  watchForeignReplies();  // 后台监听绑定会话（网页端发起的对话）回复并同步推送微信
});
