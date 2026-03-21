function buildWechatPlugin(ctx) {
  const { axios, fetchHtmlWithRedirect, safeJsonParse } = ctx;

  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

  const WECHAT_URL_RE = /https?:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_\-]+[^\s]*/i;

  function detect(text) {
    if (!text) return null;
    const m = String(text).match(WECHAT_URL_RE);
    if (!m) return null;
    return { platform: 'wechat', url: m[0] };
  }

  function pick(html, re) {
    const m = html.match(re);
    return m ? m[1] : '';
  }

  function htmlDecode(str) {
    return String(str || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#x2f;/gi, '/')
      .replace(/&#(\d+);/g, (match, code) => {
        const n = Number(code);
        return Number.isFinite(n) ? String.fromCodePoint(n) : match;
      })
      .replace(/&#x([0-9a-f]+);/gi, (match, code) => {
        const n = Number.parseInt(code, 16);
        return Number.isFinite(n) ? String.fromCodePoint(n) : match;
      });
  }

  function extractParams(html, url) {
    const biz = pick(html, /biz:\s*"([^"]+)"/) || pick(html, /__biz=([A-Za-z0-9+=/_-]+)/);
    const mid = pick(html, /mid:\s*"([^"]+)"/);
    const idx = pick(html, /idx:\s*"([^"]+)"/);
    const sn = pick(html, /sn:\s*"([^"]+)"/);
    const appmsgToken =
      pick(html, /appmsg_token\s*=\s*"([^"]*)"/) ||
      pick(html, /appmsg_token\s*:\s*"([^"]*)"/) ||
      '';

    let exportId = '';
    let username = '';
    let snapList = [];
    const snapRaw = pick(html, /var\s+video_snap_json\s*=\s*"([^"]+)"/);
    if (snapRaw) {
      const decoded = snapRaw.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      );
      const obj = safeJsonParse(decoded);
      if (obj && Array.isArray(obj.list) && obj.list.length > 0) {
        snapList = obj.list;
        exportId = obj.list[0]?.export_id || '';
        username = obj.list[0]?.username || '';
      }
    }

    const title = htmlDecode(pick(html, /<title[^>]*>(.*?)<\/title>/i) || '');

    const referer =
      biz && mid && idx && sn
        ? `https://mp.weixin.qq.com/s?__biz=${biz}&mid=${mid}&idx=${idx}&sn=${sn}&scene=21#wechat_redirect`
        : url;

    return { biz, mid, idx, sn, appmsgToken, exportId, username, snapList, referer, title };
  }

  function buildReplyText(target, params, apiData) {
    const info = apiData?.video_snap_info;
    const first = Array.isArray(info) ? info[0] : null;
    const eventInfo = Array.isArray(apiData?.event_info) ? apiData.event_info : [];
    const liveInfo = Array.isArray(apiData?.live_info) ? apiData.live_info : [];

    const lines = [];
    lines.push(`微信文章解析`);
    if (params.title) lines.push(`标题: ${params.title}`);
    lines.push(`链接: ${target.url}`);

    if (!first) {
      const extra = [];
      if (eventInfo.length) extra.push(`event_info: ${eventInfo.length}`);
      if (liveInfo.length) extra.push(`live_info: ${liveInfo.length}`);
      lines.push(`视频信息为空，可能需要登录态或文章无视频。${extra.length ? ` (${extra.join(', ')})` : ''}`);
      return lines.filter(Boolean).join('\n');
    }

    if (first.nickname) lines.push(`作者: ${first.nickname}`);
    if (first.desc) lines.push(`简介: ${String(first.desc).slice(0, 120)}`);
    if (first.feed_desc) lines.push(`描述: ${String(first.feed_desc).slice(0, 200)}`);
    if (first.feed_video_play_len_s)
      lines.push(`时长: ${Number(first.feed_video_play_len_s || 0)} 秒`);
    if (first.feed_thumb_url) lines.push(`封面: ${first.feed_thumb_url}`);
    if (first.feed_full_cover_url) lines.push(`大图: ${first.feed_full_cover_url}`);
    if (first.feed_width && first.feed_height)
      lines.push(`分辨率: ${first.feed_width}x${first.feed_height}`);
//    if (first.export_id) lines.push(`export_id: ${first.export_id}`);
//    if (first.username) lines.push(`username: ${first.username}`);

    return lines.filter(Boolean).join('\n');
  }

  async function process(target) {
    const { url } = target;
    const { html } = await fetchHtmlWithRedirect(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://mp.weixin.qq.com/',
        Accept: '*/*'
      }
    });

    if (!html) {
      return { target, replyText: '获取文章 HTML 失败' };
    }

    const params = extractParams(html, url);

    const query = {
      action: 'batch_get_video_snap',
      __biz: params.biz,
      wxtoken: '777',
      f: 'json',
      user_article_role: '0',
      appmsg_token: params.appmsgToken,
      mid: params.mid,
      idx: params.idx,
      video_snap_num: '1',
      uin: '',
      key: '',
      pass_ticket: ''
    };
    // use exportid_0 / username_0 for compatibility
    if (params.snapList && params.snapList.length) {
      query.video_snap_num = String(params.snapList.length);
      params.snapList.forEach((item, i) => {
        if (item?.export_id) query[`exportid_${i}`] = item.export_id;
        if (item?.username) query[`username_${i}`] = item.username;
      });
    } else {
      if (params.exportId) query.exportid_0 = params.exportId;
      if (params.username) query.username_0 = params.username;
    }

    const resp = await axios.get('https://mp.weixin.qq.com/mp/appmsg_video_snap', {
      params: query,
      headers: {
        'User-Agent': UA,
        Connection: 'keep-alive',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'sec-ch-ua-platform': '"Windows"',
        'x-requested-with': 'XMLHttpRequest',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        origin: 'https://mp.weixin.qq.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        referer: params.referer,
        'accept-language': 'zh-CN,zh;q=0.9,ko;q=0.8',
        cookie: 'wxtokenkey=777'
      },
      timeout: 20000
    });

    const data = typeof resp.data === 'string' ? safeJsonParse(resp.data) || resp.data : resp.data;

    const replyText = buildReplyText(target, params, data);
    return { target, replyText, params, data };
  }

  return {
    name: 'wechat',
    detect,
    process
  };
}

module.exports = { buildWechatPlugin };
