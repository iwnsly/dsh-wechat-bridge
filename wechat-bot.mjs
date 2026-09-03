// wechat-bot.mjs
// 基于微信官方 ClawBot 的 iLink 后端 API（ilinkai.weixin.qq.com）实现的个人微信 Bot。
// 免部署 OpenClaw：扫码登录拿到 bot_token 后，长轮询收消息，调用 AI 接口回消息。
// AI 接口默认指向本机的 dsh-bridge.mjs（Anthropic 兼容 /v1/messages）。
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TOKEN_FILE = process.env.BOT_TOKEN_FILE ?? 'bot_token.txt';
const BRIDGE_URL = (process.env.BRIDGE_URL ?? 'http://127.0.0.1:3081').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL ?? 'dsh';
const AI_API_KEY = process.env.AI_API_KEY ?? 'dsh';
const AI_PROMPT = process.env.AI_PROMPT ?? '你是一个有帮助的AI助手，请用中文简洁地回复。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), '[wechat-bot]', ...a);

function makeHeaders(token) {
  const uin = BigInt(Math.floor(Math.random() * 0xFFFFFFFF)).toString();
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(uin).toString('base64'),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function apiPost(path, body, token) {
  const res = await fetch(`${BASE_URL}/${path}`, {
    method: 'POST',
    headers: makeHeaders(token),
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---- 扫码登录，返回 bot_token ----
async function login() {
  const { qrcode, qrcode_img_content } = await fetch(
    `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`
  ).then((r) => r.json());

  let qrHint = '';
  if (qrcode_img_content) {
    const content = String(qrcode_img_content);
    if (content.startsWith('data:image/')) {
      const [header, b64] = content.split(',');
      const ext = header.match(/data:image\/(\w+)/)?.[1] ?? 'png';
      fs.writeFileSync(`qrcode.${ext}`, Buffer.from(b64, 'base64'));
      qrHint = `二维码已保存到 qrcode.${ext}`;
    } else if (content.startsWith('http')) {
      qrHint = '二维码地址: ' + content;
    } else if (content.startsWith('<svg')) {
      fs.writeFileSync('qrcode.svg', content);
      qrHint = '二维码已保存到 qrcode.svg（用浏览器打开）';
    } else {
      fs.writeFileSync('qrcode.png', Buffer.from(content, 'base64'));
      qrHint = '二维码已保存到 qrcode.png';
    }
  }
  log(qrHint);
  log('请用手机微信扫码，并在手机上确认连接授权……');

  while (true) {
    const status = await fetch(
      `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${qrcode}`
    ).then((r) => r.json());
    if (status.status === 'confirmed') {
      fs.writeFileSync(BOT_TOKEN_FILE, status.bot_token);
      log('登录成功！bot_token 已保存到 ' + BOT_TOKEN_FILE);
      return status.bot_token;
    }
    await sleep(1500);
  }
}

// ---- 调用 AI 接口（Anthropic 兼容）----
async function aiChat(message) {
  const res = await fetch(`${BRIDGE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': AI_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 2048,
      messages: [
        { role: 'user', content: AI_PROMPT },
        { role: 'user', content: message },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI 接口 HTTP ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data?.content)) {
    for (const block of data.content) {
      if (block?.type === 'text' && block.text) return block.text;
    }
  }
  throw new Error('AI 响应中没有文本内容');
}

// ---- 主循环 ----
async function main() {
  let botToken = '';
  try {
    botToken = fs.readFileSync(BOT_TOKEN_FILE, 'utf8').trim();
  } catch {}

  while (true) {
    if (!botToken) botToken = await login();
    if (!botToken) continue;

    const typingTicketCache = {};
    log('开始监听消息……');
    let getUpdatesBuf = '';

    while (true) {
      let resp;
      try {
        resp = await apiPost('ilink/bot/getupdates',
          { get_updates_buf: getUpdatesBuf, base_info: { channel_version: '1.0.2' } }, botToken);
      } catch (e) {
        log('getupdates 网络错误:', e?.message ?? e, '3s 后重试');
        await sleep(3000);
        continue;
      }

      if (resp.errcode === -14) {
        log('登录过期，重新登录……');
        botToken = '';
        try { fs.unlinkSync(BOT_TOKEN_FILE); } catch {}
        break;
      }
      getUpdatesBuf = resp.get_updates_buf ?? getUpdatesBuf;

      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== 1) continue; // 只处理用户消息
        const text = msg.item_list?.[0]?.text_item?.text;
        const fromId = msg.from_user_id;
        const contextToken = msg.context_token;
        if (!text || !fromId) continue;
        log(`收到消息 [${fromId}]: ${text}`);

        try {
          if (!typingTicketCache[fromId]) {
            const cfg = await apiPost('ilink/bot/getconfig', {
              ilink_user_id: fromId,
              context_token: contextToken,
              base_info: { channel_version: '1.0.2' },
            }, botToken);
            typingTicketCache[fromId] = cfg.typing_ticket ?? '';
          }
          const ticket = typingTicketCache[fromId];

          if (ticket) {
            await apiPost('ilink/bot/sendtyping', {
              ilink_user_id: fromId, typing_ticket: ticket, status: 1,
            }, botToken);
          }

          let reply;
          try {
            reply = await aiChat(text);
          } catch (e) {
            log('AI 调用失败:', e?.message ?? e);
            reply = '（AI 服务暂时不可用：' + (e?.message ?? e) + '）';
          }

          const clientId = `openclaw-weixin-${Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0')}`;
          await apiPost('ilink/bot/sendmessage', {
            msg: {
              from_user_id: '',
              to_user_id: fromId,
              client_id: clientId,
              message_type: 2,
              message_state: 2,
              context_token: contextToken,
              item_list: [{ type: 1, text_item: { text: reply } }],
            },
            base_info: { channel_version: '1.0.2' },
          }, botToken);
          log(`已回复 [${fromId}]: ${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}`);

          if (ticket) {
            await apiPost('ilink/bot/sendtyping', {
              ilink_user_id: fromId, typing_ticket: ticket, status: 2,
            }, botToken);
          }
        } catch (e) {
          log('处理消息出错:', e?.message ?? e);
        }
      }
    }
  }
}

main().catch((e) => {
  log('致命错误:', e);
  process.exit(1);
});
