const WebSocket = require('ws');
const protobuf = require('protobufjs');
const axios = require('axios');
const crypto = require('crypto');
const config = require('./config');
const fs = require('fs');
const path = require('path');
const { createPluginContext } = require('./bot-plugins/context');
const { buildPluginRegistry } = require('./bot-plugins/index');
const { buildNcmPlugin } = require('./bot-plugins/ncm');
const { buildDouyinPlugin } = require('./bot-plugins/douyin');
const { buildKuaishouPlugin } = require('./bot-plugins/kuaishou');
const { buildToutiaoPlugin } = require('./bot-plugins/toutiao');
const { buildRednotePlugin } = require('./bot-plugins/rednote');
const { buildBilibiliPlugin } = require('./bot-plugins/bilibili');
const { buildHeyboxPlugin } = require('./bot-plugins/heybox');
const { buildKurobbsPlugin } = require('./bot-plugins/kurobbs');
const { buildXPlugin } = require('./bot-plugins/x');
const { buildCoolapkPlugin } = require('./bot-plugins/coolapk');
const { buildMiyoushePlugin } = require('./bot-plugins/miyoushe');
const { buildTiebaPlugin } = require('./bot-plugins/tieba');
const { buildYoutubePlugin } = require('./bot-plugins/youtube');

// kurobbs的请求头devcode,source,version可以瞎填一个（目测）

// NCM (网易云) API modules (来自 api-enhanced-main)
const ncmRequest = require('./api-enhanced-main/api-enhanced-main/util/request');
const ncmSongDetail = require('./api-enhanced-main/api-enhanced-main/module/song_detail');
const ncmPlaylistDetail = require('./api-enhanced-main/api-enhanced-main/module/playlist_detail');
const ncmSongUrlV1 = require('./api-enhanced-main/api-enhanced-main/module/song_url_v1');
const ncmSongUrl = require('./api-enhanced-main/api-enhanced-main/module/song_url');
const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13
];

// Douyin (抖音) parser ported from:
// nonebot-plugin-parser(lite)
const DOUYIN_ROUTER_PATTERN = /window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s;

let msgRoot = null;
let SendMessageSend = null;
let SendMessage = null;
let selfSentMsgIds = new Set();
let messageContextByMsgId = new Map();
let processedIncomingMsgIds = new Set();
let pluginRegistry = null;

// RedNote (小红书) parser ported from:
// nonebot-plugin-parser-lite
const REDNOTE_INITIAL_STATE_PATTERN = /window\.__INITIAL_STATE__=(.*?)<\/script>/s;

// Kuaishou (快手) init state decode ported from:
// nonebot-plugin-parser-lite
const KS_RE_PATH = /0sftu[^.\-@]*/;
const KS_RE_ID = /[0-9:;<=>?]{8,}/;
// T1: byte -> (byte-1)%256
const KS_T1 = new Uint8Array(256);
for (let i = 0; i < 256; i++) KS_T1[i] = (i - 1 + 256) % 256;

function ksTranslate(s) {
  // python: str.translate(T1) where T1 maps all 256 chars.
  // 这里按 latin1 做一遍 0-255 的字节映射。
  const buf = Buffer.from(String(s), 'latin1');
  for (let i = 0; i < buf.length; i++) buf[i] = KS_T1[buf[i]];
  return buf.toString('latin1');
}

function ksGetFinalStablePathUltimate(text) {
  const m = String(text).match(KS_RE_PATH);
  if (!m) return String(text);

  const rawPath = m[0];
  const decodedPath = ksTranslate(rawPath);

  // decoded_path.endswith("profile") and RE_ID.search(text, pos=match_path.end())
  if (decodedPath.endsWith('profile')) {
    const rest = String(text).slice(m.index + rawPath.length);
    if (KS_RE_ID.test(rest)) {
      return `${decodedPath}/author`;
    }
  }
  return decodedPath;
}

function ksDecodeInitState(input) {
  const obj = typeof input === 'string' ? safeJsonParse(input) : input;
  if (!obj || typeof obj !== 'object') throw new Error('ks init_state must be an object');
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[ksGetFinalStablePathUltimate(k)] = v;
  }
  return out;
}

// WebSocket连接
let ws = null;
let heartbeatTimer = null;
let root = null;

// 加载protobuf定义
async function loadProto() {
  root = await protobuf.load('./proto/chat_ws_go.proto');
  msgRoot = await protobuf.load('./proto/msg.proto');
  SendMessageSend = msgRoot.lookupType('yh_msg.send_message_send');
  SendMessage = msgRoot.lookupType('yh_msg.send_message');
  console.log('Protobuf定义加载完成');
}

// 连接WebSocket
function connect() {
  const wsUrl = `wss://chat-ws-go.jwzhd.com/ws?userId=${config.ws.userId}&token=${config.ws.token}&platform=${config.ws.platform}&deviceId=${config.ws.deviceId}`;
  
  ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    console.log('WebSocket连接成功');
    sendLogin();
    startHeartbeat();
  });
  
  ws.on('message', (data) => {
    handleMessage(data);
  });
  
  ws.on('close', () => {
    console.log('WebSocket连接关闭');
    stopHeartbeat();
    // 5秒后重连
    setTimeout(connect, 5000);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket错误:', error.message);
  });
}

// 发送登录消息
function sendLogin() {
  try {
    const loginData = {
      seq: Date.now().toString(),
      cmd: 'login',
      data: {
        userId: config.ws.userId,
        token: config.ws.token,
        platform: config.ws.platform,
        deviceId: config.ws.deviceId
      }
    };
    
    ws.send(JSON.stringify(loginData));
    console.log('发送登录消息');
  } catch (error) {
    console.error('发送登录消息失败:', error);
  }
}

// 开始心跳
function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    try {
      const heartbeatData = {
        seq: Date.now().toString(),
        cmd: 'heartbeat'
      };
      
      ws.send(JSON.stringify(heartbeatData));
      console.log('发送心跳');
    } catch (error) {
      console.error('发送心跳失败:', error);
    }
  }, 30000); // 30秒一次
}

// 停止心跳
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// 处理收到的消息
function handleMessage(data) {
  try {
    // 尝试解析为JSON
    try {
      const jsonData = JSON.parse(data.toString());
      console.log('\n=== 收到 JSON 消息 ===');
      console.log(JSON.stringify(jsonData, null, 2));
      return;
    } catch (e) {
      // ProtoBuf
    }

    const bytes = new Uint8Array(data);
    const INFO = root.lookupType('yh_ws_go.INFO');

    let offset = 0;
    let cmd = '';
    let seq = '';

    try {
      if (bytes[offset] === 0x0a) {
        offset++;
        const infoLength = bytes[offset];
        offset++;
        const infoBytes = bytes.slice(offset, offset + infoLength);
        const info = INFO.decode(infoBytes);
        seq = info.seq;
        cmd = info.cmd;
      }
    } catch (e) {
      // 忽略解析错误
    }

    console.log(`\n=== 收到消息: ${cmd || 'unknown'} ===`);
    if (seq) {
      console.log('序列:', seq);
    }

    const decodeOptions = {
      longs: Number,
      enums: String,
      bytes: String
    };

    if (cmd === 'push_message') {
      const PushMessage = root.lookupType('yh_ws_go.push_message');
      const message = PushMessage.decode(bytes);
      const obj = PushMessage.toObject(message, decodeOptions);
      console.log('push_message JSON:');
      console.log(JSON.stringify(obj, null, 2));
      void handlePushMessage(obj);
      return;
    }

    if (cmd === 'file_send_message') {
      const FileSendMessage = root.lookupType('yh_ws_go.file_send_message');
      const message = FileSendMessage.decode(bytes);
      const obj = FileSendMessage.toObject(message, decodeOptions);
      console.log('file_send_message JSON:');
      console.log(JSON.stringify(obj, null, 2));
      return;
    }

    if (cmd === 'edit_message') {
      const EditMessage = root.lookupType('yh_ws_go.edit_message');
      const message = EditMessage.decode(bytes);
      const obj = EditMessage.toObject(message, decodeOptions);
      console.log('edit_message JSON:');
      console.log(JSON.stringify(obj, null, 2));
      return;
    }

    if (cmd === 'stream_message') {
      const StreamMessage = root.lookupType('yh_ws_go.stream_message');
      const message = StreamMessage.decode(bytes);
      const obj = StreamMessage.toObject(message, decodeOptions);
      console.log('stream_message JSON:');
      console.log(JSON.stringify(obj, null, 2));
      return;
    }

    if (cmd === 'bot_board_message') {
      const BotBoardMessage = root.lookupType('yh_ws_go.bot_board_message');
      const message = BotBoardMessage.decode(bytes);
      const obj = BotBoardMessage.toObject(message, decodeOptions);
      console.log('bot_board_message JSON:');
      console.log(JSON.stringify(obj, null, 2));
      return;
    }

    if (cmd === 'heartbeat_ack') {
      const HeartbeatAck = root.lookupType('yh_ws_go.heartbeat_ack');
      const message = HeartbeatAck.decode(bytes);
      const obj = HeartbeatAck.toObject(message, decodeOptions);
      console.log('heartbeat_ack JSON:');
      console.log(JSON.stringify(obj, null, 2));
      return;
    }

    console.log('未匹配到专门解码器，原始字节长度:', bytes.length);
  } catch (error) {
    console.error('处理消息失败:', error.message);
  }
}

function randomMsgId() {
  const base = crypto.randomBytes(12).toString('hex');
  const tail = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0').slice(-8);
  return `${base}${tail}`;
}

