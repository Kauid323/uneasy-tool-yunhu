const express = require('express');
const axios = require('axios');
const protobuf = require('protobufjs');
const WebSocket = require('ws');
const config = require('./config');
const { AccessToken, IngressClient } = require('livekit-server-sdk');

const app = express();
const PORT = 3001;

// LiveKit配置
const LIVEKIT_URL = 'wss://livekit.jwznb.com';
const LIVEKIT_API_KEY = 'your-api-key'; // 需要从云湖获取
const LIVEKIT_API_SECRET = 'your-api-secret'; // 需要从云湖获取

// WebSocket客户端
let wsClient = null;
let root = null;
let fileTransferCallbacks = new Map(); // 存储文件传输回调（key 可以是 session_id 或 userId_deviceId）
let pendingMessages = new Map(); // 存储待处理的消息

// 由于部分消息（尤其是 answer/reply）可能不携带 session_id（或 extract 失败），
// 这里维护 userId_deviceId -> session_id 的路由表，确保前端只监听 session_id 也能收到 answer。
let sessionByUserDevice = new Map(); // key: `${userId}_${deviceId}` => sessionId

app.use(express.json());
app.use(express.static('public'));

// 初始化WebSocket客户端
async function initWebSocket() {
  try {
    root = await protobuf.load('./proto/chat_ws_go.proto');
    console.log('Protobuf定义加载完成');
    
    const wsUrl = `wss://chat-ws-go.jwzhd.com/ws?userId=${config.ws.userId}&token=${config.ws.token}&platform=${config.ws.platform}&deviceId=${config.ws.deviceId}`;
    wsClient = new WebSocket(wsUrl);
    
    wsClient.on('open', () => {
      console.log('WebSocket连接成功');
      // 发送登录
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
      wsClient.send(JSON.stringify(loginData));
      
      // 启动心跳
      setInterval(() => {
        if (wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({
            seq: Date.now().toString(),
            cmd: 'heartbeat'
          }));
        }
      }, 30000);
    });
    
    wsClient.on('message', handleWSMessage);
    
    wsClient.on('close', () => {
      console.log('WebSocket连接关闭，5秒后重连');
      setTimeout(initWebSocket, 5000);
    });
    
    wsClient.on('error', (error) => {
      console.error('WebSocket错误:', error.message);
    });
  } catch (error) {
    console.error('初始化WebSocket失败:', error);
  }
}

