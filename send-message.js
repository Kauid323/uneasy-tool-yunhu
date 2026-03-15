
// For yhchat bot!!!!

const axios = require('axios');
const readline = require('readline');

// 设置 stdin 为 raw 模式以监听每个按键
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

// 发送消息函数
async function sendMessage(char) {
  const data = {
    "recvIds": [
      "7SACDC058262",
      "705SCSDCC8263"
    ],
    "recvType": "user",
    "contentType": "text",
    "content": {
      "text": char
    }
  };

  const options = {
    method: 'POST',
    url: 'https://chat-go.jwzhd.com/open-apis/v1/bot/send-stream?token=c74406a85d4a4e1d8366c811909702a1&recvId=8516939&recvType=user&contentType=text',
    headers: {
      'Content-Type': 'application/json'
    },
    data: data
  };

  try {
    const response = await axios(options);
    console.log(`\n✓ 发送成功: "${char}" ->`, response.data);
  } catch (error) {
    console.error(`\n✗ 发送失败: "${char}" ->`, error.message);
    if (error.response) {
      console.error('响应数据:', error.response.data);
    }
  }
}

// 主函数
function main() {
  console.log('=== 实时消息发送工具 ===');
  console.log('每输入一个字符就会自动发送到API');
  console.log('按 Ctrl+C 退出\n');
  console.log('开始输入:\n');

  process.stdin.on('keypress', async (str, key) => {
    // 处理 Ctrl+C 退出
    if (key && key.ctrl && key.name === 'c') {
      console.log('\n\n再见！');
      process.exit(0);
    }

    // 如果有字符输入
    if (str && str.length === 1) {
      // 显示输入的字符
      process.stdout.write(str);
      
      // 发送到API
      await sendMessage(str);
    }
  });
}

// 启动程序
main();