async function sendProtoTextMessage({ chatId, chatType, quoteMsgId, quoteMsgText, text }) {
  // protobufjs 在 JS 对象层使用 camelCase 字段名，不是 snake_case
  const msgId = randomMsgId();
  // 先记录，避免 push 回来时 race（HTTP 还没返回就收到了自己发的消息）
  selfSentMsgIds.add(msgId);
  setTimeout(() => selfSentMsgIds.delete(msgId), 10 * 60 * 1000);
  const payload = {
    msgId,
    chatId: String(chatId),
    chatType: Number(chatType),
    content: {
      text: String(text),
      quoteMsgText: String(quoteMsgText || '')
    },
    contentType: 1,
    quoteMsgId: String(quoteMsgId)
  };

  const err = SendMessageSend.verify(payload);
  if (err) {
    throw new Error(`send_message_send verify failed: ${err}`);
  }

  const err2 = SendMessageSend.verify(payload);
  if (err2) {
    throw new Error(`send_message_send verify failed before create: ${err2}`);
  }

  const message = SendMessageSend.create(payload);

  console.log('SendMessageSend.fromObject/toObject JSON:');
  console.log(
    JSON.stringify(
      SendMessageSend.toObject(message, {
        longs: Number,
        enums: String,
        bytes: String,
        defaults: true
      }),
      null,
      2
    )
  );

  const body = Buffer.from(SendMessageSend.encode(message).finish());

  console.log('send-message protobuf hex:');
  console.log(body.toString('hex'));

  const resp = await axios.post('https://chat-go.jwzhd.com/v1/msg/send-message', body, {
    headers: {
      token: config.ws.token
    },
    responseType: 'arraybuffer',
    timeout: 20000
  });

  const bytes = new Uint8Array(resp.data);
  const decoded = SendMessage.decode(bytes);
  const obj = SendMessage.toObject(decoded, {
    longs: Number,
    enums: String,
    bytes: String
  });

  console.log('send-message request JSON:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('send-message response JSON:');
  console.log(JSON.stringify(obj, null, 2));

  return { ...obj, __sentMsgId: msgId };
}

function formatNum(num) {
  if (num === null || num === undefined) return '-';
  const n = Number(num);
  if (!Number.isFinite(n)) return '-';
  return n < 10000 ? String(n) : `${(n / 10000).toFixed(1)}万`;
}

function randomChoice(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const rootUtils = {
  formatNum,
  randomChoice,
  safeJsonParse
};

async function fetchHtmlWithRedirect(url, { headers = {}, timeout = 20000 } = {}) {
  const resp = await axios.get(url, {
    headers,
    timeout,
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400
  });

  const finalUrl = resp?.headers?.location
    ? String(resp.headers.location).startsWith('http')
      ? String(resp.headers.location)
      : `https:${resp.headers.location}`
    : url;

  const html = typeof resp?.data === 'string' ? resp.data : '';
  return { status: resp.status, finalUrl, html, headers: resp.headers || {} };
}

async function fetchDouyinHtml(url, { headers = {}, timeout = 20000 } = {}) {
  // nonebot-plugin-parser-lite
  const resp = await axios.get(url, {
    headers: {
      'User-Agent':
        headers['User-Agent'] ||
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Accept: headers['Accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': headers['Accept-Language'] || 'zh-CN,zh;q=0.9',
      ...headers
    },
    timeout,
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400
  });

  const finalUrl = resp?.headers?.location
    ? String(resp.headers.location).startsWith('http')
      ? String(resp.headers.location)
      : `https:${resp.headers.location}`
    : url;

  const html = typeof resp?.data === 'string' ? resp.data : '';
  return { status: resp.status, finalUrl, html, headers: resp.headers || {} };
}

async function resolveDouyinShortLink(shortUrl) {
  const { status, finalUrl } = await fetchDouyinHtml(shortUrl, {});
  if (status >= 300 && status < 400 && finalUrl && finalUrl !== shortUrl) {
    return finalUrl;
  }
  // 有些情况会直接 200 返回落地页，这里仍返回 shortUrl
  return finalUrl || shortUrl;
}

async function parseDouyinSharePage(url) {
  // url 形如：https://m.douyin.com/share/video/<vid>
  const { status, finalUrl, html } = await fetchDouyinHtml(url, {});
  if (status !== 200) {
    throw new Error(`douyin status: ${status}`);
  }

  const matched = html.match(DOUYIN_ROUTER_PATTERN);
  if (!matched || !matched[1]) {
    throw new Error("can't find _ROUTER_DATA in html");
  }

  const jsonText = matched[1].trim();
  const routerData = safeJsonParse(jsonText);
  if (!routerData) {
    throw new Error('failed to JSON.parse _ROUTER_DATA');
  }

  const { videoData, commentList } = extractDouyinVideoDataFromRouterData(routerData);
  return {
    inputUrl: url,
    finalUrl,
    videoData,
    commentList
  };
}

function extractDouyinTarget(text) {
  if (!text) return null;
  const s = String(text);

  // 短链：v.douyin.com / jx.douyin.com
  const short = s.match(/https?:\/\/(v\.douyin\.com|jx\.douyin\.com)\/[a-zA-Z0-9_\-]+/i)
    || s.match(/\b(v\.douyin\.com|jx\.douyin\.com)\/[a-zA-Z0-9_\-]+\b/i);
  if (short) {
    const url = short[0].startsWith('http') ? short[0] : `https://${short[0]}`;
    return { type: 'douyin_short', url };
  }

  // 长链：douyin.com/video|note|article/<vid>
  // 以及：iesdouyin.com/share/... 或 m.douyin.com/share/... 或 jingxuan.douyin.com/m/...
  const long = s.match(/douyin\.com\/(?<ty>video|note|article)\/(?<vid>\d+)/i)
    || s.match(/iesdouyin\.com\/share\/(?<ty>video|note|article)\/(?<vid>\d+)/i)
    || s.match(/m\.douyin\.com\/share\/(?<ty>video|note|article)\/(?<vid>\d+)/i)
    || s.match(/jingxuan\.douyin\.com\/m\/(?<ty>video|note|article)\/(?<vid>\d+)/i);
  if (long?.groups?.vid) {
    let ty = long.groups.ty;
    const vid = long.groups.vid;
    if (ty === 'article') ty = 'note';
    const shareUrl = `https://m.douyin.com/share/${ty}/${vid}`;
    return { type: 'douyin', url: shareUrl, ty, vid };
  }

  return null;
}

async function debugParseDouyinFromText(text) {
  const target = extractDouyinTarget(text);
  if (!target) return null;

  let shareUrl = '';
  let inputUrl = target.url;
  if (target.type === 'douyin_short') {
    const resolved = await resolveDouyinShortLink(target.url);
    const t2 = extractDouyinTarget(resolved);
    if (!t2) {
      throw new Error(`douyin short link resolved but cannot parse target: ${resolved}`);
    }
    shareUrl = t2.url;
    inputUrl = resolved;
  } else {
    shareUrl = target.url;
  }

  const parsed = await parseDouyinSharePage(shareUrl);
  const summary = buildDouyinDebugSummary({
    inputUrl,
    finalUrl: parsed.finalUrl,
    videoData: parsed.videoData,
    commentList: parsed.commentList
  });

  console.log('\n=== Douyin Debug Parse Result ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log('=== End Douyin Debug ===\n');

  return summary;
}

function buildRednoteReplyText(summary, { maxImages = Infinity, maxLives = 2 } = {}) {
  const author = summary?.author || {};
  const stats = summary?.stats || {};

  const lines = [
    '小红书解析 (rednote):',
    summary?.title ? `标题: ${summary.title}` : null,
    summary?.desc ? `内容: ${summary.desc}` : null,
    author?.nickname ? `作者: ${author.nickname}` : null,
    author?.avatarUrl ? `头像: ${author.avatarUrl}` : null,
    stats?.like ? `点赞: ${stats.like}` : null,
    stats?.comment ? `评论: ${stats.comment}` : null,
    stats?.share ? `分享: ${stats.share}` : null,
    stats?.collect ? `收藏: ${stats.collect}` : null
  ].filter(Boolean);

  if (summary?.videoUrl) {
    lines.push(`视频: ${summary.videoUrl}`);
    if (summary?.coverUrl) lines.push(`封面: ${summary.coverUrl}`);
  }

  const imgs = Array.isArray(summary?.imageUrls) ? summary.imageUrls : [];
  if (imgs.length) {
    lines.push(`图片数: ${imgs.length}`);
    lines.push('图片:');
    for (const u of imgs) lines.push(u);
  }

  const lives = Array.isArray(summary?.liveUrls) ? summary.liveUrls : [];
  if (lives.length) {
    const sliced = lives.slice(0, maxLives);
    lines.push(`LivePhoto数: ${lives.length}`);
    for (const it of sliced) {
      if (it?.liveUrl) lines.push(`Live视频: ${it.liveUrl}`);
      if (it?.coverUrl) lines.push(`Live封面: ${it.coverUrl}`);
    }
    if (lives.length > sliced.length) lines.push(`(仅展示前${maxLives}个LivePhoto)`);
  }

  if (Array.isArray(summary?.comments) && summary.comments.length) {
    lines.push('热评(最多3条):');
    for (const c of summary.comments.slice(0, 3)) lines.push(c);
  }

  if (summary?.finalUrl) lines.push(`链接: ${summary.finalUrl}`);
  return lines.filter(Boolean).join('\n');
}

async function parseRednoteFromText(text) {
  if (!text) return null;
  const s = String(text);

  // 短链：xhslink.com/xxxx
  const short = s.match(/https?:\/\/(xhslink\.com\/[A-Za-z0-9._?%&+=/#@-]+)/i)
    || s.match(/\b(xhslink\.com\/[A-Za-z0-9._?%&+=/#@-]+)\b/i);
  if (short) {
    const url = short[0].startsWith('http') ? short[0] : `https://${short[0]}`;
    const { finalUrl } = await fetchHtmlWithRedirect(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Referer: 'https://www.xiaohongshu.com/'
      },
      timeout: 20000
    });

    // xhslink 短链经常会跳到：xhsdiscover/s/<id> 之类，再跳一次拿到带 xsec_token 的落地页
    if (finalUrl && /xhslink\.com\//i.test(finalUrl)) {
      return await parseRednoteFromText(finalUrl);
    }

    // 再做一次 redirect（防止中间页 200 但包含 meta refresh）
    const r2 = await fetchHtmlWithRedirect(finalUrl || url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Referer: 'https://www.xiaohongshu.com/'
      },
      timeout: 20000
    });
    return await parseRednoteFromText(r2.finalUrl || finalUrl || url);
  }

  // 长链：www.xiaohongshu.com/.../<note_id>?xsec_token=...
  const m = s.match(/xiaohongshu\.com\/(?<type>explore|search_result|discovery\/item)\/(?<noteId>[0-9a-zA-Z]+)\?(?<qs>[^\s]+)/i)
    || s.match(/xiaohongshu\.com\/explore\/(?<noteId>[0-9a-zA-Z]+)\b/i);
  if (!m?.groups?.noteId) return null;

  const noteId = m.groups.noteId;
  const qs = m.groups.qs;
  const params = new URLSearchParams(qs);
  const xsecToken = params.get('xsec_token');
  if (!xsecToken) {
    throw new Error('缺少 xsec_token, 无法解析小红书链接');
  }

  const finalUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_share`;

  // 1) fetch init state html
  const pageResp = await axios.get(finalUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      Referer: 'https://www.xiaohongshu.com/',
      Origin: 'https://www.xiaohongshu.com',
      'X-Requested-With': 'XMLHttpRequest',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty'
    },
    timeout: 20000
  });
  const html = typeof pageResp?.data === 'string' ? pageResp.data : '';
  const matched = html.match(REDNOTE_INITIAL_STATE_PATTERN);
  if (!matched || !matched[1]) {
    throw new Error('小红书分享链接失效或内容已删除');
  }
  const rawJson = String(matched[1]).replace(/undefined/g, '""');
  const initState = safeJsonParse(rawJson);
  if (!initState) {
    throw new Error('failed to JSON.parse __INITIAL_STATE__');
  }

  const noteWrapper = initState?.note?.noteDetailMap?.[noteId];
  const note = noteWrapper?.note;
  if (!note) {
    throw new Error('noteDetailMap missing note');
  }

  // 2) fetch comments
  let comments = [];
  try {
    const comResp = await axios.get('https://edith.xiaohongshu.com/api/sns/web/v2/comment/page', {
      params: {
        note_id: noteId,
        cursor: '',
        top_comment_id: '',
        image_formats: 'jpg,webp,avif',
        xsec_token: xsecToken
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Referer: finalUrl,
        Origin: 'https://www.xiaohongshu.com'
      },
      timeout: 20000
    });
    const comJson = comResp?.data;
    if (comJson?.code === 0) {
      comments = Array.isArray(comJson?.data?.comments) ? comJson.data.comments : [];
    }
  } catch (e) {
    console.log('[rednote] fetch comments failed:', e?.message || e);
  }

  const imageUrls = Array.isArray(note?.imageList) ? note.imageList.map((i) => i?.urlDefault).filter(Boolean) : [];

  // video url (prefer h264->... like explore.Stream)
  const pickStreamUrl = (stream) => {
    const lists = [stream?.h264, stream?.h265, stream?.h266, stream?.av1];
    for (const lst of lists) {
      if (Array.isArray(lst) && lst.length && lst[0]?.masterUrl) return lst[0].masterUrl;
    }
    return '';
  };

  const videoUrl = note?.video?.media?.stream ? pickStreamUrl(note.video.media.stream) : '';

  const liveUrls = Array.isArray(note?.imageList)
    ? note.imageList
        .filter((img) => img?.livePhoto)
        .map((img) => ({
          liveUrl: img?.stream ? pickStreamUrl(img.stream) : '',
          coverUrl: img?.urlDefault || ''
        }))
        .filter((x) => x.liveUrl)
    : [];

  const commentPreview = comments.slice(0, 3).map((c) => {
    const name = c?.userInfo?.nickname || '未知';
    const text = (c?.content || '').replace(/\s+/g, ' ').slice(0, 80);
    const like = c?.likeCount || '-';
    const sub = Array.isArray(c?.subComments) ? c.subComments.length : 0;
    const ip = c?.ipLocation || '';
    return `${name}: ${text}${text.length >= 80 ? '...' : ''} (赞${like}/评${sub}${ip ? `/` + ip : ''})`;
  });

  return {
    platform: 'rednote',
    noteId,
    finalUrl,
    title: note?.title || '',
    desc: note?.desc || '',
    author: {
      nickname: note?.user?.nickname || '',
      avatarUrl: note?.user?.avatar || ''
    },
    stats: {
      like: note?.interactInfo?.likedCount || '-',
      comment: note?.interactInfo?.commentCount || '-',
      share: note?.interactInfo?.shareCount || '-',
      collect: note?.interactInfo?.collectedCount || '-'
    },
    imageUrls,
    videoUrl: videoUrl || '',
    coverUrl: imageUrls[0] || '',
    liveUrls,
    comments: commentPreview,
    timestamp: Number(note?.lastUpdateTime || 0)
  };
}

function buildKuaishouReplyText(summary) {
  const author = summary?.author || {};
  const stats = summary?.stats || {};
  const lines = [
    '快手解析 (kuaishou):',
    summary?.caption ? `标题: ${summary.caption}` : null,
    author?.name ? `作者: ${author.name}` : null,
    author?.avatarUrl ? `头像: ${author.avatarUrl}` : null,
    stats?.view ? `浏览: ${stats.view}` : null,
    stats?.like ? `点赞: ${stats.like}` : null,
    stats?.comment ? `评论: ${stats.comment}` : null,
    stats?.share ? `分享: ${stats.share}` : null,
    summary?.videoUrl ? `视频: ${summary.videoUrl}` : null,
    summary?.coverUrl ? `封面: ${summary.coverUrl}` : null
  ].filter(Boolean);

  const imgs = Array.isArray(summary?.imageUrls) ? summary.imageUrls : [];
  if (imgs.length) {
    lines.push(`图片数: ${imgs.length}`);
    lines.push('图片:');
    for (const u of imgs) lines.push(u);
  }

  if (summary?.finalUrl) lines.push(`链接: ${summary.finalUrl}`);
  return lines.join('\n');
}

async function parseKuaishouFromText(text) {
  if (!text) return null;
  const s = String(text);

  const m = s.match(/https?:\/\/(v\.kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+|(?:www\.)?kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+|(?:v\.m\.)?chenzhongtech\.com\/fw\/[A-Za-z\d._?%&+\-=/#]+)/i)
    || s.match(/\b(v\.kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+|(?:www\.)?kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+|(?:v\.m\.)?chenzhongtech\.com\/fw\/[A-Za-z\d._?%&+\-=/#]+)\b/i);
  if (!m) return null;

  const inputUrl = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;

  // 先拿跳转后的真实链接
  const shortLinkHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
//    Cookie: 'did=web_c91cb80fe3fa4e34a6105d2a9ea76cbf; didv=1773242061000',
    Referer: 'https://www.kuaishou.com/'
  };

  const r1 = await fetchHtmlWithRedirect(inputUrl, {
    headers: shortLinkHeaders,
    timeout: 20000
  });
  let realUrl = r1.finalUrl || inputUrl;
  // v.kuaishou 短链可能返回 200 + HTML 内再跳转，补一跳
  if (realUrl === inputUrl) {
    try {
      const r1b = await axios.get(inputUrl, {
        headers: shortLinkHeaders,
        timeout: 20000
      });
      const html1 = typeof r1b?.data === 'string' ? r1b.data : '';
      const m1 = html1.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i) || html1.match(/http-equiv=['"]refresh['"][^>]*url=([^"'>\s]+)/i);
      if (m1 && m1[1]) {
        const u = String(m1[1]);
        realUrl = u.startsWith('http') ? u : `https:${u}`;
      }
    } catch {}
  }
  // /fw/long-video/ 返回结构不同，替换为 /fw/photo/
  realUrl = realUrl.replace('/fw/long-video/', '/fw/photo/');

  const pageHeaders = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://www.kuaishou.com/'
  };

  const r2 = await axios.get(realUrl, {
    headers: pageHeaders,
    timeout: 20000
  });
  let html = typeof r2?.data === 'string' ? r2.data : '';

  // 桌面 UA 命中的 often 是壳页面；按 nonebot 原实现改用 iOS UA 重新请求一次。
  if (!/window\.INIT_STATE|__NEXT_DATA__|__INITIAL_STATE__|__NUXT__/i.test(html)) {
    try {
      const r2b = await axios.get(realUrl, {
        headers: pageHeaders,
        timeout: 20000
      });
      const html2 = typeof r2b?.data === 'string' ? r2b.data : '';
      if (html2) html = html2;
    } catch {}
  }

  // INIT_STATE 在页面里通常是 window.INIT_STATE = {...}
  // 现在有些快手分享页会把它放在页面末尾且体积很大，正则非贪婪容易提前截断。
  // 这里优先按锚点截取完整 JSON，再退回旧逻辑。
  let initJsonText = '';
  const initAnchorCandidates = [
    'window.INIT_STATE = ',
    'window.INIT_STATE=',
    'self.INIT_STATE = ',
    'self.INIT_STATE='
  ];
  for (const initAnchor of initAnchorCandidates) {
    const initStart = html.indexOf(initAnchor);
    if (initStart >= 0) {
      const afterAnchor = html.slice(initStart + initAnchor.length);
      const scriptEnd = afterAnchor.indexOf('</script>');
      if (scriptEnd >= 0) {
        initJsonText = afterAnchor.slice(0, scriptEnd).trim();
        initJsonText = initJsonText.replace(/;\s*$/, '').trim();
        break;
      }
    }
  }
  if (!initJsonText) {
    const initMatch = html.match(/(?:window|self)\.INIT_STATE\s*=\s*(\{[\s\S]*\})\s*;?\s*<\/script>/i);
    if (initMatch && initMatch[1]) {
      initJsonText = initMatch[1];
    }
  }
  if (!initJsonText) {
    const nextMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (nextMatch && nextMatch[1]) {
      const nextData = safeJsonParse(nextMatch[1]);
      // 兜底：不同页面结构字段可能不同，这里尽量找 INIT_STATE
      initJsonText =
        (typeof nextData?.props?.pageProps?.INIT_STATE === 'string' && nextData.props.pageProps.INIT_STATE) ||
        (typeof nextData?.props?.pageProps?.initState === 'string' && nextData.props.pageProps.initState) ||
        (nextData?.props?.pageProps?.INIT_STATE && JSON.stringify(nextData.props.pageProps.INIT_STATE)) ||
        (typeof nextData?.props?.initialState === 'string' && nextData.props.initialState) ||
        (nextData?.props?.initialState && JSON.stringify(nextData.props.initialState)) ||
        '';
    }
  }
  if (!initJsonText) {
    const universalStateMatch = html.match(/<script[^>]*>\s*self\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i)
      || html.match(/<script[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i)
      || html.match(/<script[^>]*>\s*self\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i)
      || html.match(/<script[^>]*>\s*window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i);
    if (universalStateMatch && universalStateMatch[1]) {
      initJsonText = universalStateMatch[1];
    }
  }

  if (!initJsonText) {
    console.log('[kuaishou] realUrl =', realUrl);
    console.log('[kuaishou] html preview:', html.slice(0, 4000));
    throw new Error("can't find window.INIT_STATE in html");
  }

  const initObj = safeJsonParse(initJsonText);
  if (!initObj) {
    throw new Error('failed to JSON.parse init state');
  }

  const decoded = ksDecodeInitState(initObj);
  const info = decoded['/rest/wd/ugH5App/photo/simple/info'];
  const author = decoded['/rest/wd/user/profile/author'];

  const photo = info?.photo;
  if (!photo) {
    throw new Error("window.init_state don't contains videos or pics");
  }

  const caption = photo?.caption || '';
  const timestamp = Number(photo?.timestamp || 0);
  const duration = Number(photo?.duration || 0);

  // 视频/封面
  const coverUrl = Array.isArray(photo?.coverUrls) && photo.coverUrls.length ? randomChoice(photo.coverUrls)?.url : '';
  const videoUrl = Array.isArray(photo?.mainMvUrls) && photo.mainMvUrls.length ? randomChoice(photo.mainMvUrls)?.url : '';

  // 图集（atlas.list + cdnList.cdn）
  const atlas = photo?.ext_params?.atlas || {};
  const cdn = Array.isArray(atlas?.cdnList) && atlas.cdnList.length ? randomChoice(atlas.cdnList)?.cdn : '';
  const routes = Array.isArray(atlas?.list) ? atlas.list : [];
  const imageUrls = cdn && routes.length ? routes.map((u) => `https://${cdn}/${u}`) : [];

  return {
    platform: 'kuaishou',
    inputUrl,
    finalUrl: realUrl,
    caption,
    timestamp,
    duration,
    author: {
      name: (photo?.userName || '').replace(/\u3164/g, '').trim() || author?.userProfile?.profile?.user_name || '',
      avatarUrl: photo?.headUrl || author?.userProfile?.profile?.headurl || ''
    },
    stats: {
      view: formatNum(photo?.viewCount),
      like: formatNum(photo?.likeCount),
      comment: formatNum(photo?.commentCount),
      share: formatNum(photo?.shareCount)
    },
    videoUrl: videoUrl || '',
    coverUrl: coverUrl || '',
    imageUrls
  };
}

function extractExtraParsersTarget(text) {
  const douyin = extractDouyinTarget(text);
  if (douyin) return { platform: 'douyin' };

  // rednote
  if (/xhslink\.com\//i.test(String(text)) || /xiaohongshu\.com\//i.test(String(text))) {
    return { platform: 'rednote' };
  }

  // kuaishou
  if (/v\.kuaishou\.com\//i.test(String(text)) || /kuaishou\.com\//i.test(String(text)) || /chenzhongtech\.com\/fw\//i.test(String(text))) {
    return { platform: 'kuaishou' };
  }

  // kurobbs / 库街区
  if (
    /kurobbs\.com\/postDetail\.html\?[^\s]*\bpostId=\d+/i.test(String(text))
    || /kurobbs\.com\/(?:pns|mc)\/post\/\d+/i.test(String(text))
  ) {
    return { platform: 'kurobbs' };
  }

  // X / Twitter
  if (/twitter\.com\/[0-9-a-zA-Z_]{1,20}\/status\/\d+/i.test(String(text)) || /x\.com\/[0-9-a-zA-Z_]{1,20}\/status\/\d+/i.test(String(text))) {
    return { platform: 'x' };
  }

  return null;
}

function xCleanTweetText(fullText) {
  if (!fullText) return '';
  return String(fullText)
    .replace(/\s*https:\/\/t\.co\/[0-9a-zA-Z_]+/g, '')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .trim();
}

function percentEncodeAliyun(value) {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function buildAliyunCanonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncodeAliyun(key)}=${percentEncodeAliyun(params[key])}`)
    .join('&');
}

function aliyunSignQuery(params, accessKeySecret) {
  const canonical = buildAliyunCanonicalQuery(params);
  const stringToSign = `GET&${percentEncodeAliyun('/')}&${percentEncodeAliyun(canonical)}`;
  const signature = crypto.createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  return { canonical, stringToSign, signature };
}

async function refreshKurobbsPlayCode(videoId) {
  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    Connection: 'keep-alive',
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    devCode: 'qQEqfNyouMULztWVJcTjXxmZZ6kp85yv',
    source: 'h5',
    version: '2.10.5',
    Origin: 'https://www.kurobbs.com',
    Referer: 'https://www.kurobbs.com/'
  };
  const formBody = new URLSearchParams({ videoId: String(videoId) }).toString();

  console.log('[kurobbs][video] refreshPlayCode request videoId =', videoId);
  console.log('[kurobbs][video] refreshPlayCode request headers:');
  console.log(JSON.stringify(reqHeaders, null, 2));
  console.log('[kurobbs][video] refreshPlayCode request body:');
  console.log(formBody);

  try {
    const resp = await axios.post('https://api.kurobbs.com/forum/video/refreshPlayCode', formBody, {
      headers: reqHeaders,
      timeout: 20000
    });

    const res = resp?.data;
    console.log('[kurobbs][video] refreshPlayCode raw response:');
    console.log(JSON.stringify(res, null, 2));

    if (res?.code !== 200 || !res?.data?.playAuth) {
      throw new Error(res?.msg || 'refreshPlayCode failed');
    }
    return res.data;
  } catch (e) {
    console.log('[kurobbs][video] refreshPlayCode failed');
    console.log('[kurobbs][video] refreshPlayCode error message:', e?.message || e);
    if (e?.response) {
      console.log('[kurobbs][video] refreshPlayCode status:', e.response.status);
      console.log('[kurobbs][video] refreshPlayCode response headers:');
      console.log(JSON.stringify(e.response.headers || {}, null, 2));
      console.log('[kurobbs][video] refreshPlayCode response body raw:');
      console.log(e.response.data);
      console.log('[kurobbs][video] refreshPlayCode response body json:');
      console.log(JSON.stringify(e.response.data || {}, null, 2));
    }
    throw e;
  }
}

async function resolveKurobbsVideoPlayInfo(videoId) {
  const playCode = await refreshKurobbsPlayCode(videoId);
  const decodedText = Buffer.from(String(playCode.playAuth), 'base64').toString('utf8');
  const decoded = safeJsonParse(decodedText);
  if (!decoded) {
    throw new Error('playAuth base64 decode failed');
  }

  console.log('[kurobbs][video] refreshPlayCode response:');
  console.log(JSON.stringify(playCode, null, 2));
  console.log('[kurobbs][video] playAuth decoded:');
  console.log(decodedText);

  const authInfo = typeof decoded.AuthInfo === 'string' ? decoded.AuthInfo : JSON.stringify(decoded.AuthInfo || {});
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const params = {
    AccessKeyId: decoded.AccessKeyId,
    Action: 'GetPlayInfo',
    AuthInfo: authInfo,
    AuthTimeout: 7200,
    Channel: 'HTML5',
    Definition: 'FD,LD,SD,HD',
    Format: 'JSON',
    Formats: '',
    PlayConfig: '{}',
    PlayerVersion: '2.29.2',
    Rand: crypto.randomUUID(),
    ReAuthInfo: '{}',
    SecurityToken: decoded.SecurityToken,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce,
    SignatureVersion: '1.0',
    StreamType: 'video',
    Version: '2017-03-21',
    VideoId: decoded.VideoMeta?.VideoId || decoded.videoId || String(videoId)
  };

  const signed = aliyunSignQuery(params, decoded.AccessKeySecret);
  const requestParams = {
    ...params,
    Signature: signed.signature
  };
  const fullUrl = `https://vod.${decoded.Region}.aliyuncs.com?${buildAliyunCanonicalQuery(requestParams)}`;

  console.log('[kurobbs][video] aliyun request params:');
  console.log(JSON.stringify(requestParams, null, 2));
  console.log('[kurobbs][video] aliyun canonical query:');
  console.log(signed.canonical);
  console.log('[kurobbs][video] aliyun stringToSign:');
  console.log(signed.stringToSign);
  console.log('[kurobbs][video] aliyun signature:');
  console.log(signed.signature);
  console.log('[kurobbs][video] aliyun full url:');
  console.log(fullUrl);

  try {
    const resp = await axios.get(`https://vod.${decoded.Region}.aliyuncs.com`, {
      params: requestParams,
      headers: {
        Accept: '*/*',
        Origin: 'https://www.kurobbs.com',
        Referer: 'https://www.kurobbs.com/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
      },
      timeout: 20000
    });

    const data = resp?.data;
    console.log('[kurobbs][video] aliyun response:');
    console.log(JSON.stringify(data, null, 2));

    const playInfos = Array.isArray(data?.PlayInfoList?.PlayInfo) ? data.PlayInfoList.PlayInfo : [];
    return {
      refreshData: playCode,
      playAuthDecoded: decoded,
      requestMeta: {
        ...signed,
        params: requestParams,
        fullUrl
      },
      response: data,
      playInfos
    };
  } catch (e) {
    console.log('[kurobbs][video] aliyun request failed');
    console.log('[kurobbs][video] error name:', e?.name || '');
    console.log('[kurobbs][video] error code:', e?.code || '');
    console.log('[kurobbs][video] error message:', e?.message || e);
    console.log('[kurobbs][video] request url when failed:');
    console.log(fullUrl);
    console.log('[kurobbs][video] request headers when failed:');
    console.log(JSON.stringify({
      Accept: '*/*',
      Origin: 'https://www.kurobbs.com',
      Referer: 'https://www.kurobbs.com/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Accept-Language': 'zh-CN,zh;q=0.9,ko;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
    }, null, 2));
    if (e?.config) {
      console.log('[kurobbs][video] axios config method:', e.config.method || '');
      console.log('[kurobbs][video] axios config url:', e.config.url || '');
      console.log('[kurobbs][video] axios config params:');
      console.log(JSON.stringify(e.config.params || {}, null, 2));
    }
    if (e?.response) {
      console.log('[kurobbs][video] error status:', e.response.status);
      console.log('[kurobbs][video] error headers:');
      console.log(JSON.stringify(e.response.headers || {}, null, 2));
      console.log('[kurobbs][video] error body raw:');
      console.log(e.response.data);
      console.log('[kurobbs][video] error body json:');
      console.log(JSON.stringify(e.response.data || {}, null, 2));
    } else {
      console.log('[kurobbs][video] no response object on error');
    }
    console.error('[kurobbs][video] detailed error object:', e);
    throw e;
  }
}

function xPickBestVideoVariant(variants) {
  const list = Array.isArray(variants) ? variants : [];
  const mp4s = list
    .filter((v) => v?.content_type === 'video/mp4' && typeof v?.bitrate === 'number' && typeof v?.url === 'string')
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4s.length ? mp4s[0].url : '';
}

function xExtractMedias(tweetLegacy) {
  const medias = tweetLegacy?.extended_entities?.media;
  const list = Array.isArray(medias) ? medias : [];
  const out = [];
  for (const m of list) {
    if (m?.type === 'photo' && m?.media_url_https) {
      out.push({ type: 'photo', url: m.media_url_https });
      continue;
    }
    if ((m?.type === 'video' || m?.type === 'animated_gif') && m?.video_info?.variants) {
      const best = xPickBestVideoVariant(m.video_info.variants);
      if (best) out.push({ type: 'video', url: best, cover: m?.media_url_https || '' });
    }
  }
  return out;
}

function buildXReplyText(summary, { maxMedia = 4 } = {}) {
  const author = summary?.author || {};
  const stats = summary?.stats || {};

  const lines = [
    'X解析 (x):',
    author?.name ? `作者: ${author.name}` : null,
    summary?.text ? `内容:\n${summary.text}` : null,
    stats?.view ? `浏览: ${stats.view}` : null,
    stats?.like ? `点赞: ${stats.like}` : null,
    stats?.comment ? `评论: ${stats.comment}` : null,
    stats?.collect ? `收藏: ${stats.collect}` : null
  ].filter(Boolean);

  const medias = Array.isArray(summary?.medias) ? summary.medias : [];
  if (medias.length) {
    lines.push(`媒体数: ${medias.length}`);
    for (const m of medias.slice(0, maxMedia)) {
      if (m.type === 'photo') lines.push(`图片: ${m.url}`);
      else if (m.type === 'video') lines.push(`视频: ${m.url}${m.cover ? ` (封面: ${m.cover})` : ''}`);
    }
    if (medias.length > maxMedia) lines.push(`(仅展示前${maxMedia}个媒体)`);
  }

  if (summary?.quoted) {
    const q = summary.quoted;
    lines.push('--- 引用推文 ---');
    if (q?.author?.name) lines.push(`作者: ${q.author.name}`);
    if (q?.text) lines.push(`内容:\n${q.text}`);
    const qMedias = Array.isArray(q?.medias) ? q.medias : [];
    for (const m of qMedias.slice(0, 2)) {
      if (m.type === 'photo') lines.push(`图片: ${m.url}`);
      else if (m.type === 'video') lines.push(`视频: ${m.url}`);
    }
  }

  if (summary?.url) lines.push(`链接: ${summary.url}`);
  return lines.join('\n');
}

function buildKurobbsReplyText(summary, { maxImages = 4, maxTextBlocks = 6 } = {}) {
  const author = summary?.author || {};
  const stats = summary?.stats || {};
  const lines = [
    '库街区解析 (kurobbs):',
    summary?.title ? `标题: ${summary.title}` : null,
    author?.name ? `作者: ${author.name}` : null,
    summary?.forumName ? `分区: ${summary.forumName}` : null,
    summary?.gameName ? `游戏: ${summary.gameName}` : null,
    summary?.postTime ? `时间: ${summary.postTime}` : null,
    stats?.view ? `浏览: ${stats.view}` : null,
    stats?.like ? `点赞: ${stats.like}` : null,
    stats?.comment ? `评论: ${stats.comment}` : null,
    stats?.collect ? `收藏: ${stats.collect}` : null
  ].filter(Boolean);

  const textBlocks = Array.isArray(summary?.textBlocks) ? summary.textBlocks.filter(Boolean) : [];
  if (textBlocks.length) {
    lines.push('正文:');
    for (const t of textBlocks.slice(0, maxTextBlocks)) lines.push(t);
    if (textBlocks.length > maxTextBlocks) lines.push(`(仅展示前${maxTextBlocks}段)`);
  }

  const imgs = Array.isArray(summary?.imageUrls) ? summary.imageUrls.filter(Boolean) : [];
  if (imgs.length) {
    lines.push(`图片数: ${imgs.length}`);
    for (const u of imgs.slice(0, maxImages)) lines.push(`图片: ${u}`);
    if (imgs.length > maxImages) lines.push(`(仅展示前${maxImages}张)`);
  }

  if (summary?.videoUrl) lines.push(`视频: ${summary.videoUrl}`);
  if (Array.isArray(summary?.videoPlayUrls) && summary.videoPlayUrls.length) {
    lines.push('视频清晰度:');
    for (const item of summary.videoPlayUrls) {
      lines.push(`${item.definition || '-'}: ${item.url}`);
    }
  }
  if (summary?.coverUrl) lines.push(`封面: ${summary.coverUrl}`);
  if (Array.isArray(summary?.topics) && summary.topics.length) lines.push(`话题: ${summary.topics.join(' / ')}`);
  if (summary?.linkCardUrl) lines.push(`链接卡片: ${summary.linkCardTitle ? `${summary.linkCardTitle} ` : ''}${summary.linkCardUrl}`.trim());
  if (summary?.url) lines.push(`链接: ${summary.url}`);

  return lines.join('\n');
}

async function parseKurobbsFromText(text) {
  if (!text) return null;
  const s = String(text);
  const m = s.match(/kurobbs\.com\/postDetail\.html\?[^\s]*\bpostId=(\d+)/i)
    || s.match(/kurobbs\.com\/(?:pns|mc)\/post\/(\d+)/i);
  if (!m) return null;

  const postId = m[1];
  const finalUrl = `https://www.kurobbs.com/postDetail.html?postId=${postId}`;
  const body = new URLSearchParams({
    postId: String(postId),
    isOnlyPublisher: '0',
    showOrderType: '2'
  }).toString();

  const resp = await axios.post('https://api.kurobbs.com/forum/getPostDetail', body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      devCode: 'qQEqfNyouMULztWVJcTjXxmZZ6kp85yv',
      source: 'h5',
      version: '2.10.5',
      Referer: 'https://www.kurobbs.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    },
    timeout: 20000
  });

  const res = resp?.data;
  if (res?.code !== 200 || !res?.data?.postDetail) {
    throw new Error(res?.msg || 'kurobbs api failed');
  }

  const detail = res.data.postDetail;
  const postContent = Array.isArray(detail?.postContent) ? detail.postContent : [];
  const textBlocks = [];
  const imageUrls = [];
  let linkCardTitle = '';
  let linkCardUrl = '';

  for (const item of postContent) {
    if (item?.contentType === 1) {
      const content = String(item?.content || '').replace(/_\[\/[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
      if (content) textBlocks.push(content);
      continue;
    }
    // 按 postContent 原始顺序收集图片，避免被 coverImages 打乱顺序
    if ((item?.contentType === 2 || item?.contentType === 4) && item?.url) {
      imageUrls.push(String(item.url));
      continue;
    }
    if (item?.contentType === 3 && item?.contentLink?.url) {
      linkCardUrl = String(item.contentLink.url);
      linkCardTitle = String(item.contentLink.title || '');
    }
  }

  const coverUrl = imageUrls[0]
    || (Array.isArray(detail?.coverImages) && detail.coverImages.length ? detail.coverImages[0]?.sourceUrl || detail.coverImages[0]?.url || '' : '');

  let videoUrl = '';
  let videoPlayUrls = [];
  if (detail?.videoId) {
    try {
      console.log('[kurobbs] resolve video play info start, videoId =', detail.videoId);
      const videoInfo = await resolveKurobbsVideoPlayInfo(detail.videoId);
      videoPlayUrls = videoInfo.playInfos
        .filter((x) => x?.Format === 'm3u8' && x?.PlayURL)
        .sort((a, b) => Number(b?.Width || 0) - Number(a?.Width || 0) || Number(b?.Bitrate || 0) - Number(a?.Bitrate || 0))
        .map((x) => ({
          definition: x?.Definition || '',
          width: Number(x?.Width || 0),
          height: Number(x?.Height || 0),
          bitrate: Number(x?.Bitrate || 0),
          url: x?.PlayURL || ''
        }));
      videoUrl = videoPlayUrls[0]?.url || '';
      console.log('[kurobbs] resolve video play info ok, definitions =', videoPlayUrls.map((x) => x.definition).join(','));
    } catch (e) {
      console.log('[kurobbs] resolve video play info failed:', e?.message || e);
      console.log('[kurobbs] resolve video play info error stack:');
      console.log(e?.stack || '');
      console.log('[kurobbs] note: if inner [kurobbs][video] logs are missing, the running process is probably still using an old bot.js build/cache');
    }
  }

  return {
    platform: 'kurobbs',
    postId,
    url: finalUrl,
    title: detail?.postTitle || '',
    forumName: detail?.gameForumVo?.name || '',
    gameName: detail?.gameName || '',
    postType: Number(detail?.postType || 0),
    postTime: detail?.postTime || '',
    author: {
      name: detail?.userName || ''
    },
    stats: {
      view: formatNum(Number(detail?.browseCount || 0)),
      like: formatNum(Number(detail?.likeCount || 0)),
      comment: formatNum(Number(detail?.commentCount || 0)),
      collect: formatNum(Number(detail?.collectionCount || 0))
    },
    textBlocks,
    imageUrls,
    videoId: detail?.videoId || '',
    videoUrl,
    videoPlayUrls,
    coverUrl,
    topics: Array.isArray(detail?.topicList) ? detail.topicList.map((x) => x?.topicName).filter(Boolean) : [],
    linkCardTitle,
    linkCardUrl
  };
}

async function parseXFromText(text) {
  if (!text) return null;
  const s = String(text);
  const m = s.match(/(?:twitter\.com|x\.com)\/[0-9-a-zA-Z_]{1,20}\/status\/(\d+)/i);
  if (!m) return null;
  const tweetId = m[1];

  console.log('[x] easycomment request tweetId =', tweetId);
  const resp = await axios.post(
    'https://easycomment.ai/api/twitter/v1/free/get-tweet-detail',
    { pid: tweetId },
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Content-Type': 'application/json'
      },
      timeout: 20000
    }
  );

  const res = resp?.data;
  if (!res || res.code !== 100000) {
    throw new Error(res?.message || 'easycomment api failed');
  }

  const tweetRaw =
    res?.data?.data?.threaded_conversation_with_injections_v2?.instructions?.[1]?.entries?.[0]?.content?.itemContent?.tweet_results;
  const tweet = tweetRaw?.result;
  if (!tweet?.legacy || !tweet?.core?.user_results?.result?.legacy) {
    throw new Error('tweet result missing legacy');
  }

  const userLegacy = tweet.core.user_results.result.legacy;
  const legacy = tweet.legacy;

  const authorName = `${userLegacy.name} @${userLegacy.screen_name}`;
  const medias = xExtractMedias(legacy);

  const summary = {
    platform: 'x',
    tweetId: tweet.rest_id,
    url: `https://x.com/${userLegacy.screen_name}/status/${tweet.rest_id}`,
    author: {
      name: authorName,
      avatarUrl: String(userLegacy.profile_image_url_https || '').replace('_normal', '_bigger'),
      description: userLegacy.description || '',
      id: userLegacy.screen_name
    },
    text: xCleanTweetText(legacy.full_text),
    stats: {
      view: formatNum(Number(tweet?.views?.count || 0)),
      like: formatNum(legacy.favorite_count),
      comment: formatNum(legacy.reply_count),
      collect: formatNum(legacy.bookmark_count)
    },
    medias,
    quoted: null
  };

  if (tweet.quoted_status_result?.result?.legacy && tweet.quoted_status_result?.result?.core?.user_results?.result?.legacy) {
    const qt = tweet.quoted_status_result.result;
    const qu = qt.core.user_results.result.legacy;
    summary.quoted = {
      tweetId: qt.rest_id,
      url: `https://x.com/${qu.screen_name}/status/${qt.rest_id}`,
      author: {
        name: `${qu.name} @${qu.screen_name}`
      },
      text: xCleanTweetText(qt.legacy.full_text),
      medias: xExtractMedias(qt.legacy)
    };
  }

  // 如果包含视频：下载到 /tmp 目录，调用 upload-media.js 上传，然后删除源文件（不发视频消息）
  const videos = Array.isArray(summary?.medias) ? summary.medias.filter((mm) => mm?.type === 'video' && mm?.url) : [];
  if (videos.length) {
    const firstVideo = videos[0];

    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const fileName = `x-${tweet.rest_id || tweetId}-${Date.now()}.mp4`;
    const tmpPath = path.join(tmpDir, fileName);

    console.log('[x] download video start:', firstVideo.url);
    console.log('[x] tmpPath =', tmpPath);

    const downloadResp = await axios.get(firstVideo.url, {
      responseType: 'stream',
      timeout: 60000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Referer: summary.url
      }
    });

    const writer = fs.createWriteStream(tmpPath);
    await new Promise((resolve, reject) => {
      downloadResp.data.pipe(writer);
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve();
      };
      writer.on('finish', () => finish());
      writer.on('error', (e) => finish(e));
      downloadResp.data.on('error', (e) => finish(e));
    });

    const st = fs.statSync(tmpPath);
    console.log('[x] download video ok, bytes =', st.size);

    try {
      // eslint-disable-next-line global-require
      const uploader = require('./upload-media');
      console.log('[x] upload-media.js uploadVideoFromPath start');
      const up = await uploader.uploadVideoFromPath(tmpPath, { originalName: fileName });
      console.log('[x] upload-media.js uploadVideoFromPath ok:', JSON.stringify(up, null, 2));
    } finally {
      try {
        fs.unlinkSync(tmpPath);
        console.log('[x] tmp video deleted:', tmpPath);
      } catch (e) {
        console.log('[x] tmp video delete failed:', e?.message || e);
      }
    }
  }

  return summary;
}

function extractNcmSongId(text) {
  if (!text) return null;

  // 支持：
  // 1) http(s)://music.163.com/song/1955953307/?userid=...
  // 2) http(s)://music.163.com/#/song?id=1955953307
  // 3) https://music.163.com/song?id=1955953307
  // 4) https://music.163.com/m/song?id=1955953307
  const m1 = String(text).match(/https?:\/\/music\.163\.com\/song\/(\d+)/i);
  if (m1) return m1[1];

  const m2 = String(text).match(/music\.163\.com\/#\/song\?id=(\d+)/i);
  if (m2) return m2[1];

  const m3 = String(text).match(/music\.163\.com\/song\?[^\s]*\bid=(\d+)/i);
  if (m3) return m3[1];

  const m4 = String(text).match(/music\.163\.com\/m\/song\?[^\s]*\bid=(\d+)/i);
  if (m4) return m4[1];

  return null;
}

function extractNcmPlaylistId(text) {
  if (!text) return null;

  const m1 = String(text).match(/https?:\/\/music\.163\.com\/playlist\/(\d+)/i);
  if (m1) return m1[1];

  const m2 = String(text).match(/music\.163\.com\/#\/playlist\?id=(\d+)/i);
  if (m2) return m2[1];

  const m3 = String(text).match(/music\.163\.com\/playlist\?[^\s]*\bid=(\d+)/i);
  if (m3) return m3[1];

  const m4 = String(text).match(/music\.163\.com\/m\/playlist\?[^\s]*\bid=(\d+)/i);
  if (m4) return m4[1];

  const m5 = String(text).match(/music\.163\.com\/m\/playlist\?(?:[^\s]*&)?id=(\d+)/i);
  if (m5) return m5[1];

  return null;
}

async function getBuvid3() {
  const resp = await axios.get('https://api.bilibili.com/x/web-frontend/getbuvid', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/'
    },
    timeout: 20000
  });
  const buvid = resp?.data?.data?.buvid;
  return buvid ? String(buvid) : null;
}

async function buildBiliCookie() {

  const envCookie = process.env.BILI_COOKIE ? String(process.env.BILI_COOKIE) : '';
  let cookie = envCookie.trim();

  if (!/\bbuvid3=/.test(cookie)) {
    const buvid3 = await getBuvid3();
    if (buvid3) {
      cookie = cookie ? `${cookie}; buvid3=${buvid3}` : `buvid3=${buvid3}`;
    }
  }

  // 参考你给的网页端请求头，尽量补齐常见 web cookie，降低 -352 风控概率
  if (!/\bb_nut=/.test(cookie)) {
    const bNut = Math.floor(Date.now() / 1000);
    cookie = cookie ? `${cookie}; b_nut=${bNut}` : `b_nut=${bNut}`;
  }
  if (!/\b_uuid=/.test(cookie) && !/\b_uuid=|\b_uuid/.test(cookie)) {
    const uuid = `${crypto.randomUUID().toUpperCase()}${Math.floor(Date.now() / 1000)}infoc`;
    cookie = cookie ? `${cookie}; _uuid=${uuid}` : `_uuid=${uuid}`;
  }
  if (!/\bhit-dyn-v2=/.test(cookie)) {
    cookie = cookie ? `${cookie}; hit-dyn-v2=1` : 'hit-dyn-v2=1';
  }

  return cookie;
}

async function getWbiKeys() {
  const resp = await axios.get('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/'
    },
    timeout: 20000
  });

  const imgUrl = resp?.data?.data?.wbi_img?.img_url || '';
  const subUrl = resp?.data?.data?.wbi_img?.sub_url || '';
  const imgKey = imgUrl.split('/').pop().split('.')[0];
  const subKey = subUrl.split('/').pop().split('.')[0];
  return { imgKey, subKey };
}

function getMixinKey(orig) {
  return mixinKeyEncTab.map((n) => orig[n]).join('').slice(0, 32);
}

function encWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const wts = Math.floor(Date.now() / 1000);
  const filtered = { ...params, wts };
  const sortedKeys = Object.keys(filtered).sort();
  const query = sortedKeys
    .map((key) => {
      const value = String(filtered[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return { ...filtered, w_rid: wRid };
}

async function fetchBiliOpusDetail(opusId) {
  const cookie = await buildBiliCookie();
  const url = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail';
  const features =
    'onlyfansVote,onlyfansAssetsV2,decorationCard,htmlNewStyle,ugcDelete,editable,opusPrivateVisible,tribeeEdit,avatarAutoTheme,avatarTypeOpus';

  const resp = await axios.get(url, {
    params: {
      id: String(opusId),
      features
    },
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Referer: `https://www.bilibili.com/opus/${opusId}`,
      Cookie: cookie
    },
    timeout: 20000
  });

  return resp.data;
}

async function fetchBiliDynamicDetail(dynamicId) {
  const cookie = await buildBiliCookie();
  const url = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail';
  const features =
    'itemOpusStyle,opusBigCover,onlyfansVote,endFooterHidden,decorationCard,onlyfansAssetsV2,ugcDelete,onlyfansQaCard,editable,opusPrivateVisible,avatarAutoTheme,sunflowerStyle,cardsEnhance,eva3CardOpus,eva3CardVideo,eva3CardComment,eva3CardVote,eva3CardUser';

  const { imgKey, subKey } = await getWbiKeys();
  const signedParams = encWbi(
    {
      timezone_offset: -480,
      platform: 'web',
      gaia_source: 'main_web',
      id: String(dynamicId),
      features,
      web_location: '333.1368',
      'x-bili-device-req-json': JSON.stringify({
        platform: 'web',
        device: 'pc',
        spmid: '333.1368'
      })
    },
    imgKey,
    subKey
  );

  const resp = await axios.get(url, {
    params: signedParams,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      Accept: '*/*',
      Origin: 'https://t.bilibili.com',
      Referer: `https://t.bilibili.com/${dynamicId}`,
      Cookie: cookie,
      'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-site': 'same-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'accept-language': 'zh-CN,zh;q=0.9,ko;q=0.8'
    },
    timeout: 20000,
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400
  });

  return resp.data;
}

async function resolveB23ShortLink(shortUrl) {
  const cookie = await buildBiliCookie();
  const resp = await axios.get(shortUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
      Cookie: cookie
    },
    timeout: 20000,
    maxRedirects: 0,
    validateStatus: (status) => status >= 200 && status < 400
  });

  const location = resp.headers?.location || resp.request?.res?.headers?.location || '';
  if (!location) {
    throw new Error('b23短链未返回跳转地址');
  }

  const finalUrl = String(location).startsWith('http') ? String(location) : `https:${location}`;
  const target = extractBiliDynamicTarget(finalUrl);
  if (!target || !['dynamic', 'opus', 'music', 'bili_audio'].includes(target.type)) {
    throw new Error(`b23短链跳转后不是支持的链接: ${finalUrl}`);
  }

  return {
    ...target,
    shortUrl,
    finalUrl
  };
}