// 处理WebSocket消息
function handleWSMessage(data) {
  try {
    // 尝试JSON
    try {
      const jsonData = JSON.parse(data.toString());
      console.log('[WS] JSON消息:', jsonData);
      return;
    } catch (e) {}
    
    // 解析protobuf
    const bytes = new Uint8Array(data);
    const INFO = root.lookupType('yh_ws_go.INFO');
    
    let offset = 0;
    let cmd = '';
    let seq = '';
    
    if (bytes[offset] === 0x0a) {
      offset++;
      const infoLength = bytes[offset];
      offset++;
      const infoBytes = bytes.slice(offset, offset + infoLength);
      const info = INFO.decode(infoBytes);
      seq = info.seq;
      cmd = info.cmd;
    }
    
    console.log(`[WS] 收到消息: cmd=${cmd}, seq=${seq}`);
    
    // 处理file_send_message
    if (cmd === 'file_send_message') {
      const FileSendMessage = root.lookupType('yh_ws_go.file_send_message');
      const message = FileSendMessage.decode(bytes);
      const obj = FileSendMessage.toObject(message, {
        longs: Number,
        enums: String,
        bytes: String
      });
      
      console.log('[WS] 文件传输消息:');
      console.log('  - sendType:', obj.data.sender.sendType);
      console.log('  - sendUserId:', obj.data.sender.sendUserId);
      console.log('  - userId:', obj.data.sender.userId);
      console.log('  - sendDeviceId:', obj.data.sender.sendDeviceId);

      // 提前解析 sender.data（如果存在），用于获取 session_id 及其它字段
      let parsedSenderData = null;
      try {
        if (obj?.data?.sender?.data) {
          parsedSenderData = JSON.parse(obj.data.sender.data);
        }
      } catch (e) {
        parsedSenderData = null;
      }

      // 如果 sender.data 里携带 session_id，则写入路由表，便于后续 answer 缺 session_id 时也能映射回去
      if (parsedSenderData?.session_id) {
        const userId = obj?.data?.sender?.userId;
        const sendDeviceId = obj?.data?.sender?.sendDeviceId;
        if (userId && sendDeviceId) {
          sessionByUserDevice.set(`${userId}_${sendDeviceId}`, parsedSenderData.session_id);
        }
      }
      
      // 处理send消息 - 对方发起文件传输请求
      if (obj.data.sender.sendType === 'send') {
        console.log('[WS] 收到send，对方发起文件传输请求');
        
        // 自动接受文件传输
        const sendData = JSON.parse(obj.data.sender.data);
        const sessionId = sendData.session_id;
        const sendUserId = obj.data.sender.sendUserId;
        const sendDeviceId = obj.data.sender.sendDeviceId;
        
        console.log('[WS] 自动接受文件传输，sessionId:', sessionId);
        console.log('[WS] 对方userId:', sendUserId, 'deviceId:', sendDeviceId);
        
        // 注册两个监听：
        // 1. sessionId - 用于接收offer和candidate
        // 2. userId+deviceId - 用于接收answer
        const userDeviceKey = `${sendUserId}_${sendDeviceId}`;
        
        fileTransferCallbacks.set(sessionId, (msg) => {
          console.log('[WS] [sessionId] 收到对方消息:', msg.data.sender.sendType);
        });
        
        fileTransferCallbacks.set(userDeviceKey, (msg) => {
          console.log('[WS] [userDevice] 收到对方消息:', msg.data.sender.sendType);
        });
        
        console.log('[WS] 已注册监听:', sessionId, userDeviceKey);
        
        // 调用 reply API 接受
        // 对齐 Dart: fileReplyApi(fs.sendDid, "1", fs.userId, fs.data)
        axios
          .post('http://localhost:3001/api/file/reply', {
            deviceId: sendDeviceId,
            isAccept: 1,
            userId: sendUserId,
            fileData: obj.data.sender.data
          })
          .then(() => {
            console.log('[WS] 已发送接受响应');
          })
          .catch((err) => {
            console.error('[WS] 发送接受响应失败:', err.message);
          });
        
        return;
      }
      
      // 处理reply消息 - 对方接受了文件传输请求
      if (obj.data.sender.sendType === 'reply') {
        console.log('[WS] 收到reply，对方已接受文件传输');
        // reply消息需要匹配到发送方的监听
        // 发送方使用userId_deviceId监听，但deviceId可能为空
        const userId = obj.data.sender.userId;
        
        // 尝试匹配所有可能的replyId
        const possibleIds = [
          `${userId}_`,  // deviceId为空
          `${userId}_${obj.data.sender.sendDeviceId}`  // 带deviceId
        ];
        
        console.log('[WS] 尝试匹配Reply ID:', possibleIds);
        
        let matched = false;
        for (const replyId of possibleIds) {
          if (fileTransferCallbacks.has(replyId)) {
            console.log('[WS] 触发reply回调:', replyId);
            fileTransferCallbacks.get(replyId)(obj);
            matched = true;
            break;
          }
        }
        
        if (!matched) {
          console.log('[WS] 没有找到reply回调，缓存消息');
          for (const replyId of possibleIds) {
            if (!pendingMessages.has(replyId)) {
              pendingMessages.set(replyId, []);
            }
            pendingMessages.get(replyId).push(obj);
          }
        }
        return;
      }
      
      // 提取 session_id（多数 offer/candidate 会携带；部分 reply/answer/offer 可能缺失）
      const sessionId = extractSessionId(obj);
      console.log('  - sessionId:', sessionId);

      const sendType = obj?.data?.sender?.sendType;
      const userId = obj?.data?.sender?.userId;
      const sendDeviceId = obj?.data?.sender?.sendDeviceId;
      const userDeviceKey = `${userId}_${sendDeviceId}`;

      // 维护路由表：只要我们能同时得到 userDeviceKey + sessionId，就记录下来
      if (sessionId && userId && sendDeviceId) {
        sessionByUserDevice.set(userDeviceKey, sessionId);
      }

      // offer 有时 sessionId 是 undefined（你日志里就出现了）。此时尝试用映射表补回 sessionId。
      const mappedSessionId = sessionByUserDevice.get(userDeviceKey);

      // 需要通知的 key：
      // - 优先通知 sessionId（前端 WebRTC 流程以 sessionId 监听）
      // - 同时也通知 userDeviceKey（兼容 reply/answer 只按 userId_deviceId 路由的情况）
      const keysToNotify = [];

      if (sessionId) keysToNotify.push(sessionId);

      // reply/answer/offer 有时没有 session_id；尝试通过路由表找到对应 sessionId
      if ((sendType === 'answer' || sendType === 'reply' || sendType === 'offer') && userId && sendDeviceId) {
        keysToNotify.push(userDeviceKey);
        if (mappedSessionId) keysToNotify.push(mappedSessionId);
      }

      // 去重
      const uniqueKeys = Array.from(new Set(keysToNotify.filter(Boolean)));

      let delivered = false;
      for (const key of uniqueKeys) {
        if (fileTransferCallbacks.has(key)) {
          console.log('[WS] 触发回调: key=' + key);
          fileTransferCallbacks.get(key)(obj);
          delivered = true;
        }
      }

      if (!delivered) {
        const fallbackKey = uniqueKeys[0] || null;
        console.log('[WS] 没有找到回调: key=' + fallbackKey);
        console.log('[WS] 当前回调列表:', Array.from(fileTransferCallbacks.keys()));

        for (const key of uniqueKeys) {
          if (!pendingMessages.has(key)) {
            pendingMessages.set(key, []);
          }
          pendingMessages.get(key).push(obj);
        }

        if (uniqueKeys.length > 0) {
          console.log('[WS] 消息已缓存，等待SSE连接');
        }
      }
    }
  } catch (error) {
    console.error('[WS] 处理消息失败:', error);
  }
}

