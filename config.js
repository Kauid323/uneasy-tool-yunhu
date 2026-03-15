module.exports = {
  // WebSocket配置
  ws: {
    url: 'wss://chat-ws-go.jwzhd.com/ws',
    userId: 'ur user id',
    token: 'ur user token',
    platform: 'windows',
    deviceId: 'ur device id'
  },

  // 上传配置（供 upload-media.js 使用）
  upload: {
    image: {
      // 需要安装可选依赖 sharp：npm i sharp
      webp: {
        enabled: false,
        quality: 95
      }
    }
  },

  // 插件解析开关
  plugins: {
    ncm: true,
    douyin: true,
    kuaishou: true,
    rednote: true,
    bilibili: true,
    tieba: true,
    miyoushe: true,
    youtube: false,
    kurobbs: true,
    x: false,
    coolapk: true,
    heybox: true,
    toutiao: true
  }
};
