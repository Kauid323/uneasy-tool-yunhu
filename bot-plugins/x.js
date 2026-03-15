function buildXPlugin(ctx) {
  const {
    axios,
    formatNum,
    fs,
    path
  } = ctx;

  function xCleanTweetText(fullText) {
    if (!fullText) return '';
    return String(fullText)
      .replace(/\s*https:\/\/t\.co\/[0-9a-zA-Z_]+/g, '')
      .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
      .trim();
  }

  function xTruncateText(text, maxLen = 1800) {
    const s = String(text || '');
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '...';
  }

  function xPickBestVideoVariant(variants) {
    const list = Array.isArray(variants) ? variants : [];
    const mp4s = list
      .filter((v) => v?.content_type === 'video/mp4' && typeof v?.bitrate === 'number' && typeof v?.url === 'string')
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return mp4s.length ? mp4s[0].url : '';
  }

  function xExtractMedias(tweetLegacy) {
    const medias = tweetLegacy?.extended_entities?.media;
    const list = Array.isArray(medias) ? medias : [];
    const out = [];
    for (const m of list) {
      if (m?.type === 'photo' && m?.media_url_https) {
        out.push({ type: 'photo', url: m.media_url_https });
        continue;
      }
      if ((m?.type === 'video' || m?.type === 'animated_gif') && m?.video_info?.variants) {
        const best = xPickBestVideoVariant(m.video_info.variants);
        if (best) out.push({ type: 'video', url: best, cover: m?.media_url_https || '' });
      }
    }
    return out;
  }

  function xNormalizeUrl(url) {
    if (!url) return '';
    const s = String(url);
    if (s.startsWith('//')) return `https:${s}`;
    return s;
  }

  function xExtractArticle(tweet) {
    const article = tweet?.article?.article_results?.result;
    if (!article || typeof article !== 'object') return null;

    const title = String(article?.title || '').trim();
    const previewText = String(article?.preview_text || '').trim();

    const blocks = article?.content_state?.blocks;
    const blockList = Array.isArray(blocks) ? blocks : [];
    const texts = [];
    const links = [];
    for (const b of blockList) {
      const t = String(b?.text || '').trimEnd();
      if (t) texts.push(t);
      const urls = Array.isArray(b?.data?.urls) ? b.data.urls : [];
      for (const u of urls) {
        const link = xNormalizeUrl(u?.text || u?.url || '');
        if (link && /^https?:\/\//i.test(link)) links.push(link);
      }
    }

    const mediaEntities = Array.isArray(article?.media_entities) ? article.media_entities : [];
    const images = mediaEntities
      .map((m) => xNormalizeUrl(m?.media_info?.original_img_url || ''))
      .filter((u) => /^https?:\/\//i.test(u));

    const coverUrl = xNormalizeUrl(article?.cover_media?.media_info?.original_img_url || '');
    if (coverUrl && /^https?:\/\//i.test(coverUrl)) images.unshift(coverUrl);

    const uniqueImages = Array.from(new Set(images));

    return {
      id: String(article?.rest_id || ''),
      title,
      previewText,
      text: texts.join('\n').trim(),
      links: Array.from(new Set(links)),
      images: uniqueImages
    };
  }

  function detect(text) {
    if (!text) return null;
    const s = String(text);
    const m = s.match(/twitter\.com\/([0-9-a-zA-Z_]{1,20})\/status\/(\d+)/i)
      || s.match(/x\.com\/([0-9-a-zA-Z_]{1,20})\/status\/(\d+)/i);
    if (!m) return null;
    return {
      platform: 'x',
      username: m[1],
      tweetId: m[2],
      url: m[0].startsWith('http') ? m[0] : `https://${m[0]}`
    };
  }

  function buildReplyText(summary, { maxMedia = 4 } = {}) {
    const author = summary?.author || {};
    const stats = summary?.stats || {};

    const lines = [
      'X解析 (x):',
      author?.name ? `作者: ${author.name}` : null,
      summary?.text ? `内容:\n${summary.text}` : null,
      stats?.view ? `浏览: ${stats.view}` : null,
      stats?.like ? `点赞: ${stats.like}` : null,
      stats?.comment ? `评论: ${stats.comment}` : null,
      stats?.collect ? `收藏: ${stats.collect}` : null
    ].filter(Boolean);

    const medias = Array.isArray(summary?.medias) ? summary.medias : [];
    if (medias.length) {
      lines.push(`媒体数: ${medias.length}`);
      for (const m of medias.slice(0, maxMedia)) {
        if (m.type === 'photo') lines.push(`图片: ${m.url}`);
        else if (m.type === 'video') lines.push(`视频: ${m.url}${m.cover ? ` (封面: ${m.cover})` : ''}`);
      }
      if (medias.length > maxMedia) lines.push(`(仅展示前${maxMedia}个媒体)`);
    }

    if (summary?.quoted) {
      const q = summary.quoted;
      lines.push('--- 引用推文 ---');
      if (q?.author?.name) lines.push(`作者: ${q.author.name}`);
      if (q?.text) lines.push(`内容:\n${q.text}`);
      const qMedias = Array.isArray(q?.medias) ? q.medias : [];
      for (const m of qMedias.slice(0, 2)) {
        if (m.type === 'photo') lines.push(`图片: ${m.url}`);
        else if (m.type === 'video') lines.push(`视频: ${m.url}`);
      }
    }

    if (summary?.url) lines.push(`链接: ${summary.url}`);
    return lines.join('\n');
  }

  async function process(target) {
    console.log('[x] easycomment request tweetId =', target.tweetId);
    const resp = await axios.post(
      'https://easycomment.ai/api/twitter/v1/free/get-tweet-detail',
      { pid: target.tweetId },
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    const res = resp?.data;
    try {
      const text = JSON.stringify(res, null, 2);
      const max = 6000;
      console.log('[x] easycomment response (truncated):');
      if (text.length <= max) {
        console.log(text);
      } else {
        console.log(text.slice(0, max) + '\n...<truncated>...');
      }
    } catch (e) {
      console.log('[x] easycomment response stringify failed:', e?.message || e);
    }
    if (!res || res.code !== 100000) {
      throw new Error(res?.message || 'easycomment api failed');
    }

    const tweetRaw =
      res?.data?.data?.threaded_conversation_with_injections_v2?.instructions?.[1]?.entries?.[0]?.content?.itemContent?.tweet_results;
    const tweet = tweetRaw?.result;
    if (!tweet?.legacy || !tweet?.core?.user_results?.result?.legacy) {
      throw new Error('tweet result missing legacy');
    }

    const userLegacy = tweet.core.user_results.result.legacy;
    const legacy = tweet.legacy;
    const authorName = `${userLegacy.name} @${userLegacy.screen_name}`;
    const medias = xExtractMedias(legacy);
    const article = xExtractArticle(tweet);

    const summary = {
      platform: 'x',
      tweetId: tweet.rest_id,
      url: `https://x.com/${userLegacy.screen_name}/status/${tweet.rest_id}`,
      author: {
        name: authorName,
        avatarUrl: String(userLegacy.profile_image_url_https || '').replace('_normal', '_bigger'),
        description: userLegacy.description || '',
        id: userLegacy.screen_name
      },
      text: xCleanTweetText(legacy.full_text),
      stats: {
        view: formatNum(Number(tweet?.views?.count || 0)),
        like: formatNum(legacy.favorite_count),
        comment: formatNum(legacy.reply_count),
        collect: formatNum(legacy.bookmark_count)
      },
      medias,
      quoted: null,
      article: null
    };

    if (article) {
      const expanded = legacy?.entities?.urls?.[0]?.expanded_url || '';
      summary.article = {
        id: article.id || '',
        title: article.title,
        previewText: article.previewText,
        url: expanded && /^https?:\/\//i.test(expanded) ? expanded : (article.id ? `https://x.com/i/article/${article.id}` : ''),
        images: article.images,
        links: article.links
      };

      // 文章推文的 full_text 往往只有一个 t.co，改用文章正文/预览
      const fallbackText = [
        article.title ? `【${article.title}】` : null,
        article.previewText || null,
        article.text || null
      ].filter(Boolean).join('\n').trim();
      if (fallbackText) {
        const articleUrl = summary.article?.url || '';
        summary.text = xTruncateText(articleUrl ? `${fallbackText}\n\narticle: ${articleUrl}` : fallbackText, 2200);
      }

      // 文章媒体通常不在 extended_entities 里，补充图片
      if (Array.isArray(article.images) && article.images.length) {
        const existing = Array.isArray(summary.medias) ? summary.medias : [];
        const extra = article.images.slice(0, 6).map((u) => ({ type: 'photo', url: u }));
        summary.medias = [...existing, ...extra].filter(Boolean);
      }
    }

    if (tweet.quoted_status_result?.result?.legacy && tweet.quoted_status_result?.result?.core?.user_results?.result?.legacy) {
      const qt = tweet.quoted_status_result.result;
      const qu = qt.core.user_results.result.legacy;
      summary.quoted = {
        tweetId: qt.rest_id,
        url: `https://x.com/${qu.screen_name}/status/${qt.rest_id}`,
        author: {
          name: `${qu.name} @${qu.screen_name}`
        },
        text: xCleanTweetText(qt.legacy.full_text),
        medias: xExtractMedias(qt.legacy)
      };
    }

    const videos = Array.isArray(summary?.medias) ? summary.medias.filter((mm) => mm?.type === 'video' && mm?.url) : [];
    if (videos.length) {
      const firstVideo = videos[0];
      const tmpDir = path.join(__dirname, '..', 'tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

      const fileName = `x-${tweet.rest_id || target.tweetId}-${Date.now()}.mp4`;
      const tmpPath = path.join(tmpDir, fileName);

      console.log('[x] download video start:', firstVideo.url);
      console.log('[x] tmpPath =', tmpPath);

      const downloadResp = await axios.get(firstVideo.url, {
        responseType: 'stream',
        timeout: 60000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Referer: summary.url
        }
      });

      const writer = fs.createWriteStream(tmpPath);
      await new Promise((resolve, reject) => {
        downloadResp.data.pipe(writer);
        let done = false;
        const finish = (err) => {
          if (done) return;
          done = true;
          if (err) reject(err);
          else resolve();
        };
        writer.on('finish', () => finish());
        writer.on('error', (e) => finish(e));
        downloadResp.data.on('error', (e) => finish(e));
      });

      const st = fs.statSync(tmpPath);
      console.log('[x] download video ok, bytes =', st.size);

      try {
        const uploader = require('../upload-media');
        console.log('[x] upload-media.js uploadVideoFromPath start');
        const up = await uploader.uploadVideoFromPath(tmpPath, { originalName: fileName });
        console.log('[x] upload-media.js uploadVideoFromPath ok:', JSON.stringify(up, null, 2));
      } finally {
        try {
          fs.unlinkSync(tmpPath);
          console.log('[x] tmp video deleted:', tmpPath);
        } catch (e) {
          console.log('[x] tmp video delete failed:', e?.message || e);
        }
      }
    }

    return {
      target,
      summary,
      replyText: buildReplyText(summary, { maxMedia: 3 })
    };
  }

  return {
    name: 'x',
    detect,
    process,
    helpers: {
      xCleanTweetText,
      xPickBestVideoVariant,
      xExtractMedias,
      buildReplyText
    }
  };
}

module.exports = { buildXPlugin };