// 提取 session_id
function extractSessionId(obj) {
  try {
    if (obj?.data?.sender?.data) {
      const data = JSON.parse(obj.data.sender.data);
      return data.session_id || null;
    }
  } catch (e) {
    console.log('[WS] 解析data失败:', e.message);
  }

  return null;
}

// 启动WebSocket
initWebSocket();

// 获取会话列表
app.get('/api/conversations', async (req, res) => {
  try {
    const response = await axios.post(
      'https://chat-go.jwzhd.com/v1/conversation/list',
      null,
      {
        headers: {
          'token': config.ws.token
        },
        responseType: 'arraybuffer'
      }
    );

    // 使用protobufjs解析
    const root = await protobuf.load('./proto/conversation.proto');
    const ConversationList = root.lookupType('yh_conversation.ConversationList');
    
    const bytes = new Uint8Array(response.data);
    const message = ConversationList.decode(bytes);
    const obj = ConversationList.toObject(message, {
      longs: Number,
      enums: String,
      bytes: String,
      defaults: false
    });
    
    res.json(obj);
  } catch (error) {
    console.error('获取会话列表失败:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应数据:', error.response.data);
    }
    res.status(500).json({ error: error.message });
  }
});

// 获取在线设备列表
app.get('/api/user/devices', async (req, res) => {
  try {
    const response = await axios.get(
      'https://chat-go.jwzhd.com/v1/user/clients',
      {
        headers: {
          'token': config.ws.token
        },
        responseType: 'arraybuffer'
      }
    );

    // 使用protobufjs解析
    const userRoot = await protobuf.load('./proto/user.proto');
    const OnlineDevicesResponse = userRoot.lookupType('yh_user.OnlineDevicesResponse');
    
    const bytes = new Uint8Array(response.data);
    const message = OnlineDevicesResponse.decode(bytes);
    const obj = OnlineDevicesResponse.toObject(message, {
      longs: Number,
      enums: String,
      bytes: String,
      defaults: false
    });
    
    res.json(obj);
  } catch (error) {
    console.error('获取在线设备列表失败:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应数据:', error.response.data);
    }
    res.status(500).json({ error: error.message });
  }
});

