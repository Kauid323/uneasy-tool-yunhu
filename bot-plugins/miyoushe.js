function buildMiyoushePlugin(ctx) {
  const { axios, safeJsonParse } = ctx;

  function extractPostId(text) {
    if (!text) return null;
    const s = String(text);

    // https://m.miyoushe.com/sr?channel=bh3/#/article/73894017
    const m1 = s.match(/#\/article\/(\d+)/i);
    if (m1) return m1[1];

    // https://m.miyoushe.com/sr/article/73894017 或其它变体
    const m2 = s.match(/\/article\/(\d+)/i);
    if (m2) return m2[1];

    return null;
  }

  function detect(text) {
    const postId = extractPostId(text);
    if (!postId) return null;
    return { platform: 'miyoushe', type: 'post', postId, url: String(text) };
  }

  function formatDateTime(sec) {
    const n = Number(sec || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n * 1000).toLocaleString('zh-CN', { hour12: false });
  }

  function coerceTextContent(post) {
    const raw = post?.content;
    if (!raw) return '';
    const s = String(raw);
    const parsed = safeJsonParse?.(s);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.describe === 'string') return parsed.describe;
      if (typeof parsed.content === 'string') return parsed.content;
    }
    return s;
  }

  function pickBestVodUrl(vod) {
    const resolutions = Array.isArray(vod?.resolutions) ? vod.resolutions : [];
    if (!resolutions.length) return '';
    const sorted = resolutions
      .map((r) => ({
        url: r?.url || '',
        height: Number(r?.height || 0),
        bitrate: Number(r?.bitrate || 0),
        label: String(r?.label || r?.definition || '')
      }))
      .filter((r) => r.url && /^https?:\/\//i.test(r.url))
      .sort((a, b) => (b.height - a.height) || (b.bitrate - a.bitrate));
    return sorted[0]?.url || '';
  }

  function buildReplyText(target, data) {
    const postWrap = data?.post;
    const post = postWrap?.post || {};
    const forum = postWrap?.forum || {};
    const user = postWrap?.user || {};
    const stat = postWrap?.stat || {};

    const subject = post?.subject || '';
    const authorName = user?.nickname || '';
    const authorCert = user?.certification?.label || '';
    const forumName = forum?.name || '';
    const createdAt = formatDateTime(post?.created_at);
    const cover = post?.cover || postWrap?.cover?.url || '';

    const topics = Array.isArray(postWrap?.topics) ? postWrap.topics.map((t) => t?.name).filter(Boolean) : [];
    const images = Array.isArray(post?.images) ? post.images.filter(Boolean) : [];
    const imageList = Array.isArray(postWrap?.image_list) ? postWrap.image_list.map((i) => i?.url).filter(Boolean) : [];
    const allImages = Array.from(new Set([...(images || []), ...(imageList || [])])).slice(0, 6);

    const vodList = Array.isArray(postWrap?.vod_list) ? postWrap.vod_list : [];
    const vodUrl = vodList.length ? pickBestVodUrl(vodList[0]) : '';

    const contentText = coerceTextContent(post).trim();
    const contentPreview = contentText.length > 1200 ? `${contentText.slice(0, 1200)}...` : contentText;

    const statsText = [
      Number.isFinite(Number(stat?.view_num)) ? `浏览: ${stat.view_num}` : null,
      Number.isFinite(Number(stat?.like_num)) ? `点赞: ${stat.like_num}` : null,
      Number.isFinite(Number(stat?.reply_num)) ? `评论: ${stat.reply_num}` : null,
      Number.isFinite(Number(stat?.bookmark_num)) ? `收藏: ${stat.bookmark_num}` : null,
      Number.isFinite(Number(stat?.forward_num)) ? `转发: ${stat.forward_num}` : null
    ].filter(Boolean).join(' / ');

    const lines = [];
    lines.push(`米游社解析 (miyoushe): ${post?.post_id || target.postId}`);
    if (subject) lines.push(`标题: ${subject}`);
    if (authorName) lines.push(`作者: ${authorName}${authorCert ? ` (${authorCert})` : ''}`);
    if (forumName) lines.push(`板块: ${forumName}`);
    if (createdAt) lines.push(`发布时间: ${createdAt}`);
    if (statsText) lines.push(statsText);
    if (topics.length) lines.push(`话题: ${topics.slice(0, 5).join(' / ')}`);
    if (cover) lines.push(`封面: ${cover}`);
    if (vodUrl) lines.push(`视频: ${vodUrl}`);
    if (allImages.length) lines.push(`图片: ${allImages.join(' ')}`);
    if (contentPreview) lines.push(`\n正文:\n${contentPreview}`);
    lines.push(`链接: ${target.url}`);
    return lines.filter(Boolean).join('\n');
  }

  async function fetchPostFull(postId, { read = 1 } = {}) {
    const url = 'https://bbs-api.miyoushe.com/post/wapi/getPostFull';
    const resp = await axios.get(url, {
      params: { post_id: String(postId), read: String(read ?? 1) },
      timeout: 20000,
      headers: {
        // 简单伪装，避免部分地区 403
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://m.miyoushe.com/'
      }
    });
    return resp?.data;
  }

  async function process(target) {
    const data = await fetchPostFull(target.postId, { read: 1 });
    if (!data || Number(data?.retcode) !== 0) {
      throw new Error(`米游社接口失败: retcode=${data?.retcode} message=${data?.message || ''}`.trim());
    }
    const replyText = buildReplyText(target, data?.data);
    return { target, replyText, data };
  }

  return {
    name: 'miyoushe',
    detect,
    process,
    helpers: { extractPostId, fetchPostFull }
  };
}

module.exports = { buildMiyoushePlugin };

