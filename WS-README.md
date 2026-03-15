# WebSocket客户端使用说明

## 配置

在 [`config.js`](config.js:1) 中配置你的连接信息：

```javascript
module.exports = {
  ws: {
    url: 'wss://chat-ws-go.jwzhd.com/ws',
    userId: '你的用户ID',
    token: '你的token',
    platform: 'windows',
    deviceId: '设备ID'
  }
};
```

## 启动WebSocket客户端

```bash
npm install
npm run ws
```

## 功能说明

- 自动连接到WebSocket服务器
- 自动登录云湖账号
- 自动发送心跳包（每30秒）
- 接收并解析各种消息类型：
  - 推送消息（push_message）
  - 流式消息（stream_message）
  - 编辑消息（edit_message）
  - 草稿同步（draft_input）
  - 心跳响应（heartbeat_ack）
- 断线自动重连（5秒后）

## 消息处理

客户端会自动解析ProtoBuf格式的消息，并在控制台输出详细信息：

- 消息ID
- 发送者信息
- 消息内容
- 时间戳
- 等等

按 `Ctrl+C` 可以安全退出程序。
