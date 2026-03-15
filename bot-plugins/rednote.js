function buildRednotePlugin(ctx) {
  const {
    axios,
    safeJsonParse,
    fetchHtmlWithRedirect
  } = ctx;

  const REDNOTE_INITIAL_STATE_PATTERN = /window\.__INITIAL_STATE__=(.*?)<\/script>/s;

  function detect(text) {
    if (!text) return null;
    const s = String(text);
    if (/xhslink\.com\//i.test(s) || /xiaohongshu\.com\//i.test(s)) {
      return { platform: 'rednote', text: s };
    }
    return null;
  }

  function buildReplyText(summary, { maxLives = 2 } = {}) {
    const author = summary?.author || {};
    const stats = summary?.stats || {};

    const lines = [
      '小红书解析 (rednote):',
      summary?.title ? `标题: ${summary.title}` : null,
      summary?.desc ? `内容: ${summary.desc}` : null,
      author?.nickname ? `作者: ${author.nickname}` : null,
      author?.avatarUrl ? `头像: ${author.avatarUrl}` : null,
      stats?.like ? `点赞: ${stats.like}` : null,
      stats?.comment ? `评论: ${stats.comment}` : null,
      stats?.share ? `分享: ${stats.share}` : null,
      stats?.collect ? `收藏: ${stats.collect}` : null
    ].filter(Boolean);

    if (summary?.videoUrl) {
      lines.push(`视频: ${summary.videoUrl}`);
      if (summary?.coverUrl) lines.push(`封面: ${summary.coverUrl}`);
    }

    const imgs = Array.isArray(summary?.imageUrls) ? summary.imageUrls : [];
    if (imgs.length) {
      lines.push(`图片数: ${imgs.length}`);
      lines.push('图片:');
      for (const u of imgs) lines.push(u);
    }

    const lives = Array.isArray(summary?.liveUrls) ? summary.liveUrls : [];
    if (lives.length) {
      const sliced = lives.slice(0, maxLives);
      lines.push(`LivePhoto数: ${lives.length}`);
      for (const it of sliced) {
        if (it?.liveUrl) lines.push(`Live视频: ${it.liveUrl}`);
        if (it?.coverUrl) lines.push(`Live封面: ${it.coverUrl}`);
      }
      if (lives.length > sliced.length) lines.push(`(仅展示前${maxLives}个LivePhoto)`);
    }

    if (Array.isArray(summary?.comments) && summary.comments.length) {
      lines.push('热评(最多3条):');
      for (const c of summary.comments.slice(0, 3)) lines.push(c);
    }

    if (summary?.finalUrl) lines.push(`链接: ${summary.finalUrl}`);
    return lines.filter(Boolean).join('\n');
  }

  async function process(target) {
    const text = target?.text || '';
    const s = String(text);

    const short = s.match(/https?:\/\/(xhslink\.com\/[A-Za-z0-9._?%&+=/#@-]+)/i)
      || s.match(/\b(xhslink\.com\/[A-Za-z0-9._?%&+=/#@-]+)\b/i);
    if (short) {
      const url = short[0].startsWith('http') ? short[0] : `https://${short[0]}`;
      const { finalUrl } = await fetchHtmlWithRedirect(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          Referer: 'https://www.xiaohongshu.com/'
        },
        timeout: 20000
      });

      if (finalUrl && /xhslink\.com\//i.test(finalUrl)) {
        return process({ text: finalUrl });
      }

      const r2 = await fetchHtmlWithRedirect(finalUrl || url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          Referer: 'https://www.xiaohongshu.com/'
        },
        timeout: 20000
      });
      return process({ text: r2.finalUrl || finalUrl || url });
    }

    const m = s.match(/xiaohongshu\.com\/(?<type>explore|search_result|discovery\/item)\/(?<noteId>[0-9a-zA-Z]+)\?(?<qs>[^\s]+)/i)
      || s.match(/xiaohongshu\.com\/explore\/(?<noteId>[0-9a-zA-Z]+)\b/i);
    if (!m?.groups?.noteId) return null;

    const noteId = m.groups.noteId;
    const qs = m.groups.qs;
    const params = new URLSearchParams(qs);
    const xsecToken = params.get('xsec_token');
    if (!xsecToken) {
      throw new Error('缺少 xsec_token, 无法解析小红书链接');
    }

    const finalUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_share`;

    const pageResp = await axios.get(finalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        Referer: 'https://www.xiaohongshu.com/',
        Origin: 'https://www.xiaohongshu.com',
        'X-Requested-With': 'XMLHttpRequest',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty'
      },
      timeout: 20000
    });
    const html = typeof pageResp?.data === 'string' ? pageResp.data : '';
    const matched = html.match(REDNOTE_INITIAL_STATE_PATTERN);
    if (!matched || !matched[1]) {
      throw new Error('小红书分享链接失效或内容已删除');
    }
    const rawJson = String(matched[1]).replace(/undefined/g, '""');
    const initState = safeJsonParse(rawJson);
    if (!initState) {
      throw new Error('failed to JSON.parse __INITIAL_STATE__');
    }

    const noteWrapper = initState?.note?.noteDetailMap?.[noteId];
    const note = noteWrapper?.note;
    if (!note) {
      throw new Error('noteDetailMap missing note');
    }

    let comments = [];
    try {
      const comResp = await axios.get('https://edith.xiaohongshu.com/api/sns/web/v2/comment/page', {
        params: {
          note_id: noteId,
          cursor: '',
          top_comment_id: '',
          image_formats: 'jpg,webp,avif',
          xsec_token: xsecToken
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Referer: finalUrl,
          Origin: 'https://www.xiaohongshu.com'
        },
        timeout: 20000
      });
      const comJson = comResp?.data;
      if (comJson?.code === 0) {
        comments = Array.isArray(comJson?.data?.comments) ? comJson.data.comments : [];
      }
    } catch (e) {
      console.log('[rednote] fetch comments failed:', e?.message || e);
    }

    const imageUrls = Array.isArray(note?.imageList) ? note.imageList.map((i) => i?.urlDefault).filter(Boolean) : [];
    const pickStreamUrl = (stream) => {
      const lists = [stream?.h264, stream?.h265, stream?.h266, stream?.av1];
      for (const lst of lists) {
        if (Array.isArray(lst) && lst.length && lst[0]?.masterUrl) return lst[0].masterUrl;
      }
      return '';
    };

    const videoUrl = note?.video?.media?.stream ? pickStreamUrl(note.video.media.stream) : '';
    const liveUrls = Array.isArray(note?.imageList)
      ? note.imageList
          .filter((img) => img?.livePhoto)
          .map((img) => ({
            liveUrl: img?.stream ? pickStreamUrl(img.stream) : '',
            coverUrl: img?.urlDefault || ''
          }))
          .filter((x) => x.liveUrl)
      : [];

    const commentPreview = comments.slice(0, 3).map((c) => {
      const name = c?.userInfo?.nickname || '未知';
      const text = (c?.content || '').replace(/\s+/g, ' ').slice(0, 80);
      const like = c?.likeCount || '-';
      const sub = Array.isArray(c?.subComments) ? c.subComments.length : 0;
      const ip = c?.ipLocation || '';
      return `${name}: ${text}${text.length >= 80 ? '...' : ''} (赞${like}/评${sub}${ip ? `/` + ip : ''})`;
    });

    const summary = {
      platform: 'rednote',
      noteId,
      finalUrl,
      title: note?.title || '',
      desc: note?.desc || '',
      author: {
        nickname: note?.user?.nickname || '',
        avatarUrl: note?.user?.avatar || ''
      },
      stats: {
        like: note?.interactInfo?.likedCount || '-',
        comment: note?.interactInfo?.commentCount || '-',
        share: note?.interactInfo?.shareCount || '-',
        collect: note?.interactInfo?.collectedCount || '-'
      },
      imageUrls,
      videoUrl: videoUrl || '',
      coverUrl: imageUrls[0] || '',
      liveUrls,
      comments: commentPreview,
      timestamp: Number(note?.lastUpdateTime || 0)
    };

    return {
      target,
      summary,
      replyText: buildReplyText(summary)
    };
  }

  return {
    name: 'rednote',
    detect,
    process,
    helpers: {
      buildReplyText
    }
  };
}

module.exports = { buildRednotePlugin };
