function buildLofterPlugin(ctx) {
  const { axios, safeJsonParse } = ctx;

  const MOBILE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  // Match only: subdomain.lofter.com/post/xxxx
  const LOFTER_URL_RE =
    /https?:\/\/(?!www\.)[a-z0-9-]+\.lofter\.com\/post\/[A-Za-z0-9_]+(?:[/?#][^\s]*)?/i;

  function detect(text) {
    if (!text) return null;
    const m = String(text).match(LOFTER_URL_RE);
    if (!m) return null;
    return { platform: 'lofter', url: m[0] };
  }

  function decodeHtml(text) {
    return String(text || '')
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

  function stripHtml(html) {
    return decodeHtml(
      String(html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    )
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function parseInitializeData(html) {
    const m =
      html.match(/window\.__initialize_data__\s*=\s*(\{[\s\S]*?\})<\/script>/) ||
      html.match(/window\.__initialize_data__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (!m) return null;
    return safeJsonParse(m[1]);
  }

  function formatTime(ts) {
    const n = Number(ts || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    try {
      return new Date(n).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return String(n);
    }
  }

  function normalizeData(init, url) {
    const data = init?.postData?.data || {};
    const blog = data?.blogInfo || {};
    const post = data?.postData?.postView || {};
    const count = data?.postData?.postCountView || {};
    const photoPost = post?.photoPostView || {};
    const photoLinks = Array.isArray(photoPost?.photoLinks) ? photoPost.photoLinks : [];
    const firstPhoto = photoLinks[0]?.orign || photoLinks[0]?.raw || '';
    const digest = stripHtml(post?.digest || photoPost?.caption || '');

    return {
      url,
      permalink: init?.permalink || '',
      blogId: blog?.blogId || 0,
      blogName: blog?.blogName || '',
      blogNickName: blog?.blogNickName || '',
      postId: post?.id || 0,
      title: (post?.title || '').trim(),
      type: post?.type,
      publishTime: post?.publishTime || 0,
      publishTimeText: formatTime(post?.publishTime || 0),
      tags: Array.isArray(post?.tagList) ? post.tagList : [],
      digest,
      photoCount: Number(post?.photoCount || photoLinks.length || 0),
      firstPhoto,
      responseCount: Number(count?.responseCount || 0),
      hotCount: Number(count?.hotCount || 0),
      favoriteCount: Number(count?.favoriteCount || 0),
      viewCount: Number(count?.viewCount || 0)
    };
  }

  function buildReplyText(article) {
    const lines = [];
    lines.push('LOFTER文章解析：');
    if (article.title) lines.push(`标题: ${article.title}`);
    lines.push(`链接: ${article.url}`);
    if (article.blogNickName || article.blogName) {
      lines.push(`作者: ${article.blogNickName || article.blogName} (${article.blogName})`);
    }
    if (article.publishTimeText) lines.push(`发布时间: ${article.publishTimeText}`);
    if (article.tags.length) lines.push(`标签: ${article.tags.slice(0, 8).join(' / ')}`);
    lines.push(
      `热度: ${article.hotCount} | 评论: ${article.responseCount} | 喜欢: ${article.favoriteCount}`
    );
    if (article.photoCount > 0) lines.push(`图片: ${article.photoCount} 张`);
    if (article.firstPhoto) lines.push(`首图: ${article.firstPhoto}`);
    if (article.digest) lines.push(`摘要: ${article.digest.slice(0, 180)}`);
    lines.push(`postId: ${article.postId} | blogId: ${article.blogId}`);
    return lines.join('\n');
  }

  async function process(target) {
    const url = target?.url || '';
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400
    });

    const html = typeof resp?.data === 'string' ? resp.data : '';
    const init = parseInitializeData(html);
    if (!init) {
      return {
        target,
        replyText: `LOFTER文章解析失败：页面未找到 __initialize_data__\n链接: ${url}`,
        status: resp?.status || 0
      };
    }

    const article = normalizeData(init, url);
    const replyText = buildReplyText(article);
    return { target, replyText, article };
  }

  return {
    name: 'lofter',
    detect,
    process
  };
}

module.exports = { buildLofterPlugin };
