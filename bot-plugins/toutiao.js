function buildToutiaoPlugin(ctx) {
  const { axios } = ctx;

  const API_URL = 'https://api.bugpk.com/api/toutiao';

  function detect(text) {
    if (!text) return null;
    const s = String(text);
    const m = s.match(/https?:\/\/[^\s]*?(?:toutiao\.com|ixigua\.com)\/(?:is|video)\/[A-Za-z0-9_-]+\/?/i);
    if (!m) return null;
    return { platform: 'toutiao', url: m[0] };
  }

  function parseResponseData(resp) {
    if (!resp) return null;
    if (typeof resp === 'object' && resp.code !== undefined) return resp;
    if (typeof resp !== 'string') return null;

    const jsonStart = resp.indexOf('{');
    const jsonEnd = resp.lastIndexOf('}') + 1;
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const jsonText = resp.slice(jsonStart, jsonEnd);
      try {
        return JSON.parse(jsonText);
      } catch {
        return null;
      }
    }

    try {
      return JSON.parse(resp);
    } catch {
      return null;
    }
  }

  function buildReplyText(summary) {
    const lines = [
      `今日头条解析 (toutiao): ${summary.id || '-'}`,
      summary.title ? `标题: ${summary.title}` : null,
      summary.author ? `作者: ${summary.author}` : null,
      summary.description ? `简介: ${summary.description}` : null,
      summary.videoUrl ? `视频: ${summary.videoUrl}` : null,
      summary.coverUrl ? `封面: ${summary.coverUrl}` : null,
      summary.url ? `链接: ${summary.url}` : null
    ].filter(Boolean);
    return lines.join('\n');
  }

  async function process(target) {
    const shareUrl = target.url;
    const resp = await axios.get(API_URL, {
      params: { url: shareUrl },
      timeout: 20000,
      responseType: 'text',
      transformResponse: [(v) => v],
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });

    if (resp.status >= 400) {
      throw new Error(`今日头条接口HTTP错误: ${resp.status}`);
    }

    const parsed = parseResponseData(resp.data);
    if (!parsed) {
      throw new Error('今日头条接口返回无效JSON');
    }

    if (parsed.code !== 200) {
      throw new Error(parsed.msg || '今日头条接口返回错误');
    }

    const data = parsed.data || {};
    const videoUrl = data.url || '';
    if (!videoUrl || !videoUrl.startsWith('http')) {
      throw new Error('无效视频URL');
    }

    const summary = {
      id: data.id || data.vid || '',
      title: data.title || '',
      author: data.author || '',
      description: data.description || '',
      videoUrl,
      coverUrl: data.cover || '',
      url: shareUrl
    };

    return {
      target,
      summary,
      replyText: buildReplyText(summary)
    };
  }

  return {
    name: 'toutiao',
    detect,
    process,
    helpers: {
      parseResponseData,
      buildReplyText
    }
  };
}

module.exports = { buildToutiaoPlugin };