// 获取群聊语音房间
app.post('/api/live/rooms', async (req, res) => {
  try {
    const { groupId } = req.body;
    const response = await axios.post(
      'https://chat-go.jwzhd.com/v1/group/live-room',
      { groupId },
      {
        headers: {
          'token': config.ws.token,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('获取语音房间失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 获取语音房间加入token
app.post('/api/live/join', async (req, res) => {
  try {
    const { roomId, chatId } = req.body;
    const response = await axios.post(
      'https://chat-go.jwzhd.com/v1/live/add',
      { roomId, chatId },
      {
        headers: {
          'token': config.ws.token,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('获取加入token失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 获取房间详情
app.post('/api/live/room-info', async (req, res) => {
  try {
    const { roomId } = req.body;
    const response = await axios.post(
      'https://chat-go.jwzhd.com/v1/live/room-info',
      { roomId },
      {
        headers: {
          'token': config.ws.token,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('获取房间详情失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 发送超级文件分享申请
app.post('/api/file/send', async (req, res) => {
  try {
    const { userId, deviceId, fileData } = req.body;
    const response = await axios.post(
      'https://chat-go.jwzhd.com/v1/file/send',
      { userId, deviceId, fileData },
      {
        headers: {
          'token': config.ws.token,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('发送文件分享申请失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 拒绝超级文件分享
app.post('/api/file/reply', async (req, res) => {
  try {
    const { deviceId, isAccept, userId, fileData } = req.body;
    const response = await axios.post(
      'https://chat-go.jwzhd.com/v1/file/reply',
      { deviceId, isAccept, userId, fileData },
      {
        headers: {
          'token': config.ws.token,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('拒绝文件分享失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 建立超级文件分享连接
app.post('/api/file/offer', async (req, res) => {
  try {
    const { deviceId, description, userId, sessionId } = req.body;

    // 记录路由：userId_deviceId -> sessionId（用于 answer 可能缺 session_id 的兜底）
    if (userId && deviceId && sessionId) {
      sessionByUserDevice.set(`${userId}_${deviceId}`, sessionId);
    }

    const response = await axios.post(
      'https://chat-go.jwzhd.com/v1/file/offer',
      { deviceId, description, userId, sessionId },
      {
        headers: {
          token: config.ws.token,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('建立文件分享连接失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 接收方发送 answer
app.post('/api/file/answer', async (req, res) => {
  try {
    const { deviceId, description, userId, sessionId } = req.body;

    // 同样记录一次路由，便于后续 candidate/answer 的关联
    if (userId && deviceId && sessionId) {
      sessionByUserDevice.set(`${userId}_${deviceId}`, sessionId);
    }

    const response = await axios.post(
      'https://chat-go.jwzhd.com/v1/file/answer',
      { deviceId, description, userId, sessionId },
      {
        headers: {
          token: config.ws.token,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('发送文件分享 answer 失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 发送ICE candidate
app.post('/api/file/candidate', async (req, res) => {
  try {
    const { deviceId, data, userId } = req.body;
    const response = await axios.post(
      'https://chat-go.jwzhd.com/v1/file/candidate',
      { deviceId, data, userId },
      {
        headers: {
          'token': config.ws.token,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('发送ICE candidate失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 监听文件传输消息（SSE）
app.get('/api/file/listen/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  console.log('[SSE] 新连接: sessionId=' + sessionId);
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // 注册回调
  const callback = (data) => {
    console.log('[SSE] 发送数据: sessionId=' + sessionId);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  
  fileTransferCallbacks.set(sessionId, callback);
  console.log('[SSE] 回调已注册: sessionId=' + sessionId);
  console.log('[SSE] 当前回调数量:', fileTransferCallbacks.size);
  
  // 发送缓存的消息
  if (pendingMessages.has(sessionId)) {
    const messages = pendingMessages.get(sessionId);
    console.log('[SSE] 发送缓存的消息:', messages.length);
    messages.forEach(msg => callback(msg));
    pendingMessages.delete(sessionId);
  }
  
  // 客户端断开时清理
  req.on('close', () => {
    fileTransferCallbacks.delete(sessionId);
    console.log('[SSE] 连接关闭: sessionId=' + sessionId);
    console.log('[SSE] 剩余回调数量:', fileTransferCallbacks.size);
  });
});

// 获取待处理的session列表
app.get('/api/file/pending-sessions', (req, res) => {
  const sessions = Array.from(pendingMessages.keys()).map(sessionId => ({
    sessionId,
    messageCount: pendingMessages.get(sessionId).length
  }));
  res.json({ sessions });
});

// 创建WHIP ingress
app.post('/api/live/create-whip-ingress', async (req, res) => {
  try {
    const { roomName, participantName } = req.body;
    
    // 创建ingress客户端
    const ingressClient = new IngressClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    
    // 创建WHIP ingress
    const ingress = await ingressClient.createIngress({
      inputType: 'WHIP_INPUT',
      name: participantName || 'WHIP Stream',
      roomName: roomName,
      participantIdentity: participantName || 'whip-participant',
      participantName: participantName || 'WHIP推流',
      audio: {
        source: 'MICROPHONE'
      },
      video: {
        source: 'CAMERA'
      }
    });
    
    res.json({
      code: 1,
      data: {
        ingressId: ingress.ingressId,
        url: ingress.url,
        streamKey: ingress.streamKey
      }
    });
  } catch (error) {
    console.error('创建WHIP ingress失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 获取ingress列表
app.get('/api/live/list-ingress', async (req, res) => {
  try {
    const { roomName } = req.query;
    
    const ingressClient = new IngressClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const ingressList = await ingressClient.listIngress({ roomName });
    
    res.json({
      code: 1,
      data: ingressList
    });
  } catch (error) {
    console.error('获取ingress列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 删除ingress
app.post('/api/live/delete-ingress', async (req, res) => {
  try {
    const { ingressId } = req.body;
    
    const ingressClient = new IngressClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await ingressClient.deleteIngress(ingressId);
    
    res.json({
      code: 1,
      msg: '删除成功'
    });
  } catch (error) {
    console.error('删除ingress失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Web UI服务器运行在 http://localhost:${PORT}`);
});
