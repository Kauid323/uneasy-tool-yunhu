// nonebot-plugin-parser (lite)
function buildHeyboxPlugin(ctx) {
  const { axios, crypto, formatNum } = ctx;

  const BASE_URL = 'api.xiaoheihe.cn';
  const PATH = '/bbs/app/link/tree';

  function md5(input) {
    return crypto.createHash('md5').update(String(input)).digest('hex');
  }

  function getNonce(time) {
    return md5(String(time)).toUpperCase();
  }

  function vm(e) {
    return (e & 0x80) ? (((e << 1) & 0xff) ^ 27) : ((e << 1) & 0xff);
  }

  function qm(e) {
    return vm(e) ^ e;
  }

  function mm(e) {
    return qm(vm(e));
  }

  function ym(e) {
    return mm(qm(vm(e)));
  }

  function gm(e) {
    return ym(e) ^ mm(e) ^ qm(e);
  }

  function km(arr) {
    const e = Array.isArray(arr) ? arr.slice() : [];
    const t0 = gm(e[0]) ^ ym(e[1]) ^ mm(e[2]) ^ qm(e[3]);
    const t1 = qm(e[0]) ^ gm(e[1]) ^ ym(e[2]) ^ mm(e[3]);
    const t2 = mm(e[0]) ^ qm(e[1]) ^ gm(e[2]) ^ ym(e[3]);
    const t3 = ym(e[0]) ^ mm(e[1]) ^ qm(e[2]) ^ gm(e[3]);
    e[0] = t0;
    e[1] = t1;
    e[2] = t2;
    e[3] = t3;
    return e;
  }

  function av(e, t, n) {
    const i = String(t || '').slice(0, n);
    if (!i) return '';
    let out = '';
    for (const ch of String(e || '')) {
      const idx = ch.charCodeAt(0) % i.length;
      out += i[idx];
    }
    return out;
  }

  function sv(e, t) {
    if (!t) return '';
    let out = '';
    for (const ch of String(e || '')) {
      out += t[ch.charCodeAt(0) % t.length];
    }
    return out;
  }

  function interleaveJs(arr) {
    const list = Array.isArray(arr) ? arr : [];
    if (!list.length) return '';
    const maxLen = Math.max(...list.map((s) => String(s).length));
    let out = '';
    for (let i = 0; i < maxLen; i += 1) {
      for (const item of list) {
        const str = String(item || '');
        if (i < str.length) out += str[i];
      }
    }
    return out;
  }

  function getHkey(time) {
    const e = PATH;
    const t = time + 1;
    const n = getNonce(time);
    const parts = e.split('/').filter(Boolean);
    const eNorm = `/${parts.join('/')}/`;
    const r = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';
    const iStr = interleaveJs([
      av(String(t), r, -2),
      sv(eNorm, r),
      sv(n, r)
    ]).slice(0, 20);
    const o = md5(iStr);
    const last6 = o.slice(-6);
    const arr = last6.split('').map((ch) => ch.charCodeAt(0));
    const mixed = km(arr);
    const total = mixed.reduce((acc, cur) => acc + cur, 0);
    const aVal = total % 100;
    const a = String(aVal).padStart(2, '0');
    const s = av(o.slice(0, 5), r, -4);
    return `${s}${a}`;
  }

  function buildUrl(linkId) {
    const time = Math.floor(Date.now() / 1000);
    return `https://${BASE_URL}${PATH}`
      + `?os_type=web&app=heybox&client_type=web&version=999.0.4&_time=${time}`
      + `&nonce=${getNonce(time)}&hkey=${getHkey(time)}&link_id=${linkId}`
      + '&page=1&index=1&limit=5&x_client_type=weboutapp&x_app=heybox_website&x_os_type=Windows&web_version=2.5';
  }

  function detect(text) {
    if (!text) return null;
    const s = String(text);
    const m1 = s.match(/api\.xiaoheihe\.cn\/v3\/bbs\/app\/api\/web\/share\?[^\s]*\blink_id=([A-Za-z0-9]+)/i);
    if (m1) return { platform: 'heybox', linkId: m1[1], url: m1[0] };

    const m2 = s.match(/xiaoheihe\.cn\/bbs\/post_share\?[^\s]*\blink_id=([A-Za-z0-9]+)/i);
    if (m2) return { platform: 'heybox', linkId: m2[1], url: m2[0] };

    const m3 = s.match(/xiaoheihe\.cn\/app\/bbs\/link\/([A-Za-z0-9]+)/i);
    if (m3) return { platform: 'heybox', linkId: m3[1], url: m3[0] };

    return null;
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

  function extractImagesFromHtml(html) {
    const content = String(html || '');
    const urls = [];
    const regex = /<img[^>]+>/gi;
    const attrsRegex = /(data-original|data-actualsrc|data-default-watermark-src|src)=["']([^"']+)["']/gi;
    let m;
    while ((m = regex.exec(content))) {
      const tag = m[0];
      let attr;
      while ((attr = attrsRegex.exec(tag))) {
        if (attr[2]) {
          urls.push(attr[2]);
          break;
        }
      }
    }
    return urls;
  }

  function parseLinkContent(link) {
    let contentText = '';
    const imageUrls = [];
    const rawText = link?.text;

    if (rawText) {
      try {
        const parts = JSON.parse(rawText);
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part?.type === 'html') {
              const htmlText = stripHtml(part?.text || '');
              if (htmlText) contentText += `${htmlText}\n`;
              imageUrls.push(...extractImagesFromHtml(part?.text || ''));
            } else if (part?.type === 'text') {
              const t = String(part?.text || '').trim();
              if (t) contentText += `${t}\n`;
            } else if (part?.type === 'img' && part?.url) {
              imageUrls.push(String(part.url));
            }
          }
        }
      } catch {
        contentText = String(rawText || '').trim();
      }
    }

    if (!contentText && link?.description) {
      contentText = String(link.description || '').trim();
    }

    return {
      contentText: contentText.replace(/\n{3,}/g, '\n\n').trim(),
      imageUrls
    };
  }

  function buildCommentPreview(comments) {
    const list = Array.isArray(comments) ? comments : [];
    const preview = [];
    for (const wrapper of list) {
      const commentList = Array.isArray(wrapper?.comment) ? wrapper.comment : [];
      if (!commentList.length) continue;
      const root = commentList[0];
      const name = root?.user?.username || '未知';
      const text = String(root?.text || '').replace(/\s+/g, ' ').slice(0, 120);
      const like = typeof root?.up === 'number' ? formatNum(root.up) : '';
      const ip = root?.ip_location ? `/${root.ip_location}` : '';
      preview.push(`${name}: ${text}${text.length >= 120 ? '...' : ''}${like ? ` (赞${like}${ip})` : ip ? ` (${ip.slice(1)})` : ''}`);
      if (preview.length >= 3) break;
    }
    return preview;
  }

  function buildReplyText(linkId, parsed) {
    const summary = (parsed.contentText || '').slice(0, 1200);
    const lines = [
      `小黑盒解析 (heybox): ${linkId}`,
      parsed.title ? `标题: ${parsed.title}` : null,
      parsed.authorName ? `作者: ${parsed.authorName}` : null,
      parsed.createTime ? `时间: ${parsed.createTime}` : null,
      parsed.stats?.view ? `浏览: ${parsed.stats.view}` : null,
      parsed.stats?.like ? `点赞: ${parsed.stats.like}` : null,
      parsed.stats?.comment ? `评论: ${parsed.stats.comment}` : null,
      parsed.stats?.share ? `分享: ${parsed.stats.share}` : null,
      parsed.stats?.collect ? `收藏: ${parsed.stats.collect}` : null,
      parsed.videoUrl ? `视频: ${parsed.videoUrl}` : null,
      parsed.videoThumb ? `封面: ${parsed.videoThumb}` : null,
      summary ? `正文:\n${summary}${parsed.contentText.length > summary.length ? '...' : ''}` : null
    ].filter(Boolean);

    if (parsed.imageUrls.length) {
      lines.push(`图片数: ${parsed.imageUrls.length}`);
      for (const img of parsed.imageUrls.slice(0, 6)) lines.push(`图片: ${img}`);
      if (parsed.imageUrls.length > 6) lines.push('(仅展示前6张)');
    }

    if (parsed.comments.length) {
      lines.push('热评(最多3条):');
      for (const c of parsed.comments) lines.push(c);
    }

    lines.push(`链接: https://www.xiaoheihe.cn/app/bbs/link/${linkId}`);
    return lines.join('\n');
  }

  function buildFailureReplyText(linkId, reason) {
    return [
      `小黑盒解析 (heybox): ${linkId}`,
      `失败: ${reason || '请求失败'}`,
      '提示: 可能需要 x_xhh_tokenid (暂未配置)',
      `链接: https://www.xiaoheihe.cn/app/bbs/link/${linkId}`
    ].join('\n');
  }

  async function fetchDetail(linkId) {
    const url = buildUrl(linkId);
    const headers = {
      Referer: 'https://www.xiaoheihe.cn/',
      Host: 'api.xiaoheihe.cn',
      Origin: 'https://www.xiaoheihe.cn',
      Accept: 'application/json, text/plain, */*',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    };

    const resp = await axios.get(url, {
      headers,
      timeout: 20000,
      validateStatus: () => true
    });

    if (resp.status >= 400) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    const res = resp?.data;
    if (!res || res.status !== 'ok') {
      const reason = res?.msg || res?.message || res?.status || 'unknown error';
      return { ok: false, error: reason };
    }

    return { ok: true, data: res.result };
  }

  async function process(target) {
    const linkId = target.linkId;
    const result = await fetchDetail(linkId);

    if (!result.ok) {
      return {
        target,
        replyText: buildFailureReplyText(linkId, result.error),
        error: result.error
      };
    }

    const data = result.data || {};
    const link = data.link || {};
    const user = link.user || {};

    const { contentText, imageUrls } = parseLinkContent(link);
    const comments = buildCommentPreview(data.comments || []);
    const createAt = Number(link?.create_at || 0);
    const createTime = Number.isFinite(createAt) && createAt > 0
      ? new Date(createAt * 1000).toLocaleString('zh-CN', { hour12: false })
      : '';

    const parsed = {
      title: link?.title || '',
      authorName: user?.username || '',
      createTime,
      contentText,
      imageUrls,
      videoUrl: link?.video_url || '',
      videoThumb: link?.video_thumb || '',
      stats: {
        view: formatNum(link?.click),
        like: formatNum(link?.link_award_num),
        comment: formatNum(link?.comment_num),
        share: formatNum(link?.forward_num),
        collect: formatNum(link?.favour_count)
      },
      comments
    };

    return {
      target,
      parsed,
      replyText: buildReplyText(linkId, parsed)
    };
  }

  return {
    name: 'heybox',
    detect,
    process,
    helpers: {
      buildUrl,
      getHkey,
      getNonce
    }
  };
}

module.exports = { buildHeyboxPlugin };
