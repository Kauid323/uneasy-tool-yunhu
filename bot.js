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
const { buildZhihuPlugin } = require('./bot-plugins/zhihu');
const { buildQqpdPlugin } = require('./bot-plugins/qqpd');
const { buildIdlefishPlugin } = require('./bot-plugins/idlefish');
const { buildWechatPlugin } = require('./bot-plugins/wechat');
const { buildLofterPlugin } = require('./bot-plugins/lofter');
const { buildSklandPlugin } = require('./bot-plugins/skland');

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

let msgRoot = null;
let SendMessageSend = null;
let SendMessage = null;
let selfSentMsgIds = new Set();
let messageContextByMsgId = new Map();
let processedIncomingMsgIds = new Set();
let pluginRegistry = null;

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

function pickModule(modules, moduleType) {
  if (!Array.isArray(modules)) return null;
  return modules.find((m) => m?.module_type === moduleType) || null;
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
    /^QQ频道解析\s*\(qqpd\):/i,
    /^闲鱼解析\s*\(idlefish\):/i,
    /^Skland解析\s*\(skland\):/i,
    // 兼容旧乱码前缀（历史消息/旧版本）
    /^缃戞槗.*\((?:ncm|playlist|event)\):/i
  ];
  return patterns.some((r) => r.test(s)) || /^知乎解析\s*\((?:answer|article)\):/i.test(s);
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
  if (enabled('zhihu')) plugins.push(buildZhihuPlugin(pluginContext));
  if (enabled('qqpd')) plugins.push(buildQqpdPlugin(pluginContext));
  if (enabled('idlefish')) plugins.push(buildIdlefishPlugin(pluginContext));
  if (enabled('youtube')) plugins.push(buildYoutubePlugin(pluginContext));
  if (enabled('kurobbs')) plugins.push(buildKurobbsPlugin(pluginContext));
  if (enabled('x')) plugins.push(buildXPlugin(pluginContext));
  if (enabled('coolapk')) plugins.push(buildCoolapkPlugin(pluginContext));
  if (enabled('heybox')) plugins.push(buildHeyboxPlugin(pluginContext));
  if (enabled('toutiao')) plugins.push(buildToutiaoPlugin(pluginContext));
  if (enabled('wechat')) plugins.push(buildWechatPlugin(pluginContext));
  if (enabled('lofter')) plugins.push(buildLofterPlugin(pluginContext));
  if (enabled('skland')) plugins.push(buildSklandPlugin(pluginContext));

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