function secondsToDurationText(sec) {
  const n = Number(sec || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const hours = Math.floor(n / 3600);
  const minutes = Math.floor((n % 3600) / 60);
  const seconds = Math.floor(n % 60);
  if (hours > 0) {
    return [hours, minutes, seconds].map((v) => String(v).padStart(2, '0')).join(':');
  }
  return [minutes, seconds].map((v) => String(v).padStart(2, '0')).join(':');
}

async function fetchBiliMusicDetail(musicId) {
  const cookie = await buildBiliCookie();
  const { imgKey, subKey } = await getWbiKeys();
  const params = encWbi(
    {
      music_id: String(musicId),
      relation_from: 'bgm_page'
    },
    imgKey,
    subKey
  );

  const resp = await axios.get('https://api.bilibili.com/x/copyright-music-publicity/bgm/detail', {
    params,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      Referer: `https://music.bilibili.com/h5/music-detail?music_id=${musicId}`,
      Origin: 'https://music.bilibili.com',
      Cookie: cookie,
      Accept: 'application/json, text/plain, */*'
    },
    timeout: 20000
  });

  return resp.data;
}

async function fetchBiliAudioStreamUrlWeb(sid) {
  // bilibili-API-collect

  const url = 'https://www.bilibili.com/audio/music-service-c/web/url';
  const resp = await axios.get(url, {
    params: {
      sid: Number(sid),
      quality: 2,
      privilege: 2
    },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/'
    },
    timeout: 20000
  });
  return resp.data;
}

