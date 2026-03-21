
// unfinished！！！！！

function buildIdlefishPlugin(ctx) {
  const { axios, crypto, config } = ctx;

  const POST_URL_RE =
    /https?:\/\/(?:h5|m)\.m?\.?goofish\.com\/[^\s]*[?&]postId=(\d+)/i;
  const SCHEME_RE = /fleamarket:\/\/item_note_fun\?[^\s]*postId=(\d+)/i;
  const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
  const APP_KEY = '12574478';
  const API = 'mtop.taobao.idle.fun.post.detail';
  const VERSION = '1.0';

  function getPluginConfig() {
    return config?.idlefish || {};
  }

  function getUserAgent() {
    return String(getPluginConfig().userAgent || DEFAULT_USER_AGENT);
  }

  function parseCookieString(cookieText) {
    const out = {};
    const source = String(cookieText || '').trim();
    if (!source) return out;
    for (const part of source.split(';')) {
      const item = String(part || '').trim();
      if (!item) continue;
      const eq = item.indexOf('=');
      if (eq <= 0) continue;
      out[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
    }
    return out;
  }

  function getManualCookieMap() {
    const raw = getPluginConfig().cookie;
    if (!raw) return {};
    if (typeof raw === 'string') return parseCookieString(raw);
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      const out = {};
      for (const [key, value] of Object.entries(raw)) {
        if (value !== undefined && value !== null && String(value) !== '') out[key] = String(value);
      }
      return out;
    }
    return {};
  }

  function parseJsonObjectInput(raw) {
    if (!raw) return {};
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  function getManualAntiCreepParams() {
    const merged = {
      ...parseJsonObjectInput(getPluginConfig().antiCreepParams),
      ...parseJsonObjectInput(getPluginConfig().antiCreepToken)
    };
    const out = {};
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== null && String(value) !== '') out[key] = value;
    }
    return out;
  }

  function detect(text) {
    if (!text) return null;
    const source = String(text);
    const urlMatch = source.match(POST_URL_RE);
    if (urlMatch) {
      return {
        platform: 'idlefish',
        type: 'post',
        postId: String(urlMatch[1]),
        url: urlMatch[0]
      };
    }

    const schemeMatch = source.match(SCHEME_RE);
    if (schemeMatch) {
      const postId = String(schemeMatch[1]);
      return {
        platform: 'idlefish',
        type: 'post',
        postId,
        url: `https://h5.m.goofish.com/app/idleFish-F2e/idle-post-details/pages/post-details/index.html?postId=${postId}`
      };
    }

    return null;
  }

  function md5(text) {
    return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
  }

  function parseSetCookie(headers) {
    const list = Array.isArray(headers?.['set-cookie']) ? headers['set-cookie'] : [];
    const out = {};
    for (const raw of list) {
      const first = String(raw || '').split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
    }
    return out;
  }

  function mergeCookieMaps(...maps) {
    return Object.assign({}, ...maps.filter(Boolean));
  }

  function buildCookieHeader(cookieMap) {
    return Object.entries(cookieMap || {})
      .filter(([key, value]) => key && value !== undefined && value !== null && String(value) !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  function getToken(cookieMap) {
    const raw = String(cookieMap?._m_h5_tk || '');
    return raw ? raw.split('_')[0] : '';
  }

  function buildDataString(postId) {
    return JSON.stringify({ postId: String(postId), platform: 'h5' });
  }

  function buildApiUrl(postId, token, extraParams = {}) {
    const data = buildDataString(postId);
    const t = String(Date.now());
    const sign = md5(`${token}&${t}&${APP_KEY}&${data}`);
    const url = new URL(`https://h5api.m.goofish.com/h5/${API}/${VERSION}/`);
    url.searchParams.set('jsv', '2.5.8');
    url.searchParams.set('appKey', APP_KEY);
    url.searchParams.set('t', t);
    url.searchParams.set('sign', sign);
    url.searchParams.set('api', API);
    url.searchParams.set('v', VERSION);
    url.searchParams.set('dataType', 'json');
    url.searchParams.set('valueType', 'original');
    url.searchParams.set('preventFallback', 'true');
    url.searchParams.set('type', 'originaljson');
    url.searchParams.set('data', data);
    for (const [key, value] of Object.entries(extraParams || {})) {
      if (value !== undefined && value !== null && String(value) !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  function buildHeaders(target, cookieMap) {
    const headers = {
      'User-Agent': getUserAgent(),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://h5.m.goofish.com',
      Referer: target?.url || 'https://h5.m.goofish.com/',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
      'sec-ch-ua-mobile': '?0',
      'sec-fetch-site': 'same-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'accept-language': 'zh-CN,zh;q=0.9,ko;q=0.8'
    };
    const cookieHeader = buildCookieHeader(cookieMap);
    if (cookieHeader) headers.Cookie = cookieHeader;
    return headers;
  }

  function normalizeRetList(ret) {
    return Array.isArray(ret) ? ret.map((item) => String(item || '')) : [];
  }

  function isSuccess(data) {
    return normalizeRetList(data?.ret).some((item) => item.startsWith('SUCCESS::'));
  }

  function needsTokenRetry(data) {
    return normalizeRetList(data?.ret).some((item) => item.includes('FAIL_SYS_TOKEN'));
  }

  function firstRet(data) {
    return normalizeRetList(data?.ret)[0] || '';
  }

  async function requestPostDetail(target) {
    let cookieMap = getManualCookieMap();
    const manualAntiCreepParams = getManualAntiCreepParams();
    const attempts = [];

    async function doRequest(token, extraParams = manualAntiCreepParams) {
      const resp = await axios.get(buildApiUrl(target.postId, token, extraParams), {
        timeout: 20000,
        validateStatus: () => true,
        headers: buildHeaders(target, cookieMap)
      });
      cookieMap = mergeCookieMaps(cookieMap, parseSetCookie(resp?.headers));
      const payload = typeof resp?.data === 'object' ? resp.data : {};
      attempts.push({
        status: Number(resp?.status || 0),
        ret: firstRet(payload)
      });
      return payload;
    }

    let payload = await doRequest('');
    if (!isSuccess(payload) && (needsTokenRetry(payload) || getToken(cookieMap))) {
      payload = await doRequest(getToken(cookieMap));
    }

    if (!isSuccess(payload) || !payload?.data?.postDetailDTO) {
      const summary = attempts.map((item, index) => `#${index + 1} status=${item.status} ret=${item.ret}`).join(' | ');
      throw new Error(`idlefish detail request failed${summary ? `: ${summary}` : ''}`);
    }

    return { payload, cookieMap, attempts };
  }

  async function fetchPage(url) {
    const resp = await axios.get(url, {
      timeout: 20000,
      validateStatus: (code) => code >= 200 && code < 400,
      headers: {
        'User-Agent': getUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://h5.m.goofish.com/'
      }
    });
    return typeof resp?.data === 'string' ? resp.data : '';
  }

  function extractMetaContent(html, key) {
    const source = String(html || '');
    const patternA = new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i');
    const patternB = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${key}["']`, 'i');
    const match = source.match(patternA) || source.match(patternB);
    return match && match[1] ? match[1] : '';
  }

  function stripBom(text) {
    return String(text || '').replace(/^\uFEFF/, '');
  }

  function formatTime(ts) {
    const n = Number(ts || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n).toLocaleString('zh-CN', { hour12: false });
  }

  function maskOrValue(value) {
    const s = String(value || '').trim();
    return s || '';
  }

  function parseDetail(payload, target) {
    const dto = payload?.data?.postDetailDTO || {};
    return {
      postId: String(dto?.postId || target.postId),
      title: String(dto?.postTitle || ''),
      content: stripBom(dto?.postContent || dto?.postContentFormat || ''),
      authorName: maskOrValue(dto?.encryptNick || ''),
      authorId: String(dto?.authorId || ''),
      avatar: String(dto?.avatar || ''),
      publishTime: formatTime(dto?.publishTimeStamp || dto?.createTimeStamp) || String(dto?.publishTime || ''),
      commentCount: Number(dto?.commentCnt || 0),
      likeCount: Number(dto?.favorCnt || 0),
      collectCount: Number(dto?.collectCnt || 0),
      qualityStr: String(dto?.qualityStr || ''),
      bizCode: String(dto?.bizCode || ''),
      images: (Array.isArray(dto?.images) ? dto.images : [])
        .map((item) => String(item?.url || ''))
        .filter(Boolean),
      comments: (Array.isArray(dto?.comments) ? dto.comments : [])
        .map((item) => ({
          author: String(item?.accountEncryptNick || ''),
          content: String(item?.msgContent || ''),
          likeCount: Number(item?.likeCounts || 0),
          time: String(item?.gmtCreate || '')
        }))
        .filter((item) => item.content),
      url: target.url
    };
  }

  function buildFallbackReply(target, html, reason = '') {
    const title = extractMetaContent(html, 'og:title') || '闲鱼帖子';
    const desc = extractMetaContent(html, 'og:description') || '';
    return [
      `闲鱼解析 (idlefish): ${target.postId}`,
      `标题: ${title}`,
      desc ? `简介: ${desc}` : null,
      `链接: ${target.url}`,
      `备注: 详情接口被风控拦截${reason ? ` (${reason})` : ''}，已回退到页面元信息`
    ].filter(Boolean).join('\n');
  }

  function buildReplyText(parsed) {
    const lines = [];
    lines.push(`闲鱼解析 (idlefish): ${parsed.postId}`);
    if (parsed.title) lines.push(`标题: ${parsed.title}`);
    if (parsed.authorName) lines.push(`作者: ${parsed.authorName}`);
    if (parsed.publishTime) lines.push(`发布时间: ${parsed.publishTime}`);
    if (parsed.qualityStr) lines.push(`质量分: ${parsed.qualityStr}`);

    const stats = [
      Number.isFinite(parsed.likeCount) ? `点赞: ${parsed.likeCount}` : null,
      Number.isFinite(parsed.collectCount) ? `收藏: ${parsed.collectCount}` : null,
      Number.isFinite(parsed.commentCount) ? `评论: ${parsed.commentCount}` : null
    ].filter(Boolean);
    if (stats.length) lines.push(stats.join(' / '));

    if (parsed.content) lines.push(`\n正文:\n${parsed.content}`);
    if (Array.isArray(parsed.images) && parsed.images.length) {
      lines.push(`图片(${parsed.images.length}):`);
      for (const imageUrl of parsed.images.slice(0, 9)) lines.push(imageUrl);
    }
    if (Array.isArray(parsed.comments) && parsed.comments.length) {
      lines.push('\n热评:');
      for (const comment of parsed.comments.slice(0, 3)) {
        const prefix = [comment.author, comment.likeCount > 0 ? `赞${comment.likeCount}` : '', comment.time]
          .filter(Boolean)
          .join(' / ');
        lines.push(prefix ? `${prefix}: ${comment.content}` : comment.content);
      }
    }
    if (parsed.url) lines.push(`链接: ${parsed.url}`);
    return lines.join('\n');
  }

  async function process(target) {
    try {
      const detail = await requestPostDetail(target);
      const parsed = parseDetail(detail.payload, target);
      return {
        target,
        parsed,
        detail: detail.payload,
        replyText: buildReplyText(parsed)
      };
    } catch (error) {
      const html = await fetchPage(target.url).catch(() => '');
      if (html) {
        return {
          target,
          parsed: null,
          detail: null,
          replyText: buildFallbackReply(
            target,
            html,
            String(error?.message || '').includes('RGV587') ? 'RGV587 / Baxia' : ''
          )
        };
      }
      throw error;
    }
  }

  return {
    name: 'idlefish',
    detect,
    process,
    helpers: {
      requestPostDetail,
      fetchPage
    }
  };
}

module.exports = { buildIdlefishPlugin };
