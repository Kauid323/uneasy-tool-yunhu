const bcrypt = require('bcryptjs');

function buildCoolapkPlugin(ctx) {
  const { axios, crypto } = ctx;

  const COOLAPK_CONSTANTS = {
    REQUEST_WITH: 'XMLHttpRequest',
    LOCALE: 'zh-CN',
    APP_ID: 'com.coolapk.market',
    DARK_MODE: '0',
    CHANNEL: 'coolapk',
    MODE: 'universal',
    APP_LABEL: 'token://com.coolapk.market/dcf01e569c1e3db93a3d0fcf191a622c',
    VERSION_NAME: '13.4.1',
    API_VERSION: '13',
    VERSION_CODE: '2312121'
  };

  function detect(text) {
    if (!text) return null;
    const s = String(text);

    const detailCmd = s.match(/\/coolapk-detail-(\d+)/i);
    if (detailCmd) {
      return {
        platform: 'coolapk',
        type: 'feed_detail',
        id: detailCmd[1],
        url: `https://www.coolapk.com/feed/${detailCmd[1]}`
      };
    }

    const feedUrl = s.match(/(?:coolapk\.com|m\.coolapk\.com)\/feed\/(\d+)/i)
      || s.match(/(?:coolapk\.com|m\.coolapk\.com)\/t\/(\d+)/i)
      || s.match(/(?:coolapk\.com|m\.coolapk\.com)\/link\?url=[^\s]*feed%2F(\d+)/i)
      || s.match(/\bfeed\/(\d{5,})\b/i);
    if (feedUrl) {
      return {
        platform: 'coolapk',
        type: 'feed_detail',
        id: feedUrl[1],
        url: feedUrl[0].startsWith('http') ? feedUrl[0] : `https://www.coolapk.com/feed/${feedUrl[1]}`
      };
    }

    return null;
  }

  function getBase64(input) {
    return Buffer.from(String(input), 'utf8').toString('base64').replace(/=/g, '');
  }

  function md5(input) {
    return crypto.createHash('md5').update(String(input)).digest('hex').replace(/-/g, '');
  }

  function encodeDevice(deviceInfo) {
    const base64Str = Buffer.from(String(deviceInfo), 'utf8').toString('base64');
    const reversed = base64Str.split('').reverse().join('');
    return reversed.replace(/(\r\n|\r|\n|=)/g, '');
  }

  function buildDeviceSeed() {
    return '1A2B3C4D5E6F7890; ; ; 02:00:00:00:00:00; Xiaomi; Xiaomi; 22041211AC; RKQ1.211001.001; null';
  }

  function buildXAppDevice() {
    return encodeDevice(buildDeviceSeed());
  }

  function buildUserAgent() {
    return `Dalvik/2.1.0 (Linux; U; Android 13; 22041211AC RKQ1.211001.001) (#Build; Xiaomi; 22041211AC; RKQ1.211001.001; 13) +CoolMarket/${COOLAPK_CONSTANTS.VERSION_NAME}-${COOLAPK_CONSTANTS.VERSION_CODE}-${COOLAPK_CONSTANTS.MODE}`;
  }

  function buildXAppToken(xAppDevice) {
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const base64TimeStamp = getBase64(timeStamp);
    const md5TimeStamp = md5(timeStamp);
    const md5DeviceCode = md5(xAppDevice);
    const token = `${COOLAPK_CONSTANTS.APP_LABEL}?${md5TimeStamp}$${md5DeviceCode}&${COOLAPK_CONSTANTS.APP_ID}`;
    const base64Token = getBase64(token);
    const md5Base64Token = md5(base64Token);
    const md5Token = md5(token);
    const bcryptSalt = `${(`$2a$10$${base64TimeStamp}/${md5Token}`).substring(0, 31)}u`;
    const bcryptResult = bcrypt.hashSync(md5Base64Token, bcryptSalt);
    return `v2${getBase64(bcryptResult.replace(/^\$2a/, '$2y'))}`;
  }

  function buildCookie() {
    return 'SESSID=undefined';
  }

  function buildHeaders(extra = {}) {
    const xAppDevice = buildXAppDevice();
    const userAgent = buildUserAgent();
    const token = buildXAppToken(xAppDevice);
    return {
      'User-Agent': userAgent,
      'X-Requested-With': COOLAPK_CONSTANTS.REQUEST_WITH,
      'X-Sdk-Int': '33',
      'X-Sdk-Locale': COOLAPK_CONSTANTS.LOCALE,
      'X-App-Id': COOLAPK_CONSTANTS.APP_ID,
      'X-App-Token': token,
      'X-App-Version': COOLAPK_CONSTANTS.VERSION_NAME,
      'X-App-Code': COOLAPK_CONSTANTS.VERSION_CODE,
      'X-Api-Version': COOLAPK_CONSTANTS.API_VERSION,
      'X-App-Device': xAppDevice,
      'X-Dark-Mode': COOLAPK_CONSTANTS.DARK_MODE,
      'X-App-Channel': COOLAPK_CONSTANTS.CHANNEL,
      'X-App-Mode': COOLAPK_CONSTANTS.MODE,
      'X-App-Supported': COOLAPK_CONSTANTS.VERSION_CODE,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: buildCookie(),
      Origin: 'https://www.coolapk.com',
      Referer: extra.Referer || 'https://www.coolapk.com/',
      Accept: 'application/json, text/plain, */*',
      ...extra
    };
  }

  function logRequest(target, headers) {
    console.log('[coolapk] feed detail request target:');
    console.log(JSON.stringify(target, null, 2));
    console.log('[coolapk] feed detail request headers:');
    console.log(JSON.stringify(headers, null, 2));
  }

  function logResponse(data) {
    console.log('[coolapk] feed detail response:');
    console.log(JSON.stringify(data, null, 2));
  }

  function logAxiosError(error) {
    console.log('[coolapk] request failed');
    console.log('[coolapk] error message:', error?.message || error);
    if (error?.config) {
      console.log('[coolapk] request url:', error.config.url || '');
      console.log('[coolapk] request params:');
      console.log(JSON.stringify(error.config.params || {}, null, 2));
      console.log('[coolapk] request headers:');
      console.log(JSON.stringify(error.config.headers || {}, null, 2));
    }
    if (error?.response) {
      console.log('[coolapk] response status:', error.response.status);
      console.log('[coolapk] response headers:');
      console.log(JSON.stringify(error.response.headers || {}, null, 2));
      console.log('[coolapk] response body type:', typeof error.response.data);
      console.log('[coolapk] response body raw:');
      console.log(error.response.data);
      console.log('[coolapk] response body json:');
      console.log(JSON.stringify(error.response.data || {}, null, 2));
    }
  }

  async function fetchFeedDetail(id) {
    const headers = buildHeaders({ Referer: `https://www.coolapk.com/feed/${id}` });
    const params = { id: String(id) };
    logRequest({ id, params }, headers);
    try {
      const resp = await axios.get('https://api.coolapk.com/v6/feed/detail', {
        params,
        headers,
        timeout: 20000,
        responseType: 'text',
        transformResponse: [(v) => v],
        validateStatus: () => true
      });
      logResponse(resp.data);
      if (resp.status >= 400) {
        const err = new Error(`coolapk status ${resp.status}`);
        err.response = resp;
        err.config = { url: 'https://api.coolapk.com/v6/feed/detail', params, headers };
        throw err;
      }
      let parsed;
      try {
        parsed = JSON.parse(resp.data);
      } catch {
        throw new Error('coolapk response is not valid json');
      }
      return parsed;
    } catch (error) {
      logAxiosError(error);
      throw error;
    }
  }

  function stripHtml(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizePicArr(picArr) {
    if (Array.isArray(picArr)) return picArr.filter(Boolean);
    if (typeof picArr === 'string' && picArr.trim()) {
      return picArr.split(',').map((x) => x.trim()).filter(Boolean);
    }
    return [];
  }

  function parseFeedDetail(data) {
    const item = data?.data || {};
    const pics = normalizePicArr(item?.picArr);
    const message = stripHtml(item?.message || item?.infoHtml || '');
    const replyRows = Array.isArray(item?.replyRows) ? item.replyRows : [];
    const hotReplies = replyRows.slice(0, 3).map((reply) => {
      const name = reply?.username || reply?.userInfo?.username || '未知';
      const text = stripHtml(reply?.message || '').slice(0, 120);
      return `${name}: ${text}${text.length >= 120 ? '...' : ''}`;
    });

    return {
      id: item?.id ? String(item.id) : '',
      title: item?.title || item?.messageTitle || '',
      message,
      username: item?.username || item?.userInfo?.username || '',
      uid: item?.uid || item?.userInfo?.uid || '',
      userAvatar: item?.userAvatar || item?.userInfo?.userAvatar || '',
      deviceTitle: item?.deviceTitle || '',
      feedType: item?.feedType || '',
      feedTypeName: item?.feedTypeName || '',
      likenum: item?.likenum || '0',
      commentnum: item?.commentnum || item?.commentNum || '0',
      forwardnum: item?.forwardnum || '0',
      replynum: item?.replynum || '0',
      dateline: item?.dateline || item?.createTime || '',
      url: item?.url ? `https://www.coolapk.com${item.url}` : `https://www.coolapk.com/feed/${item?.id || ''}`,
      pics,
      cover: item?.pic || item?.messageCover || pics[0] || '',
      targetType: item?.targetType || '',
      targetTypeTitle: item?.targetTypeTitle || '',
      extraTitle: item?.extraTitle || '',
      extraUrl: item?.extraUrl || '',
      extraPic: item?.extraPic || '',
      ttitle: item?.ttitle || '',
      relationRows: Array.isArray(item?.relationRows) ? item.relationRows : [],
      hotReplies
    };
  }

  function buildReplyText(parsed) {
    const summary = (parsed.message || '').slice(0, 1500);
    const lines = [
      `酷安帖子解析 (coolapk): ${parsed.id}`,
      parsed.title ? `标题: ${parsed.title}` : null,
      parsed.username ? `作者: ${parsed.username}` : null,
      parsed.uid ? `UID: ${parsed.uid}` : null,
      parsed.feedTypeName ? `类型: ${parsed.feedTypeName}` : parsed.feedType ? `类型: ${parsed.feedType}` : null,
      parsed.deviceTitle ? `设备: ${parsed.deviceTitle}` : null,
      parsed.likenum ? `点赞: ${parsed.likenum}` : null,
      parsed.commentnum ? `评论: ${parsed.commentnum}` : null,
      parsed.replynum ? `回复: ${parsed.replynum}` : null,
      parsed.forwardnum ? `转发: ${parsed.forwardnum}` : null,
      parsed.targetTypeTitle ? `目标类型: ${parsed.targetTypeTitle}` : parsed.targetType ? `目标类型: ${parsed.targetType}` : null,
      parsed.dateline ? `时间: ${parsed.dateline}` : null,
      parsed.userAvatar ? `头像: ${parsed.userAvatar}` : null,
      parsed.cover ? `封面: ${parsed.cover}` : null,
      summary ? `正文:\n${summary}${parsed.message.length > summary.length ? '...' : ''}` : null
    ].filter(Boolean);

    if (parsed.pics.length) {
      lines.push(`图片数: ${parsed.pics.length}`);
      for (const pic of parsed.pics.slice(0, 9)) {
        lines.push(`图片: ${pic}`);
      }
      if (parsed.pics.length > 9) lines.push('(仅展示前9张)');
    }

    if (parsed.extraTitle || parsed.extraUrl) {
      lines.push(`附加卡片: ${[parsed.extraTitle, parsed.extraUrl].filter(Boolean).join(' ')}`.trim());
    }

    if (Array.isArray(parsed.relationRows) && parsed.relationRows.length) {
      lines.push('关联对象:');
      for (const row of parsed.relationRows.slice(0, 5)) {
        lines.push([
          row?.title || '(无标题)',
          row?.entityType ? `[${row.entityType}]` : '',
          row?.url || ''
        ].filter(Boolean).join(' '));
      }
      if (parsed.relationRows.length > 5) lines.push('(仅展示前5个关联对象)');
    }

    if (parsed.hotReplies.length) {
      lines.push('热评/回复预览:');
      for (const reply of parsed.hotReplies) lines.push(reply);
    }

    if (parsed.ttitle) lines.push(`话题: ${parsed.ttitle}`);
    lines.push(`链接: ${parsed.url}`);
    return lines.join('\n');
  }

  async function process(target) {
    const data = await fetchFeedDetail(target.id);
    if (Number(data?.status) !== 1 && Number(data?.messageStatus) !== 1 && data?.data == null) {
      throw new Error(data?.message || '获取酷安帖子详情失败');
    }
    const parsed = parseFeedDetail(data);
    const replyText = buildReplyText(parsed);
    return { target, parsed, replyText };
  }

  return {
    name: 'coolapk',
    detect,
    process,
    helpers: {
      fetchFeedDetail,
      parseFeedDetail,
      buildReplyText,
      stripHtml,
      normalizePicArr,
      buildHeaders,
      buildXAppToken,
      buildXAppDevice,
      encodeDevice
    }
  };
}

module.exports = { buildCoolapkPlugin };