function buildBiliAudioReplyText(sid, stream) {
  const data = stream?.data || {};
  const cdns = Array.isArray(data?.cdns) ? data.cdns.filter(Boolean) : [];
  const audioUrl = cdns[0] || '';

  return [
    `B站音频解析 (au): ${sid}`,
    stream?.code === 0 ? null : `状态: code=${stream?.code} msg=${stream?.msg || stream?.message || ''}`,
    typeof data?.type === 'number' ? `音质标识: ${data.type}` : null,
    typeof data?.timeout === 'number' ? `有效期(秒): ${data.timeout}` : null,
    typeof data?.size === 'number' ? `大小: ${data.size}` : null,
    audioUrl ? `音频: ${audioUrl}` : '音频: (未获取到流URL)',
    `链接: https://www.bilibili.com/audio/au${sid}`
  ].filter(Boolean).join('\n');
}

function extractPlainTextFromMusicDetail(data) {
  const info = data?.music_detail || data || {};
  const upper = data?.upper || {};
  const passthrough = data?.passthrough || {};
  const musicComment = data?.music_comment || {};
  const stat = info?.stat || data?.stat || {};

  const title = info?.title || info?.music_title || '';
  const artistList = Array.isArray(data?.artists_list)
    ? data.artists_list.map((item) => item?.name).filter(Boolean)
    : [];
  const artistIdentityList = Array.isArray(data?.artists_list)
    ? data.artists_list
        .map((item) => {
          const name = item?.name || '';
          const identity = item?.identity || '';
          return name ? `${name}${identity ? `（${identity}）` : ''}` : '';
        })
        .filter(Boolean)
    : [];
  const authorName = upper?.name || info?.author || info?.singer || data?.origin_artist || artistList.join('、') || '';
  const album = info?.album || data?.album || '';
  const summary = info?.intro || info?.summary || info?.sub_title || info?.lyric || data?.music_source || '';
  const durationText = secondsToDurationText(info?.duration || info?.play_time || info?.duration_second);
  const playCountRaw = info?.play_num ?? stat?.play ?? stat?.play_num ?? data?.listen_pv;
  const commentCountRaw = musicComment?.nums ?? stat?.reply ?? stat?.comment;
  const collectCountRaw = info?.collect_num ?? stat?.collect ?? stat?.fav ?? data?.mv_fav;
  const shareCountRaw = info?.share_num ?? stat?.share ?? data?.music_shares ?? data?.mv_shares;
  const wishCountRaw = info?.wish_num ?? data?.wish_num ?? data?.wish_count;
  const coinCountRaw = info?.coin_num ?? stat?.coin;
  const likeCountRaw = data?.mv_likes ?? stat?.like;
  const relationCountRaw = data?.music_relation;
  const hotValueRaw = data?.music_hot ?? data?.hot_song_heat?.last_heat;
  const supportListen = typeof data?.support_listen === 'boolean' ? data.support_listen : null;
  const wishListen = typeof data?.wish_listen === 'boolean' ? data.wish_listen : null;
  const pubTime = data?.music_publish || info?.pub_time || info?.ctime || data?.ctime || '';
  const cover = info?.cover || info?.cover_url || data?.cover || data?.mv_cover || '';
  const lyric = info?.lyric || data?.mv_lyric || '';
  const aid = passthrough?.aid || info?.aid || data?.aid || data?.mv_aid || null;
  const cid = passthrough?.cid || info?.cid || data?.cid || data?.mv_cid || null;
  const bvid = info?.bvid || passthrough?.bvid || data?.bvid || data?.mv_bvid || '';
  const cname = passthrough?.cname || info?.cname || '';
  const category = info?.category || data?.category || '';
  const source = info?.source || data?.source || data?.music_source || '';
  const rank = data?.music_rank || data?.recreation_rank || '';
  const achievement = Array.isArray(data?.achievement) ? data.achievement.filter(Boolean) : [];
  const hottestRank = data?.hot_song_rank?.highest_rank;
  const onListTimes = data?.hot_song_rank?.on_list_times;
  const lastHeat = data?.hot_song_heat?.last_heat;
  const maxListId = data?.max_list_id;
  const mvIndexOrder = data?.mv_index_order;
  const bgColor = data?.bg_color || '';
  const tags = Array.isArray(info?.tag)
    ? info.tag.filter(Boolean)
    : Array.isArray(info?.tags)
      ? info.tags.filter(Boolean)
      : Array.isArray(data?.tag)
        ? data.tag.filter(Boolean)
        : [];

  const normalizeNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  return {
    title,
    authorName,
    artistList,
    artistIdentityList,
    album,
    summary,
    durationText,
    playCount: normalizeNumber(playCountRaw),
    commentCount: normalizeNumber(commentCountRaw),
    collectCount: normalizeNumber(collectCountRaw),
    shareCount: normalizeNumber(shareCountRaw),
    wishCount: normalizeNumber(wishCountRaw),
    coinCount: normalizeNumber(coinCountRaw),
    likeCount: normalizeNumber(likeCountRaw),
    relationCount: normalizeNumber(relationCountRaw),
    hotValue: normalizeNumber(hotValueRaw),
    lastHeat: normalizeNumber(lastHeat),
    hottestRank: normalizeNumber(hottestRank),
    onListTimes: normalizeNumber(onListTimes),
    maxListId: normalizeNumber(maxListId),
    mvIndexOrder: normalizeNumber(mvIndexOrder),
    supportListen,
    wishListen,
    rank,
    achievement,
    pubTime: pubTime ? String(pubTime) : '',
    cover: cover ? String(cover) : '',
    lyric: lyric ? String(lyric) : '',
    aid: aid ? String(aid) : '',
    cid: cid ? String(cid) : '',
    bvid,
    cname,
    category,
    source,
    bgColor,
    tags
  };
}

