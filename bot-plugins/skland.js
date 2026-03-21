function buildSklandPlugin(ctx) {
  const { axios } = ctx;

  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

  const SKLAND_ARTICLE_URL_RE = /https?:\/\/(?:www\.|m\.)?skland\.com\/article\?[^\s]+/i;

  function cleanUrl(raw) {
    return String(raw || '').replace(/[)\]）】》>,，。!?！？]+$/g, '');
  }

  function extractArticleIdFromUrl(url) {
    try {
      const u = new URL(String(url));
      const id = u.searchParams.get('id') || '';
      if (/^\d+$/.test(id)) return id;
    } catch {
      // ignore URL parse error and fallback to regex below
    }
    const m = String(url || '').match(/[?&]id=(\d+)/i);
    return m ? m[1] : '';
  }

  function detect(text) {
    if (!text) return null;
    const m = String(text).match(SKLAND_ARTICLE_URL_RE);
    if (!m) return null;
    const url = cleanUrl(m[0]);
    const articleId = extractArticleIdFromUrl(url);
    return { platform: 'skland', url, articleId };
  }

  function toInt(v) {
    const n = Number(v || 0);
    return Number.isFinite(n) ? n : 0;
  }

  function formatTime(tsSeconds) {
    const sec = toInt(tsSeconds);
    if (sec <= 0) return '';
    try {
      return new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return String(sec);
    }
  }

  function joinTextSlice(textSlice) {
    if (!Array.isArray(textSlice)) return '';
    return textSlice
      .map((x) => String(x?.c || '').trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  function pickCoverUrl(imageCover, imageListSlice, thumbnail) {
    if (typeof imageCover === 'string' && imageCover) return imageCover;
    if (imageCover && typeof imageCover === 'object') {
      const byObject = imageCover.url || imageCover.src || imageCover.originUrl || '';
      if (byObject) return String(byObject);
    }
    if (typeof thumbnail === 'string' && thumbnail) return thumbnail;
    if (Array.isArray(imageListSlice) && imageListSlice.length) {
      const first = imageListSlice[0];
      if (typeof first === 'string' && first) return first;
      if (first && typeof first === 'object') return String(first.url || '');
    }
    return '';
  }

  function normalizeArticle(row) {
    const item = row?.item || {};
    const user = row?.user || {};
    const tags = Array.isArray(row?.tags) ? row.tags : [];
    const itemRts = row?.itemRts || {};

    return {
      id: String(item.id || ''),
      title: String(item.title || '').trim(),
      author: String(user.nickname || ''),
      publishTimeText: formatTime(item.publishedAtTs || item.createdAtTs),
      text: joinTextSlice(item.textSlice),
      tags: tags.map((x) => String(x?.name || '').trim()).filter(Boolean),
      cover: pickCoverUrl(item.imageCover, item.imageListSlice, item.thumbnail),
      imageCount: Array.isArray(item.imageListSlice) ? item.imageListSlice.length : 0,
      videoCount: Array.isArray(item.videoListSlice) ? item.videoListSlice.length : 0,
      liked: toInt(itemRts.liked),
      commented: toInt(itemRts.commented),
      collected: toInt(itemRts.collected),
      reposted: toInt(itemRts.reposted)
    };
  }

  function pickFirstComment(commentRespData) {
    const list = Array.isArray(commentRespData?.data?.list) ? commentRespData.data.list : [];
    if (!list.length) return null;
    const first = list[0];
    const comment = first?.meta?.comment || {};
    const user = first?.meta?.user || {};
    const text = joinTextSlice(comment.textSlice);
    if (!text) return null;
    return {
      author: String(user.nickname || ''),
      text
    };
  }

  function buildReplyText(target, article, firstComment) {
    const lines = [];
    lines.push('Skland解析 (skland):');
    lines.push(`链接: ${target.url}`);
    if (article.title) lines.push(`标题: ${article.title}`);
    if (article.author) lines.push(`作者: ${article.author}`);
    if (article.publishTimeText) lines.push(`发布时间: ${article.publishTimeText}`);
    if (article.tags.length) lines.push(`标签: ${article.tags.slice(0, 6).join(' / ')}`);
    lines.push(
      `互动: 点赞 ${article.liked} | 评论 ${article.commented} | 收藏 ${article.collected} | 转发 ${article.reposted}`
    );
    lines.push(`媒体: 图片 ${article.imageCount} 张 | 视频 ${article.videoCount} 个`);
    if (article.cover) lines.push(`封面: ${article.cover}`);
    if (article.text) lines.push(`正文: ${article.text.slice(0, 220)}`);
    if (firstComment?.text) {
      lines.push(
        `最新评论: ${firstComment.author ? `${firstComment.author}: ` : ''}${firstComment.text.slice(0, 120)}`
      );
    }
    return lines.join('\n');
  }

  async function requestItem(articleId) {
    return axios.get('https://zonai.skland.com/h5/v1/item/list', {
      params: { ids: articleId },
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: `https://www.skland.com/article?id=${articleId}`
      },
      timeout: 20000,
      validateStatus: (s) => s >= 200 && s < 500
    });
  }

  async function requestComments(articleId) {
    return axios.get('https://zonai.skland.com/h5/v1/comment/list-by-topic', {
      params: {
        parentId: articleId,
        parentKind: 'item',
        sortType: 1,
        pageSize: 10
      },
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: `https://www.skland.com/article?id=${articleId}`
      },
      timeout: 20000,
      validateStatus: (s) => s >= 200 && s < 500
    });
  }

  async function process(target) {
    const articleId = target?.articleId || extractArticleIdFromUrl(target?.url || '');
    if (!articleId) {
      return {
        target,
        replyText: `Skland解析 (skland): 无法从链接中提取文章ID\n链接: ${target?.url || ''}`
      };
    }

    const [itemResp, commentResp] = await Promise.all([requestItem(articleId), requestComments(articleId)]);
    const itemData = itemResp?.data || {};
    const commentData = commentResp?.data || {};

    if (itemData?.code !== 0) {
      return {
        target,
        replyText: `Skland解析 (skland): 获取文章失败 (code=${itemData?.code ?? 'unknown'}) ${itemData?.message || ''}\n链接: ${target.url}`
      };
    }

    const row = itemData?.data?.list?.[0];
    if (!row) {
      return {
        target,
        replyText: `Skland解析 (skland): 文章不存在或已删除\n链接: ${target.url}`
      };
    }

    const article = normalizeArticle(row);
    const firstComment = commentData?.code === 0 ? pickFirstComment(commentData) : null;
    const replyText = buildReplyText(target, article, firstComment);
    return { target, article, firstComment, replyText };
  }

  return {
    name: 'skland',
    detect,
    process
  };
}

module.exports = { buildSklandPlugin };
