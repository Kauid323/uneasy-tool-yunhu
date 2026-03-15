function buildYoutubePlugin(ctx) {
  const { axios, secondsToDurationText } = ctx;

  const zlib = require('zlib');
  const TURBOSCRIBE_API_URL = 'https://turboscribe.ai/_htmx/NCN20gAEkZMBzQPXkQc';


  function ytConsentCookie() {
    // Avoid redirects/blocks to consent.youtube.com for some regions.
    // This isn't guaranteed, but helps in practice.
    return 'CONSENT=YES+1;';
  }

  function extractVideoIdFromText(text) {
    if (!text) return null;
    const s = String(text);

    // https://youtu.be/VIDEOID
    const m1 = s.match(/https?:\/\/(?:www\.)?youtu\.be\/([0-9A-Za-z_-]{6,})/i);
    if (m1) return m1[1];

    // https://www.youtube.com/watch?v=VIDEOID
    const m2 = s.match(/https?:\/\/(?:www\.)?(?:music\.)?youtube\.com\/watch\?(?:[^\s#&]*&)*v=([0-9A-Za-z_-]{6,})/i);
    if (m2) return m2[1];

    // https://www.youtube.com/shorts/VIDEOID
    const m3 = s.match(/https?:\/\/(?:www\.)?youtube\.com\/shorts\/([0-9A-Za-z_-]{6,})/i);
    if (m3) return m3[1];

    // https://www.youtube.com/embed/VIDEOID
    const m4 = s.match(/https?:\/\/(?:www\.)?youtube\.com\/embed\/([0-9A-Za-z_-]{6,})/i);
    if (m4) return m4[1];

    return null;
  }

  function detect(text) {
    const id = extractVideoIdFromText(text);
    if (!id) return null;
    return { platform: 'youtube', type: 'video', id, url: String(text) };
  }

  function normalizeUrl(url) {
    if (!url) return '';
    const s = String(url);
    if (s.startsWith('//')) return `https:${s}`;
    return s;
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function htmlUnescape(s) {
    return String(s || '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ');
  }

  function extractJsonObjectAfter(html, marker) {
    const idx = html.indexOf(marker);
    if (idx < 0) return null;
    const start = html.indexOf('{', idx);
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          const jsonText = html.slice(start, i + 1);
          return safeJsonParse(jsonText);
        }
      }
    }
    return null;
  }

  function pickBestThumbnail(thumbnails) {
    const list = Array.isArray(thumbnails) ? thumbnails : [];
    const sorted = list
      .map((t) => ({ url: normalizeUrl(t?.url || ''), w: Number(t?.width || 0), h: Number(t?.height || 0) }))
      .filter((t) => t.url)
      .sort((a, b) => (b.w - a.w) || (b.h - a.h));
    return sorted[0]?.url || '';
  }

  function buildReplyText(target, parsed) {
    const lines = [];
    lines.push(`YouTube解析 (youtube): ${target.id}`);
    if (parsed?.title) lines.push(`标题: ${parsed.title}`);
    if (parsed?.author) lines.push(`作者: ${parsed.author}`);
    if (parsed?.durationText) lines.push(`时长: ${parsed.durationText}`);
    if (parsed?.viewsText) lines.push(`播放: ${parsed.viewsText}`);
    if (parsed?.publishDate) lines.push(`发布时间: ${parsed.publishDate}`);
    if (parsed?.thumbnail) lines.push(`封面: ${parsed.thumbnail}`);
    if (Array.isArray(parsed?.medias) && parsed.medias.length) {
      lines.push(`媒体: ${parsed.medias.length}`);
      for (const m of parsed.medias.slice(0, 4)) {
        if (m?.type === 'video') lines.push(`视频: ${m.url}`);
        if (m?.type === 'audio') lines.push(`音频: ${m.url}`);
      }
    } else {
      lines.push('媒体: (未获取到直链，YouTube 多数流需要解签)');
    }
    lines.push(`链接: https://www.youtube.com/watch?v=${target.id}`);
    return lines.filter(Boolean).join('\n');
  }

  function parseGooglevideoLinksFromTurboScribeHtml(html) {
    const text = String(html || '');
    const hrefs = [];

    // capture href="..."; keep it broad but only accept googlevideo videoplayback links
    const re = /href="([^"]+)"/g;
    let m;
    while ((m = re.exec(text))) {
      const raw = htmlUnescape(m[1]);
      if (!raw) continue;
      if (!/googlevideo\.com\/videoplayback/i.test(raw)) continue;
      hrefs.push(raw);
    }

    const unique = Array.from(new Set(hrefs));
    const medias = [];
    for (const u of unique) {
      let type = 'video';
      try {
        const urlObj = new URL(u);
        const mime = urlObj.searchParams.get('mime') || '';
        if (mime.startsWith('audio/')) type = 'audio';
        else if (mime.startsWith('video/')) type = 'video';
      } catch {}
      medias.push({ type, url: u, source: 'turboscribe' });
    }

    // Prefer MP4 video + M4A audio if available
    const score = (m) => {
      try {
        const urlObj = new URL(m.url);
        const mime = urlObj.searchParams.get('mime') || '';
        const itag = Number(urlObj.searchParams.get('itag') || 0);
        const isMp4 = /video\/mp4/i.test(mime);
        const isM4a = /audio\/mp4/i.test(mime);
        const isWebm = /webm/i.test(mime);
        const base = m.type === 'video' ? 1000 : 500;
        return base + (isMp4 ? 200 : 0) + (isM4a ? 200 : 0) - (isWebm ? 20 : 0) + (itag || 0) / 1000;
      } catch {
        return 0;
      }
    };

    const videos = medias.filter((x) => x.type === 'video').sort((a, b) => score(b) - score(a));
    const audios = medias.filter((x) => x.type === 'audio').sort((a, b) => score(b) - score(a));
    const picked = [];
    if (videos[0]) picked.push(videos[0]);
    if (audios[0]) picked.push(audios[0]);
    return { all: medias, picked };
  }

  function parseTurboScribeMetaFromHtml(html, videoId) {
    const text = String(html || '');

    const takeH1 = () => {
      const m = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (!m) return '';
      const stripped = m[1].replace(/<[^>]+>/g, ' ');
      return htmlUnescape(stripped).replace(/\s+/g, ' ').trim();
    };

    const takeThumb = () => {
      if (!videoId) return '';
      const re = new RegExp(`https:\\\\/\\\\/i\\\\.ytimg\\\\.com\\\\/vi\\\\/${videoId}\\\\/[^\"'\\s>]+`, 'i');
      const m = text.match(re);
      return m ? htmlUnescape(m[0]).trim() : '';
    };

    return {
      title: takeH1(),
      thumbnail: takeThumb()
    };
  }

  async function tryTurboScribeResult(videoId) {
    try {
      const payload = { url: `https://www.youtube.com/watch?v=${videoId}` };
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Connection: 'keep-alive',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Content-Type': 'application/json',
        'sec-ch-ua-platform': '"Windows"',
        'x-turbolinks-loaded': '',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'x-lev-xhr': '',
        'sec-ch-ua-mobile': '?0',
        origin: 'https://turboscribe.ai',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        referer: "https://turboscribe.ai/zh-CN/downloader/youtube/video/free",
        'accept-language': 'zh-CN,zh;q=0.9,ko;q=0.8',
        Cookie: 'lev=1; device-pixel-ratio=1; time-zone=Asia%2FShanghai; js=1',
        priority: 'u=1, i'
      };

      const resp = await axios.post(TURBOSCRIBE_API_URL, payload, {
        timeout: 20000,
        headers,
        responseType: 'arraybuffer',
        transformResponse: (r) => r
      });

      const encoding = String(resp?.headers?.['content-encoding'] || '').toLowerCase();
      let buf = Buffer.isBuffer(resp?.data) ? resp.data : Buffer.from(resp?.data || []);
      try {
        if (encoding.includes('gzip')) buf = zlib.gunzipSync(buf);
        else if (encoding.includes('br')) buf = zlib.brotliDecompressSync(buf);
        else if (encoding.includes('deflate')) buf = zlib.inflateSync(buf);
        else if (encoding.includes('zstd')) buf = zlib.zstdDecompressSync(buf);
      } catch {}

      const html = buf.toString('utf8');
      const parsed = parseGooglevideoLinksFromTurboScribeHtml(html);
      const meta = parseTurboScribeMetaFromHtml(html, videoId);

      if (Array.isArray(parsed?.picked) && parsed.picked.length) return { medias: parsed.picked, meta };
      if (Array.isArray(parsed?.all) && parsed.all.length) return { medias: parsed.all.slice(0, 2), meta };
      if (meta?.title || meta?.thumbnail) return { medias: [], meta };
      return null;
    } catch (e) {
      console.log('[youtube] turboscribe failed:', e?.message || e);
      return null;
    }
  }

  async function fetchWatchHtml(videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}&pbj=0&hl=zh-CN`;
    const resp = await axios.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Cookie: ytConsentCookie()
      },
      responseType: 'text',
      transformResponse: (r) => r
    });
    return String(resp?.data || '');
  }

  async function fetchOembed(videoId) {
    const url = 'https://www.youtube.com/oembed';
    const watch = `https://www.youtube.com/watch?v=${videoId}`;
    const resp = await axios.get(url, {
      params: { url: watch, format: 'json' },
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: watch,
        Origin: 'https://www.youtube.com',
        Cookie: ytConsentCookie()
      }
    });
    return resp?.data;
  }

  async function parseVideo(videoId) {
    const parsed = {
      id: videoId,
      title: '',
      author: '',
      durationText: '',
      viewsText: '',
      publishDate: '',
      thumbnail: '',
      medias: []
    };

    // 鏇村畬鏁翠俊鎭細浠?watch HTML 鎻愬彇 ytInitialPlayerResponse
    try {
      const html = await fetchWatchHtml(videoId);
      const player =
        extractJsonObjectAfter(html, 'var ytInitialPlayerResponse =') ||
        extractJsonObjectAfter(html, 'ytInitialPlayerResponse =') ||
        extractJsonObjectAfter(html, '"ytInitialPlayerResponse":');

      const videoDetails = player?.videoDetails || {};
      if (!parsed.title && videoDetails?.title) parsed.title = String(videoDetails.title);
      if (!parsed.author && videoDetails?.author) parsed.author = String(videoDetails.author);
      if (!parsed.thumbnail && videoDetails?.thumbnail?.thumbnails) parsed.thumbnail = pickBestThumbnail(videoDetails.thumbnail.thumbnails);

      const len = Number(videoDetails?.lengthSeconds || 0);
      if (len > 0 && typeof secondsToDurationText === 'function') parsed.durationText = secondsToDurationText(len);
      else if (len > 0) parsed.durationText = `${len}s`;

      const views = Number(videoDetails?.viewCount || 0);
      if (views > 0) parsed.viewsText = String(views);

      const micro = player?.microformat?.playerMicroformatRenderer;
      if (micro?.publishDate) parsed.publishDate = String(micro.publishDate);

      // 灏濊瘯浠?streamingData 鍙栫洿閾撅紙鍙兘闇€瑕佽В绛撅紝鎷夸笉鍒板氨蹇界暐锛?      const dashUrl = player?.streamingData?.dashManifestUrl;
      const hlsUrl = player?.streamingData?.hlsManifestUrl;
      const formats = [
        ...(player?.streamingData?.adaptiveFormats || []),
        ...(player?.streamingData?.formats || [])
      ];
      const out = [];
      if (dashUrl && typeof dashUrl === 'string' && /^https?:\/\//i.test(dashUrl)) {
        out.push({ type: 'video', url: dashUrl, label: 'dashManifestUrl' });
      }
      if (hlsUrl && typeof hlsUrl === 'string' && /^https?:\/\//i.test(hlsUrl)) {
        out.push({ type: 'video', url: hlsUrl, label: 'hlsManifestUrl' });
      }
      for (const f of formats) {
        const url = f?.url;
        if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
        const mime = String(f?.mimeType || '');
        if (mime.startsWith('video/')) out.push({ type: 'video', url });
        else if (mime.startsWith('audio/')) out.push({ type: 'audio', url });
      }
      parsed.medias = out.slice(0, 4);
    } catch (e) {
      console.log('[youtube] watch parse failed:', e?.message || e);
    }

    if (!parsed.medias.length || !parsed.title || !parsed.thumbnail) {
      const ts = await tryTurboScribeResult(videoId);
      if (ts?.meta) {
        if (!parsed.title && ts.meta.title) parsed.title = ts.meta.title;
      if (!parsed.thumbnail && ts.meta.thumbnail) parsed.thumbnail = normalizeUrl(ts.meta.thumbnail);
      }
      if (!parsed.medias.length && Array.isArray(ts?.medias) && ts.medias.length) {
        parsed.medias = ts.medias;
      }
    }

    if (!parsed.title || !parsed.author || !parsed.thumbnail) {
      try {
        const o = await fetchOembed(videoId);
        if (!parsed.title && o?.title) parsed.title = String(o.title);
        if (!parsed.author && o?.author_name) parsed.author = String(o.author_name);
        if (!parsed.thumbnail && o?.thumbnail_url) parsed.thumbnail = normalizeUrl(o.thumbnail_url);
      } catch (e) {
        console.log('[youtube] oembed failed:', e?.message || e);
      }
    }

    return parsed;
  }

  async function processTarget(target) {
    const parsed = await parseVideo(target.id);
    const replyText = buildReplyText(target, parsed);
    return { target, parsed, replyText };
  }

  return {
    name: 'youtube',
    detect,
    process: processTarget,
    helpers: { extractVideoIdFromText, parseVideo }
  };
}

module.exports = { buildYoutubePlugin };