function pickModule(modules, moduleType) {
  if (!Array.isArray(modules)) return null;
  return modules.find((m) => m?.module_type === moduleType) || null;
}

async function fetchNcmSongDetail(songId) {
  const query = {
    ids: String(songId),
    // 这里默认走 weapi（模块内部 createOption(query, 'weapi')）
  };

  console.log('[NCM] song_detail request:', JSON.stringify(query));
  const res = await ncmSongDetail(query, ncmRequest);
  console.log('[NCM] song_detail response status:', res?.status);
  console.log('[NCM] song_detail response body(code):', res?.body?.code);
  return res;
}

async function fetchNcmPlaylistDetail(playlistId) {
  const query = {
    id: String(playlistId),
    s: 8
  };

  console.log('[NCM] playlist_detail request:', JSON.stringify(query));
  const res = await ncmPlaylistDetail(query, ncmRequest);
  console.log('[NCM] playlist_detail response status:', res?.status);
  console.log('[NCM] playlist_detail response body(code):', res?.body?.code);
  return res;
}

async function fetchNcmSongAudio(songId, { unblock = false, source = 'unm', level = 'standard' } = {}) {
  // 说明：
  // - 默认不 unblock：走官方 /song/url
  // - 只有 unblock=true（通过 /gbbot-ncm-ubmusic-... 触发）才尝试第三方解锁源

  const tryOld = async () => {
    const query = {
      id: String(songId),
      br: 999000
    };
    console.log('[NCM] song_url request:', JSON.stringify(query));
    const res = await ncmSongUrl(query, ncmRequest);
    console.log('[NCM] song_url response status:', res?.status);
    console.log('[NCM] song_url response body(code):', res?.body?.code);
    return res;
  };

  const tryV1Official = async () => {
    const query = {
      id: String(songId),
      level: String(level),
      unblock: 'false',
      source: String(source)
    };
    console.log('[NCM] song_url_v1(official) request:', JSON.stringify(query));
    const res = await ncmSongUrlV1(query, ncmRequest);
    console.log('[NCM] song_url_v1(official) response status:', res?.status);
    console.log('[NCM] song_url_v1(official) response body(code):', res?.body?.code);
    return res;
  };

  const withTimeout = (promise, ms, tag) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${tag} timeout after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  const tryLocalUnblockModules = async () => {
    // 本地解锁源尝试顺序：
    // UnblockNeteaseMusic unm,baka,bikonoo,gdmusic,msls,qijieya
    const candidates = [
      { name: 'unm', file: './UnblockNeteaseMusic-utils-main/modules/unm.js', method: 'unm' },
      { name: 'baka', file: './UnblockNeteaseMusic-utils-main/modules/baka.js', method: 'baka' },
      { name: 'gdmusic', file: './UnblockNeteaseMusic-utils-main/modules/gdmusic.js', method: 'gdmusic' },
      { name: 'msls', file: './UnblockNeteaseMusic-utils-main/modules/msls.js', method: 'msls' },
      { name: 'qijieya', file: './UnblockNeteaseMusic-utils-main/modules/qijieya.js', method: 'qijieya' },
      { name: 'bikonoo', file: './UnblockNeteaseMusic-utils-main/modules/bikonoo.js', method: 'bikonoo' }
    ];

    for (const c of candidates) {
      let mod;
      try {
        mod = require(c.file);
      } catch (e) {
        console.log(`[NCM][unblock] skip ${c.name}: cannot require ${c.file}:`, e?.message || e);
        continue;
      }

      const fn = mod?.[c.method];
      if (typeof fn !== 'function') {
        console.log(`[NCM][unblock] skip ${c.name}: method ${c.method} not found`);
        continue;
      }

      try {
        console.log(`[NCM][unblock] try source=${c.name} songId=${songId}`);
        const url = await withTimeout(Promise.resolve(fn(String(songId))), 15000, `unblock:${c.name}`);
        if (typeof url === 'string' && url.startsWith('http')) {
          return { source: `unblock:${c.name}`, url };
        }
        console.log(`[NCM][unblock] ${c.name} returned empty url`);
      } catch (e) {
        console.log(`[NCM][unblock] ${c.name} failed:`, e?.message || e);
      }
    }

    return null;
  };

  // 1) unblock=true 时：先强制尝试第三方解锁源
  if (unblock) {
    const ub = await tryLocalUnblockModules();
    if (ub?.url) {
      return { source: ub.source, res: null, url: ub.url };
    }
  }

  // 2) 再尝试官方 song_url
  const r2 = await tryOld();
  const url2 = r2?.body?.data?.[0]?.url;
  if (url2) {
    return { source: 'song_url', res: r2, url: url2 };
  }

  // 3) 最后兜底：走 v1 官方
  const r3 = await tryV1Official();
  const url3 = r3?.body?.data?.[0]?.url;
  return { source: 'song_url_v1_official', res: r3, url: url3 || '' };
}

