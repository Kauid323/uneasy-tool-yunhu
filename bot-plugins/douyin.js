function buildDouyinPlugin(ctx) {
  const {
    axios,
    randomChoice,
    safeJsonParse,
    formatNum
  } = ctx;

  const DOUYIN_ROUTER_PATTERN = /window\._ROUTER_DATA\s*=\s*(.*?)<\/script>/s;

  function pickFirstRouterPage(loaderData) {
    if (!loaderData || typeof loaderData !== 'object') return null;
    const videoPage = loaderData['video_(id)/page'];
    if (videoPage) return { type: 'video', page: videoPage };
    const notePage = loaderData['note_(id)/page'];
    if (notePage) return { type: 'note', page: notePage };
    return null;
  }

  function extractVideoDataFromRouterData(routerData) {
    const loaderData = routerData?.loaderData;
    const picked = pickFirstRouterPage(loaderData);
    if (!picked) {
      throw new Error("can't find video_(id)/page or note_(id)/page in router data");
    }

    const page = picked.page;
    const itemList = page?.videoInfoRes?.item_list;
    if (!Array.isArray(itemList) || itemList.length === 0) {
      throw new Error("can't find data in videoInfoRes");
    }

    const videoData = randomChoice(itemList);
    const commentList = page?.commentListData?.comments;
    return {
      videoData,
      commentList: Array.isArray(commentList) ? commentList : []
    };
  }

  function extractMedia(videoData) {
    const images = Array.isArray(videoData?.images) ? videoData.images : [];
    const imageUrls = images
      .map((img) => randomChoice(img?.url_list))
      .filter((u) => typeof u === 'string' && u.startsWith('http'));

    if (imageUrls.length > 0) {
      return { kind: 'images', imageUrls };
    }

    const playList = videoData?.video?.play_addr?.url_list;
    const rawVideoUrl = randomChoice(playList);
    const videoUrl = typeof rawVideoUrl === 'string' ? rawVideoUrl.replace('playwm', 'play') : '';

    const coverList = videoData?.video?.cover?.url_list;
    const coverUrl = randomChoice(coverList) || '';
    const duration = Number(videoData?.video?.duration || 0);
    return { kind: 'video', videoUrl, coverUrl, duration };
  }

  function extractAuthor(videoData) {
    const author = videoData?.author || {};
    const nickname = author?.nickname || '';
    const thumb = author?.avatar_thumb?.url_list;
    const medium = author?.avatar_medium?.url_list;
    const avatarUrl = randomChoice(thumb) || randomChoice(medium) || '';
    return { nickname, avatarUrl };
  }

  function buildSummary({ inputUrl, finalUrl, videoData, commentList }) {
    const desc = videoData?.desc || '';
    const createTime = Number(videoData?.create_time || 0);
    const stats = videoData?.statistics || {};
    const author = extractAuthor(videoData);
    const media = extractMedia(videoData);
    const commentPreview = commentList.slice(0, 3).map((c) => {
      const name = c?.user?.nickname || '未知';
      const text = (c?.text || '').replace(/\s+/g, ' ').slice(0, 80);
      const like = formatNum(c?.digg_count);
      const reply = formatNum(c?.reply_comment_total);
      const ip = c?.ip_label || '';
      return `${name}: ${text}${text.length >= 80 ? '...' : ''} (赞${like}/评${reply}${ip ? `/` + ip : ''})`;
    });

    return {
      platform: 'douyin',
      inputUrl,
      finalUrl,
      desc,
      createTime,
      author,
      stats: {
        like: formatNum(stats?.digg_count),
        comment: formatNum(stats?.comment_count),
        share: formatNum(stats?.share_count),
        collect: formatNum(stats?.collect_count)
      },
      media,
      comments: commentPreview
    };
  }

  async function fetchHtml(url, { headers = {}, timeout = 20000 } = {}) {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent':
          headers['User-Agent'] ||
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: headers['Accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': headers['Accept-Language'] || 'zh-CN,zh;q=0.9',
        ...headers
      },
      timeout,
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400
    });

    const finalUrl = resp?.headers?.location
      ? String(resp.headers.location).startsWith('http')
        ? String(resp.headers.location)
        : `https:${resp.headers.location}`
      : url;

    const html = typeof resp?.data === 'string' ? resp.data : '';
    return { status: resp.status, finalUrl, html };
  }

  async function resolveShortLink(shortUrl) {
    const { status, finalUrl } = await fetchHtml(shortUrl, {});
    if (status >= 300 && status < 400 && finalUrl && finalUrl !== shortUrl) {
      return finalUrl;
    }
    return finalUrl || shortUrl;
  }

  async function parseSharePage(url) {
    const { status, finalUrl, html } = await fetchHtml(url, {});
    if (status !== 200) {
      throw new Error(`douyin status: ${status}`);
    }

    const matched = html.match(DOUYIN_ROUTER_PATTERN);
    if (!matched || !matched[1]) {
      throw new Error("can't find _ROUTER_DATA in html");
    }

    const routerData = safeJsonParse(matched[1].trim());
    if (!routerData) {
      throw new Error('failed to JSON.parse _ROUTER_DATA');
    }

    const { videoData, commentList } = extractVideoDataFromRouterData(routerData);
    return {
      inputUrl: url,
      finalUrl,
      videoData,
      commentList
    };
  }

  function extractTarget(text) {
    if (!text) return null;
    const s = String(text);

    const short = s.match(/https?:\/\/(v\.douyin\.com|jx\.douyin\.com)\/[a-zA-Z0-9_\-]+/i)
      || s.match(/\b(v\.douyin\.com|jx\.douyin\.com)\/[a-zA-Z0-9_\-]+\b/i);
    if (short) {
      const url = short[0].startsWith('http') ? short[0] : `https://${short[0]}`;
      return { type: 'douyin_short', url };
    }

    const long = s.match(/douyin\.com\/(?<ty>video|note|article)\/(?<vid>\d+)/i)
      || s.match(/iesdouyin\.com\/share\/(?<ty>video|note|article)\/(?<vid>\d+)/i)
      || s.match(/m\.douyin\.com\/share\/(?<ty>video|note|article)\/(?<vid>\d+)/i)
      || s.match(/jingxuan\.douyin\.com\/m\/(?<ty>video|note|article)\/(?<vid>\d+)/i);
    if (long?.groups?.vid) {
      let ty = long.groups.ty;
      const vid = long.groups.vid;
      if (ty === 'article') ty = 'note';
      const shareUrl = `https://m.douyin.com/share/${ty}/${vid}`;
      return { type: 'douyin', url: shareUrl, ty, vid };
    }

    return null;
  }

  function detect(text) {
    const target = extractTarget(text);
    if (!target) return null;
    return { platform: 'douyin', ...target };
  }

  function buildReplyText(summary) {
    const media = summary?.media || {};
    const author = summary?.author || {};
    const stats = summary?.stats || {};
    const lines = [
      '抖音解析 (douyin):',
      summary?.desc ? `标题: ${summary.desc}` : null,
      author?.nickname ? `作者: ${author.nickname}` : null,
      author?.avatarUrl ? `头像: ${author.avatarUrl}` : null,
      stats?.like ? `点赞: ${stats.like}` : null,
      stats?.comment ? `评论: ${stats.comment}` : null,
      stats?.share ? `分享: ${stats.share}` : null,
      stats?.collect ? `收藏: ${stats.collect}` : null
    ].filter(Boolean);

    if (media?.kind === 'video') {
      if (media?.videoUrl) lines.push(`视频: ${media.videoUrl}`);
      if (media?.coverUrl) lines.push(`封面: ${media.coverUrl}`);
      if (media?.duration) lines.push(`时长(ms): ${media.duration}`);
    }

    if (media?.kind === 'images') {
      const urls = Array.isArray(media?.imageUrls) ? media.imageUrls : [];
      lines.push(`图片数: ${urls.length}`);
      if (urls.length) {
        lines.push('图片:');
        for (const u of urls) lines.push(u);
      }
    }

    if (summary?.finalUrl) lines.push(`链接: ${summary.finalUrl}`);
    if (Array.isArray(summary?.comments) && summary.comments.length) {
      lines.push('热评(最多3条):');
      for (const c of summary.comments.slice(0, 3)) lines.push(c);
    }

    return lines.join('\n');
  }

  async function process(target) {
    let shareUrl = '';
    let inputUrl = target.url;

    if (target.type === 'douyin_short') {
      const resolved = await resolveShortLink(target.url);
      const t2 = extractTarget(resolved);
      if (!t2) {
        throw new Error(`douyin short link resolved but cannot parse target: ${resolved}`);
      }
      shareUrl = t2.url;
      inputUrl = resolved;
    } else {
      shareUrl = target.url;
    }

    const parsed = await parseSharePage(shareUrl);
    const summary = buildSummary({
      inputUrl,
      finalUrl: parsed.finalUrl,
      videoData: parsed.videoData,
      commentList: parsed.commentList
    });

    return {
      target,
      summary,
      replyText: buildReplyText(summary)
    };
  }

  return {
    name: 'douyin',
    detect,
    process,
    helpers: {
      extractTarget,
      resolveShortLink,
      parseSharePage,
      buildReplyText
    }
  };
}

module.exports = { buildDouyinPlugin };
