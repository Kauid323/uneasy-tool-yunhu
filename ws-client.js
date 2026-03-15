const WebSocket = require('ws');
const protobuf = require('protobufjs');
const config = require('./config');

class ChatWSClient {
  constructor() {
    this.ws = null;
    this.heartbeatInterval = null;
    this.isConnected = false;
    this.root = null;
  }

  // 加载proto定义
  async loadProto() {
    try {
      this.root = await protobuf.load('./proto/chat_ws_go.proto');
      console.log('✓ Proto定义加载成功');
    } catch (error) {
      console.error('✗ Proto定义加载失败:', error.message);
      throw error;
    }
  }

  // 连接WebSocket
  async connect() {
    // 先加载proto
    await this.loadProto();
    
    console.log('正在连接到:', config.ws.url);
    
    this.ws = new WebSocket(config.ws.url);

    this.ws.on('open', () => {
      console.log('✓ WebSocket连接成功');
      this.isConnected = true;
      this.login();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      console.error('✗ WebSocket错误:', error.message);
    });

    this.ws.on('close', () => {
      console.log('✗ WebSocket连接已关闭');
      this.isConnected = false;
      this.stopHeartbeat();
      
      // 5秒后重连
      setTimeout(() => {
        console.log('尝试重新连接...');
        this.connect();
      }, 5000);
    });
  }

  // 登录
  login() {
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

    console.log('发送登录请求...');
    this.ws.send(JSON.stringify(loginData));
    
    // 登录后启动心跳
    setTimeout(() => {
      this.startHeartbeat();
    }, 1000);
  }

  // 启动心跳
  startHeartbeat() {
    console.log('启动心跳机制');
    
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected) {
        const heartbeatData = {
          seq: Date.now().toString(),
          cmd: 'heartbeat',
          data: {}
        };
        this.ws.send(JSON.stringify(heartbeatData));
        console.log('→ 发送心跳包');
      }
    }, 30000); // 每30秒发送一次心跳
  }

  // 停止心跳
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('停止心跳机制');
    }
  }

  // 处理接收到的消息
  handleMessage(data) {
    try {
      // 尝试解析为JSON
      try {
        const jsonData = JSON.parse(data.toString());
        console.log('\n=== JSON消息 ===');
        console.log(JSON.stringify(jsonData, null, 2));
        console.log('==================\n');
        return;
      } catch (e) {
        // 不是JSON，解析为ProtoBuf
      }

      // 解析ProtoBuf消息
      const bytes = new Uint8Array(data);
      
      // 尝试解析INFO
      const INFO = this.root.lookupType('yh_ws_go.INFO');
      
      // 先读取前面的INFO部分来判断消息类型
      let offset = 0;
      let cmd = '';
      let seq = '';
      
      // 简单解析：读取第一个字段（INFO）
      try {
        // 跳过第一个字段标记
        if (bytes[offset] === 0x0a) { // field 1, wire type 2 (length-delimited)
          offset++;
          const infoLength = bytes[offset];
          offset++;
          
          // 读取INFO内容
          const infoBytes = bytes.slice(offset, offset + infoLength);
          const info = INFO.decode(infoBytes);
          seq = info.seq;
          cmd = info.cmd;
          
          console.log(`\n=== 收到消息: ${cmd} ===`);
          console.log('序列:', seq);
        }
      } catch (e) {
        console.log('解析INFO失败:', e.message);
      }

      // 根据cmd类型解析不同的消息
      try {
        if (cmd === 'heartbeat_ack') {
          const HeartbeatAck = this.root.lookupType('yh_ws_go.heartbeat_ack');
          const message = HeartbeatAck.decode(bytes);
          const obj = HeartbeatAck.toObject(message);
          console.log('心跳响应:', JSON.stringify(obj, null, 2));
          
        } else if (cmd === 'push_message') {
          const PushMessage = this.root.lookupType('yh_ws_go.push_message');
          const message = PushMessage.decode(bytes);
          const obj = PushMessage.toObject(message);
          console.log('推送消息:', JSON.stringify(obj, null, 2));
          
        } else if (cmd === 'stream_message') {
          const StreamMessage = this.root.lookupType('yh_ws_go.stream_message');
          const message = StreamMessage.decode(bytes);
          const obj = StreamMessage.toObject(message);
          console.log('流式消息:', JSON.stringify(obj, null, 2));
          
        } else if (cmd === 'edit_message') {
          const EditMessage = this.root.lookupType('yh_ws_go.edit_message');
          const message = EditMessage.decode(bytes);
          const obj = EditMessage.toObject(message);
          console.log('编辑消息:', JSON.stringify(obj, null, 2));
          
        } else if (cmd === 'draft_input') {
          const DraftInput = this.root.lookupType('yh_ws_go.draft_input');
          const message = DraftInput.decode(bytes);
          const obj = DraftInput.toObject(message);
          console.log('草稿同步:', JSON.stringify(obj, null, 2));
          
        } else if (cmd === 'file_send_message') {
          const FileSendMessage = this.root.lookupType('yh_ws_go.file_send_message');
          const message = FileSendMessage.decode(bytes);
          const obj = FileSendMessage.toObject(message);
          console.log('文件分享:', JSON.stringify(obj, null, 2));
          
        } else if (cmd === 'bot_board_message') {
          const BotBoardMessage = this.root.lookupType('yh_ws_go.bot_board_message');
          const message = BotBoardMessage.decode(bytes);
          const obj = BotBoardMessage.toObject(message);
          console.log('机器人面板消息:', JSON.stringify(obj, null, 2));
          
        } else {
          console.log('未知消息类型:', cmd);
          console.log('原始字节:', Array.from(bytes.slice(0, 100)));
        }
      } catch (e) {
        console.error('解析消息失败:', e.message);
        console.log('原始字节:', Array.from(bytes.slice(0, 100)));
      }
      
      console.log('==================\n');

    } catch (error) {
      console.error('处理消息时出错:', error);
      console.error('错误堆栈:', error.stack);
    }
  }

  // 断开连接
  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
    }
  }
}

// 启动客户端
const client = new ChatWSClient();
client.connect().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});

// 处理退出
process.on('SIGINT', () => {
  console.log('\n正在断开连接...');
  client.disconnect();
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});