function extractPlainTextFromNcmDetailBody(body) {
  const songs = body?.songs;
  const song = Array.isArray(songs) && songs.length ? songs[0] : null;
  if (!song) return null;

  const name = song?.name || '';
  const artists = Array.isArray(song?.ar) ? song.ar.map((a) => a?.name).filter(Boolean) : [];
  const album = song?.al?.name || '';
  const picUrl = song?.al?.picUrl || '';
  const durationMs = Number(song?.dt || 0);
  const durationText = durationMs > 0 ? secondsToDurationText(Math.floor(durationMs / 1000)) : '';

  return { name, artists, album, picUrl, durationText };
}

function extractPlainTextFromNcmPlaylistDetailBody(body) {
  const playlist = body?.playlist;
  if (!playlist) return null;

  const creator = playlist?.creator || {};
  const trackCount = Number(playlist?.trackCount || 0);
  const playCount = Number(playlist?.playCount || 0);
  const subscribedCount = Number(playlist?.subscribedCount || 0);
  const commentCount = Number(playlist?.commentCount || 0);
  const shareCount = Number(playlist?.shareCount || 0);
  const createTime = Number(playlist?.createTime || 0);
  const updateTime = Number(playlist?.updateTime || 0);

  return {
    name: playlist?.name || '',
    description: playlist?.description || '',
    coverImgUrl: playlist?.coverImgUrl || '',
    creatorName: creator?.nickname || '',
    trackCount,
    playCount,
    subscribedCount,
    commentCount,
    shareCount,
    createTime,
    updateTime,
    tags: Array.isArray(playlist?.tags) ? playlist.tags.filter(Boolean) : []
  };
}

