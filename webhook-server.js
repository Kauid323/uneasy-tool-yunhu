const express = require('express');
const app = express();
const PORT = 8000;

// 解析JSON请求体
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Webhook接收路径
app.post('/webhook', (req, res) => {
  console.log('=== 收到Webhook请求 ===');
  console.log('时间:', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  console.log('请求头:', JSON.stringify(req.headers, null, 2));
  console.log('请求体:', JSON.stringify(req.body, null, 2));
  console.log('========================\n');

  // 返回成功响应
  res.status(200).json({
    success: true,
    message: 'Webhook接收成功',
    timestamp: new Date().toISOString()
  });
});

// 健康检查路径
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Webhook服务器运行中',
    port: PORT
  });
});

// 根路径
app.get('/', (req, res) => {
  res.send(`
    <h1>Webhook接收端</h1>
    <p>服务器运行在端口 ${PORT}</p>
    <ul>
      <li>Webhook路径: POST /webhook</li>
      <li>健康检查: GET /health</li>
    </ul>
  `);
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`Webhook服务器已启动`);
  console.log(`监听端口: ${PORT}`);
  console.log(`Webhook路径: http://localhost:${PORT}/webhook`);
  console.log(`健康检查: http://localhost:${PORT}/health`);
});
