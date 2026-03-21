module.exports = {
  // WebSocket配置
  ws: {
    url: 'wss://chat-ws-go.jwzhd.com/ws',
    userId: 'your user id',
    token: 'your token',
    platform: 'windows',
    deviceId: 'your device id'
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
    zhihu: true,
    qqpd: true,
    idlefish: false,
    miyoushe: true,
    youtube: false,
    kurobbs: true,
    x: false,
    coolapk: true,
    heybox: true,
    toutiao: true,
    wechat: true,
    lofter: true,
    skland: true
  },

  zhihu: {
    d_c0: '',
    z_c0: '2|1:0|10:1773551109|4:z_c0|92:Mi4xR0RjalJ3QUFBQUJXazFSYTBUbUhHeZMZ0NQUExoTU8yc2xn|155a59a47db91345f160ba8a964bd68e683fb2847f3ad403e8af6cbdd1fba8e9',
    q_c1: '',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
  },

  qqpd: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
  },

  idlefish: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    cookie: '',
    antiCreepParams: ''
  }
};