function buildNcmPlaylistReplyText(playlistId, parsed) {
  const desc = (parsed?.description || '').replace(/\r/g, '').slice(0, 800);
  return [
    `网易云歌单解析 (playlist): ${playlistId}`,
    parsed?.name ? `歌单: ${parsed.name}` : null,
    parsed?.creatorName ? `创建者: ${parsed.creatorName}` : null,
    parsed?.tags?.length ? `标签: ${parsed.tags.join(' / ')}` : null,
    Number.isFinite(parsed?.trackCount) ? `歌曲数: ${parsed.trackCount}` : null,
    Number.isFinite(parsed?.playCount) ? `播放: ${parsed.playCount}` : null,
    Number.isFinite(parsed?.subscribedCount) ? `收藏: ${parsed.subscribedCount}` : null,
    Number.isFinite(parsed?.commentCount) ? `评论: ${parsed.commentCount}` : null,
    Number.isFinite(parsed?.shareCount) ? `分享: ${parsed.shareCount}` : null,
    parsed?.coverImgUrl ? `封面: ${parsed.coverImgUrl}` : null,
    desc ? `简介:\n${desc}${(parsed?.description || '').length > desc.length ? '...' : ''}` : null,
    `链接: https://music.163.com/playlist?id=${playlistId}`
  ].filter(Boolean).join('\n');
}

function buildNcmReplyText(songId, parsed, audio) {
  const displayName = parsed?.name || '';
  const artistText = parsed?.artists?.length ? parsed.artists.join(' / ') : '';
  const album = parsed?.album || '';

  return [
    `网易云解析 (ncm): ${songId}`,
    displayName ? `歌曲: ${displayName}` : null,
    artistText ? `歌手: ${artistText}` : null,
    album ? `专辑: ${album}` : null,
    parsed?.durationText ? `时长: ${parsed.durationText}` : null,
    parsed?.picUrl ? `封面: ${parsed.picUrl}` : null,
    audio?.url ? `音频: ${audio.url}` : '音频: (未获取到可用链接)',
    `链接: https://music.163.com/song/${songId}`
  ].filter(Boolean).join('\n');
}

function extractPlainTextFromOpusItem(item) {
  const modules = item?.modules || [];

  const titleModule = pickModule(modules, 'MODULE_TYPE_TITLE');
  const authorModule = pickModule(modules, 'MODULE_TYPE_AUTHOR');
  const contentModule = pickModule(modules, 'MODULE_TYPE_CONTENT');

  const title =
    titleModule?.module_title?.text ||
    item?.basic?.title ||
    item?.basic?.rid_str ||
    item?.id_str ||
    '';

  const authorName = authorModule?.module_author?.name || '';

  let contentText = '';
  const paragraphs = contentModule?.module_content?.paragraphs || [];
  for (const p of paragraphs) {
    const nodes = p?.text?.nodes;
    if (!Array.isArray(nodes)) continue;

    for (const n of nodes) {
      if (n?.type === 'TEXT_NODE_TYPE_WORD') {
        contentText += n?.word?.words || '';
      } else if (n?.type === 'TEXT_NODE_TYPE_RICH') {
        contentText += n?.rich?.orig_text || n?.rich?.text || '';
      }
    }
    contentText += '\n';
  }

  contentText = contentText.replace(/\n{3,}/g, '\n\n').trim();

  return { title, authorName, contentText };
}

function extractPlainTextFromDynamicItem(item) {
  const modules = item?.modules || {};
  const authorModule = modules?.module_author || {};
  const dynamicModule = modules?.module_dynamic || {};

  const title = item?.id_str || '';
  const authorName = authorModule?.name || '';
  let contentText = dynamicModule?.desc?.text || '';

  // 处理转发动态里的“原动态”内容：
  // 1. 原动态正文
  // 2. 原视频投稿
  // 3. 原 opus / 图文 投稿
  if (item?.type === 'DYNAMIC_TYPE_FORWARD' && item?.orig) {
    const orig = item.orig;
    const origBasic = orig?.basic || {};
    const origModules = orig?.modules || {};
    const origAuthor = origModules?.module_author || {};
    const origDynamic = origModules?.module_dynamic || {};
    const origMajor = origDynamic?.major || {};

    const origParts = [];
    if (origAuthor?.name) {
      origParts.push(`原动态作者: ${origAuthor.name}`);
    }
    if (origAuthor?.pub_action) {
      origParts.push(`原动态动作: ${origAuthor.pub_action}`);
    }
    if (origDynamic?.desc?.text) {
      origParts.push(`原动态正文: ${origDynamic.desc.text}`);
    }

    // 原投稿视频
    if (origMajor?.type === 'MAJOR_TYPE_ARCHIVE' && origMajor?.archive) {
      const archive = origMajor.archive;
      if (archive?.title) {
        origParts.push(`原视频标题: ${archive.title}`);
      }
      if (archive?.desc) {
        origParts.push(`原视频简介: ${archive.desc}`);
      }
      if (archive?.bvid) {
        origParts.push(`原视频BV: ${archive.bvid}`);
      }
      if (archive?.jump_url) {
        const jumpUrl = String(archive.jump_url).startsWith('//')
          ? `https:${archive.jump_url}`
          : archive.jump_url;
        origParts.push(`原视频链接: ${jumpUrl}`);
      }
      if (archive?.stat?.play || archive?.stat?.danmaku) {
        origParts.push(`原视频数据: 播放${archive?.stat?.play || '0'} / 弹幕${archive?.stat?.danmaku || '0'}`);
      }
    }

    // 原 opus / 图文 / 图集
    if (origMajor?.type === 'MAJOR_TYPE_OPUS' && origMajor?.opus) {
      const opus = origMajor.opus;
      if (opus?.title) {
        origParts.push(`原图文标题: ${opus.title}`);
      }
      if (opus?.summary?.text) {
        origParts.push(`原图文摘要: ${opus.summary.text}`);
      }
      if (opus?.jump_url) {
        const jumpUrl = String(opus.jump_url).startsWith('//')
          ? `https:${opus.jump_url}`
          : opus.jump_url;
        origParts.push(`原图文链接: ${jumpUrl}`);
      } else if (origBasic?.jump_url) {
        const jumpUrl = String(origBasic.jump_url).startsWith('//')
          ? `https:${origBasic.jump_url}`
          : origBasic.jump_url;
        origParts.push(`原图文链接: ${jumpUrl}`);
      }
      if (Array.isArray(opus?.pics) && opus.pics.length > 0) {
        origParts.push(`原图文图片数: ${opus.pics.length}`);
      }
    }

    if (origParts.length > 0) {
      contentText = [contentText, ...origParts].filter(Boolean).join('\n');
    }
  }

  return { title, authorName, contentText };
}

function shouldSkipParsedReply(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  const patterns = [
    /^网易云解析\s*\((?:ncm|playlist|event)\):/i,
    /^网易云搜索\s*\(/i,
    /^YouTube解析\s*\(youtube\):/i,
    /^B站(?:视频|动态|音乐|音频)解析\s*\((?:video|opus|dynamic|music|au)\):/i,
    /^抖音解析\s*\(douyin\):/i,
    /^小红书解析\s*\(rednote\):/i,
    /^快手解析\s*\(kuaishou\):/i,
    /^库街区解析\s*\(kurobbs\):/i,
    /^X解析\s*\(x\):/i,
    /^小黑盒解析\s*\(heybox\):/i,
    /^今日头条解析\s*\(toutiao\):/i,
    /^米游社解析\s*\(miyoushe\):/i,
    /^贴吧解析\s*\(tieba\):/i,
    // 兼容旧乱码前缀（历史消息/旧版本）
    /^缃戞槗.*\((?:ncm|playlist|event)\):/i
  ];
  return patterns.some((r) => r.test(s));
}

function buildQuoteMsgText(msg, text) {
  const quoted = messageContextByMsgId.get(msg.msgId);
  return quoted
    ? `${quoted.senderName || '未知'}：${quoted.text || ''}`
    : `${msg.sender?.name || '未知'}：${text || ''}`;
}

async function sendReplyByPluginResult(msg, text, result) {
  if (!result?.replyText) {
    return;
  }

  const quoteMsgText = buildQuoteMsgText(msg, text);
  const sendResult = await sendProtoTextMessage({
    chatId: msg.chatId,
    chatType: msg.chatType,
    quoteMsgId: msg.msgId,
    quoteMsgText,
    text: result.replyText
  });

  if (sendResult?.__sentMsgId) {
    console.log('本次发送消息ID(用于过滤回环):', sendResult.__sentMsgId);
  }
}

// 处理推送消息
async function handlePushMessage(pushData) {
  try {
    if (!pushData.data || !pushData.data.msg) {
      return;
    }

    const msg = pushData.data.msg;
    const text = msg.content ? msg.content.text : '';
    const senderName = msg.sender ? msg.sender.name : '';
    const audioUrl = msg.content ? msg.content.audioUrl : '';

    if (msg.msgId) {
      messageContextByMsgId.set(msg.msgId, {
        chatId: msg.chatId,
        chatType: msg.chatType,
        senderName,
        text
      });
      setTimeout(() => messageContextByMsgId.delete(msg.msgId), 10 * 60 * 1000);
    }

    if (msg.msgId) {
      if (processedIncomingMsgIds.has(msg.msgId)) {
        console.log('跳过重复推送消息:', msg.msgId);
        return;
      }
      processedIncomingMsgIds.add(msg.msgId);
      setTimeout(() => processedIncomingMsgIds.delete(msg.msgId), 2 * 60 * 1000);
    }

    if (msg.msgId && selfSentMsgIds.has(msg.msgId)) {
      console.log('跳过自己刚发送的消息:', msg.msgId);
      return;
    }
    // 兜底：部分场景 msgId 可能不同步（或跨进程）。
    // 但你也可能“自己发链接来测试/使用解析”，所以这里只跳过“自己发的解析结果消息”（通常带 quote 且前缀命中）。
    if (msg.sender?.chatId && msg.recvId && String(msg.sender.chatId) === String(msg.recvId)) {
      const hasQuote = !!(msg.quoteMsgId || msg?.content?.quoteMsgText);
      if (hasQuote && shouldSkipParsedReply(text)) {
        console.log('跳过自己发送的解析结果消息(sender.chatId == recvId):', msg.msgId);
        return;
      }
    }

    console.log('\n=== 收到消息 ===');
    console.log('发送者:', msg.sender ? msg.sender.name : '未知');
    console.log('内容:', text);

    if (pluginRegistry && audioUrl) {
      for (const plugin of pluginRegistry.items || []) {
        if (typeof plugin?.handlePushMessage !== 'function') continue;
        const result = await plugin.handlePushMessage(msg);
        if (result?.replyText) {
          const quoteMsgText = `${senderName || '未知'}: [音频]`;
          await sendProtoTextMessage({
            chatId: msg.chatId,
            chatType: msg.chatType,
            quoteMsgId: msg.msgId,
            quoteMsgText,
            text: result.replyText
          });
          break;
        }
      }
    }

    if (!text || shouldSkipParsedReply(text) || !pluginRegistry) {
      return;
    }

    const detected = pluginRegistry.detect(text);
    if (!detected) {
      return;
    }

    console.log('[plugin] matched =', detected.plugin?.name || 'unknown');
    handleBotCommand(msg);
  } catch (error) {
    console.error('处理推送消息失败:', error);
  }
}

// 处理机器人命令
async function handleBotCommand(msg) {
  const text = msg.content ? msg.content.text : '';

  console.log('=== 触发链接解析 ===');
  console.log('消息ID:', msg.msgId);
  console.log('chatId:', msg.chatId);
  console.log('chatType:', msg.chatType);
  console.log('发送者ID:', msg.sender?.chatId);

  if (!pluginRegistry) {
    console.log('pluginRegistry 未初始化');
    return;
  }

  const detected = pluginRegistry.detect(text);
  if (!detected?.plugin || !detected?.target) {
    console.log('未能从文本解析支持的链接目标');
    return;
  }

  const { plugin, target } = detected;
  console.log('[plugin] name =', plugin.name);
  console.log('[plugin] target =', JSON.stringify(target, null, 2));

  try {
    const result = await plugin.process(target);
    await sendReplyByPluginResult(msg, text, result);
  } catch (e) {
    console.log('解析失败:', e?.message || e);
  }
}

function initPluginRegistry() {
  const pluginContext = createPluginContext({
    axios,
    crypto,
    config,
    fs,
    path,
    ncmRequest,
    ncmSongDetail,
    ncmPlaylistDetail,
    ncmSongUrlV1,
    ncmSongUrl,
    randomChoice,
    safeJsonParse,
    secondsToDurationText,
    formatNum,
    fetchHtmlWithRedirect,
    buildBiliCookie,
    getWbiKeys,
    encWbi,
    pickModule,
    ksDecodeInitState,
    ksGetFinalStablePathUltimate
  });

  const enable = (config && config.plugins) || {};
  const enabled = (k) => enable[k] !== false;
  const plugins = [];
  if (enabled('ncm')) plugins.push(buildNcmPlugin(pluginContext));
  if (enabled('douyin')) plugins.push(buildDouyinPlugin(pluginContext));
  if (enabled('kuaishou')) plugins.push(buildKuaishouPlugin(pluginContext));
  if (enabled('rednote')) plugins.push(buildRednotePlugin(pluginContext));
  if (enabled('bilibili')) plugins.push(buildBilibiliPlugin(pluginContext));
  if (enabled('tieba')) plugins.push(buildTiebaPlugin(pluginContext));
  if (enabled('miyoushe')) plugins.push(buildMiyoushePlugin(pluginContext));
  if (enabled('youtube')) plugins.push(buildYoutubePlugin(pluginContext));
  if (enabled('kurobbs')) plugins.push(buildKurobbsPlugin(pluginContext));
  if (enabled('x')) plugins.push(buildXPlugin(pluginContext));
  if (enabled('coolapk')) plugins.push(buildCoolapkPlugin(pluginContext));
  if (enabled('heybox')) plugins.push(buildHeyboxPlugin(pluginContext));
  if (enabled('toutiao')) plugins.push(buildToutiaoPlugin(pluginContext));

  pluginRegistry = buildPluginRegistry(plugins);
}

// 启动机器人
async function start() {
  console.log('云湖机器人启动中...');
  await loadProto();
  initPluginRegistry();
  connect();
}

// 启动
start();
