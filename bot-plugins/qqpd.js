function buildQqpdPlugin(ctx) {
  const { axios, config } = ctx;

  const SHORT_URL_RE = /https?:\/\/pd\.qq\.com\/s\/([a-zA-Z0-9]+)(?:\?[^\s]*)?/i;
  const DIRECT_URL_RE =
    /https?:\/\/pd\.qq\.com\/g\/([^/\s]+)\/post\/([A-Za-z0-9_]+)(?:\?[^\s]*)?/i;
  const FEED_DETAIL_API =
    'https://pd.qq.com/qunng/guild/gotrpc/noauth/trpc.qchannel.commreader.ComReader/GetFeedDetail';
  const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

  function getPluginConfig() {
    return config?.qqpd || {};
  }

  function getUserAgent() {
    return String(getPluginConfig().userAgent || DEFAULT_USER_AGENT);
  }

  function detect(text) {
    if (!text) return null;
    const source = String(text);
    const directMatch = source.match(DIRECT_URL_RE);
    if (directMatch) {
      return {
        platform: 'qqpd',
        type: 'feed',
        subtype: 'direct',
        guildNum: String(directMatch[1]),
        feedId: String(directMatch[2]),
        url: directMatch[0]
      };
    }

    const shortMatch = source.match(SHORT_URL_RE);
    if (!shortMatch) return null;

    return {
      platform: 'qqpd',
      type: 'feed',
      subtype: 'short',
      slug: String(shortMatch[1]),
      url: shortMatch[0]
    };
  }

  function parseSetCookie(headers) {
    const list = Array.isArray(headers?.['set-cookie']) ? headers['set-cookie'] : [];
    const out = {};

    for (const raw of list) {
      const first = String(raw || '').split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
    }

    return out;
  }

  function mergeCookieMaps(...maps) {
    return Object.assign({}, ...maps.filter(Boolean));
  }

  function buildCookieHeader(cookieMap) {
    return Object.entries(cookieMap || {})
      .filter(([key, value]) => key && value !== undefined && value !== null && String(value) !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  function ensureApiCookies(cookieMap) {
    const out = { ...(cookieMap || {}) };
    if (!out.p_uin && out.uuid) out.p_uin = out.uuid;
    if (!out.uuid && out.p_uin) out.uuid = out.p_uin;
    return out;
  }

  function resolveUrl(base, next) {
    try {
      return new URL(String(next || ''), String(base || '')).toString();
    } catch {
      return String(next || base || '');
    }
  }

  async function openSharePage(url) {
    let currentUrl = url;
    let cookieMap = {};
    let html = '';
    let status = 0;

    for (let i = 0; i < 6; i += 1) {
      const headers = {
        'User-Agent': getUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://pd.qq.com/'
      };

      const cookieHeader = buildCookieHeader(cookieMap);
      if (cookieHeader) headers.Cookie = cookieHeader;

      const resp = await axios.get(currentUrl, {
        timeout: 20000,
        maxRedirects: 0,
        validateStatus: (code) => code >= 200 && code < 400,
        headers
      });

      status = Number(resp?.status || 0);
      cookieMap = mergeCookieMaps(cookieMap, parseSetCookie(resp?.headers));

      if (status >= 300 && status < 400 && resp?.headers?.location) {
        currentUrl = resolveUrl(currentUrl, resp.headers.location);
        continue;
      }

      html = typeof resp?.data === 'string' ? resp.data : '';
      break;
    }

    return {
      shortUrl: url,
      finalUrl: currentUrl,
      html,
      status,
      cookies: ensureApiCookies(cookieMap)
    };
  }

  function firstMatch(text, patterns) {
    const source = String(text || '');
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match && match[1]) return String(match[1]);
    }
    return '';
  }

  function buildSearchText(page) {
    const html = String(page?.html || '');
    return [html, html.replace(/\\"/g, '"'), page?.finalUrl || '', page?.shortUrl || ''].join('\n');
  }

  function extractMetaContent(html, key) {
    const source = String(html || '');
    const patternA = new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i');
    const patternB = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${key}["']`, 'i');
    const match = source.match(patternA) || source.match(patternB);
    return match && match[1] ? match[1] : '';
  }

  function tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function decodeEscapedJsonString(raw) {
    try {
      return JSON.parse(`"${String(raw || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    } catch {
      return '';
    }
  }

  function extractShareCardInfoObject(html) {
    const source = String(html || '');
    const match = source.match(/"shareCardInfo":"((?:\\.|[^"])*)"/i);
    if (!match || !match[1]) return null;
    const decoded = decodeEscapedJsonString(match[1]);
    return tryParseJson(decoded);
  }

  function buildNormalizedChannelShareInfo(raw, fallback = {}) {
    const posterID = String(raw?.posterID || raw?.poster_id || fallback.posterID || '');
    const feedPublishAt = String(raw?.feedPublishAt || raw?.feed_publish_at || fallback.feedPublishAt || '');
    const feedID = String(raw?.feedID || raw?.feed_id || fallback.feedID || '');
    const channelSignRaw = raw?.channelSign || raw?.channel_sign || {};
    const fallbackChannelSign = fallback.channelSign || {};
    const channel_id = String(channelSignRaw?.channel_id || fallbackChannelSign.channel_id || '');
    const guild_id = String(channelSignRaw?.guild_id || fallbackChannelSign.guild_id || '');

    if (!posterID || !feedPublishAt || !feedID || !channel_id || !guild_id) return null;

    return {
      posterID,
      feedPublishAt,
      channelSign: {
        channel_id,
        guild_type: channelSignRaw?.guild_type ?? fallbackChannelSign.guild_type ?? null,
        guild_id,
        url: channelSignRaw?.url ?? fallbackChannelSign.url ?? null,
        join_guild_sig: channelSignRaw?.join_guild_sig ?? fallbackChannelSign.join_guild_sig ?? null,
        channel_type: channelSignRaw?.channel_type ?? fallbackChannelSign.channel_type ?? null,
        group_id: channelSignRaw?.group_id ?? fallbackChannelSign.group_id ?? null
      },
      sign: raw?.sign ?? fallback.sign ?? null,
      updateDurationMs: String(raw?.updateDurationMs || raw?.update_duration_ms || fallback.updateDurationMs || '300000000000'),
      feedID
    };
  }

  function extractDirectChannelShareInfo(searchText) {
    return buildNormalizedChannelShareInfo({
      posterID: firstMatch(searchText, [
        /"posterID"\s*:\s*"([^"]+)"/i,
        /"posterID"\s*:\s*(\d+)/i,
        /"poster_id"\s*:\s*"([^"]+)"/i,
        /"poster_id"\s*:\s*(\d+)/i
      ]),
      feedPublishAt: firstMatch(searchText, [
        /"feedPublishAt"\s*:\s*"([^"]+)"/i,
        /"feedPublishAt"\s*:\s*(\d+)/i,
        /"feed_publish_at"\s*:\s*"([^"]+)"/i,
        /"feed_publish_at"\s*:\s*(\d+)/i
      ]),
      feedID: firstMatch(searchText, [
        /"feedID"\s*:\s*"([^"]+)"/i,
        /"feed_id"\s*:\s*"([^"]+)"/i,
        /feed-content-([A-Za-z0-9_]+)/i
      ]),
      updateDurationMs: firstMatch(searchText, [
        /"updateDurationMs"\s*:\s*"([^"]+)"/i,
        /"updateDurationMs"\s*:\s*(\d+)/i,
        /"update_duration_ms"\s*:\s*"([^"]+)"/i,
        /"update_duration_ms"\s*:\s*(\d+)/i
      ]),
      channelSign: {
        channel_id: firstMatch(searchText, [
          /"channel_id"\s*:\s*"([^"]+)"/i,
          /"channel_id"\s*:\s*(\d+)/i
        ]),
        guild_id: firstMatch(searchText, [
          /"guild_id"\s*:\s*"([^"]+)"/i,
          /"guild_id"\s*:\s*(\d+)/i
        ])
      }
    });
  }

  function extractShareSeed(page) {
    const searchText = buildSearchText(page);
    const shareCardInfo = extractShareCardInfoObject(page?.html);
    const detail = shareCardInfo?.meta?.detail || {};
    const detailChannelInfo = detail?.channel_info || {};
    const detailFeed = detail?.feed || {};
    const detailPoster = detail?.poster || {};
    const channelShareInfo =
      buildNormalizedChannelShareInfo(detail?.channelShareInfo || detail?.channel_share_info || {}) ||
      extractDirectChannelShareInfo(searchText);

    return {
      feedId:
        firstMatch(searchText, [
          /feed-content-([A-Za-z0-9_]+)/i,
          /https:\/\/pd\.qq\.com\/g\/[^/\s]+\/post\/([A-Za-z0-9_]+)/i
        ]) ||
        String(detailFeed?.feed_id || channelShareInfo?.feedID || ''),
      posterId:
        String(detailPoster?.str_tiny_id || detailPoster?.tiny_id || channelShareInfo?.posterID || '') ||
        firstMatch(searchText, [
          /"str_tiny_id"\s*:\s*"([^"]+)"/i,
          /"posterID"\s*:\s*"([^"]+)"/i,
          /"poster_id"\s*:\s*"([^"]+)"/i,
          /"posterID"\s*:\s*(\d+)/i,
          /"poster_id"\s*:\s*(\d+)/i
        ]),
      feedPublishAt:
        String(detailFeed?.create_time || channelShareInfo?.feedPublishAt || '') ||
        firstMatch(searchText, [
          /"feedPublishAt"\s*:\s*"([^"]+)"/i,
          /"feed_publish_at"\s*:\s*"([^"]+)"/i,
          /"feedPublishAt"\s*:\s*(\d+)/i,
          /"feed_publish_at"\s*:\s*(\d+)/i,
          /"create_time"\s*:\s*(\d+)/i
        ]),
      channelId:
        String(detailChannelInfo?.channel_id || channelShareInfo?.channelSign?.channel_id || '') ||
        firstMatch(searchText, [
          /"channel_id"\s*:\s*"([^"]+)"/i,
          /"channel_id"\s*:\s*(\d+)/i
        ]),
      guildId:
        String(detailChannelInfo?.guild_id || channelShareInfo?.channelSign?.guild_id || '') ||
        firstMatch(searchText, [
          /"guild_id"\s*:\s*"([^"]+)"/i,
          /"guild_id"\s*:\s*(\d+)/i
        ]),
      title:
        firstMatch(searchText, [/"prompt"\s*:\s*"\[频道帖子\]([^"]+)"/i]) ||
        extractMetaContent(page?.html, 'og:title') ||
        extractMetaContent(page?.html, 'twitter:title'),
      longUrl: firstMatch(searchText, [/(https:\/\/pd\.qq\.com\/g\/[^"\s]+\/post\/[A-Za-z0-9_]+)/i]) || '',
      shareCardInfo,
      channelShareInfo
    };
  }

  function buildRequestHeaders(page, cookieMap) {
    const headers = {
      'User-Agent': getUserAgent(),
      Connection: 'keep-alive',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
      'sec-ch-ua-mobile': '?0',
      'x-oidb': '{"uint32_service_type":5}',
      'x-qq-client-appid': '537246381',
      Origin: 'https://pd.qq.com',
      Referer: page?.finalUrl || page?.shortUrl || 'https://pd.qq.com/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Accept-Language': 'zh-CN,zh;q=0.9,ko;q=0.8'
    };

    const cookieHeader = buildCookieHeader(ensureApiCookies(cookieMap));
    if (cookieHeader) headers.Cookie = cookieHeader;
    return headers;
  }

  function buildPayloadCandidates(seed) {
    const minimalFeedId = String(seed.feedId || '');
    const minimalGuildId = String(seed.guildId || '');
    const minimalChannelId = String(seed.channelId || '');
    const minimalCandidates =
      minimalFeedId && minimalGuildId && minimalChannelId
        ? [
            {
              feedId: minimalFeedId,
              channelSign: {
                guild_id: minimalGuildId,
                channel_id: minimalChannelId
              }
            },
            {
              feed_id: minimalFeedId,
              channelSign: {
                guild_id: minimalGuildId,
                channel_id: minimalChannelId
              }
            }
          ]
        : [];

    const baseChannelShareInfo = buildNormalizedChannelShareInfo(seed?.channelShareInfo || {}, {
      posterID: String(seed.posterId || ''),
      feedPublishAt: String(seed.feedPublishAt || ''),
      feedID: String(seed.feedId || ''),
      channelSign: {
        channel_id: String(seed.channelId || ''),
        guild_id: String(seed.guildId || ''),
        guild_type: null,
        url: null,
        join_guild_sig: null,
        channel_type: null,
        group_id: null
      },
      sign: null,
      updateDurationMs: '300000000000'
    });

    if (!baseChannelShareInfo) return minimalCandidates;

    const minimalCamel = {
      feedId: baseChannelShareInfo.feedID,
      channelSign: {
        guild_id: baseChannelShareInfo.channelSign.guild_id,
        channel_id: baseChannelShareInfo.channelSign.channel_id
      }
    };

    const minimalSnake = {
      feed_id: baseChannelShareInfo.feedID,
      channelSign: {
        guild_id: baseChannelShareInfo.channelSign.guild_id,
        channel_id: baseChannelShareInfo.channelSign.channel_id
      }
    };

    const snakeChannelShareInfo = {
      poster_id: baseChannelShareInfo.posterID,
      feed_publish_at: baseChannelShareInfo.feedPublishAt,
      channel_sign: {
        channel_id: baseChannelShareInfo.channelSign.channel_id,
        guild_type: baseChannelShareInfo.channelSign.guild_type,
        guild_id: baseChannelShareInfo.channelSign.guild_id,
        url: baseChannelShareInfo.channelSign.url,
        join_guild_sig: baseChannelShareInfo.channelSign.join_guild_sig,
        channel_type: baseChannelShareInfo.channelSign.channel_type,
        group_id: baseChannelShareInfo.channelSign.group_id
      },
      sign: baseChannelShareInfo.sign,
      update_duration_ms: baseChannelShareInfo.updateDurationMs,
      feed_id: baseChannelShareInfo.feedID
    };

    return [
      ...minimalCandidates,
      minimalCamel,
      minimalSnake,
      baseChannelShareInfo,
      { channelShareInfo: baseChannelShareInfo },
      snakeChannelShareInfo,
      { share_info: snakeChannelShareInfo },
      {
        feedID: baseChannelShareInfo.feedID,
        posterID: baseChannelShareInfo.posterID,
        feedPublishAt: baseChannelShareInfo.feedPublishAt,
        channelSign: baseChannelShareInfo.channelSign,
        sign: baseChannelShareInfo.sign,
        updateDurationMs: baseChannelShareInfo.updateDurationMs
      },
      {
        feed_id: baseChannelShareInfo.feedID,
        poster_id: baseChannelShareInfo.posterID,
        feed_publish_at: baseChannelShareInfo.feedPublishAt,
        channel_sign: snakeChannelShareInfo.channel_sign,
        sign: snakeChannelShareInfo.sign,
        update_duration_ms: snakeChannelShareInfo.update_duration_ms
      }
    ];
  }

  function isSuccessResponse(data) {
    return Number(data?.retcode || 0) === 0 && Number(data?.error?.code || 0) === 0 && data?.data?.feed?.id;
  }

  async function fetchFeedDetail(page, seed) {
    const headers = buildRequestHeaders(page, page?.cookies);
    const attempts = [];

    for (const payload of buildPayloadCandidates(seed)) {
      try {
        const resp = await axios.post(FEED_DETAIL_API, payload, {
          timeout: 20000,
          headers,
          validateStatus: () => true
        });

        attempts.push({
          status: Number(resp?.status || 0),
          retcode: resp?.data?.retcode,
          errorCode: resp?.data?.error?.code,
          errorMessage: resp?.data?.error?.message || resp?.data?.message || '',
          payload
        });

        if (resp?.status === 200 && isSuccessResponse(resp?.data)) {
          return {
            status: resp.status,
            payload,
            attempts,
            data: resp.data
          };
        }
      } catch (error) {
        attempts.push({
          error: error?.message || String(error),
          payload
        });
      }
    }

    const summary = attempts
      .map((item, index) => {
        if (item.error) return `#${index + 1} error=${item.error}`;
        return `#${index + 1} status=${item.status || 0} retcode=${item.retcode ?? ''} errorCode=${item.errorCode ?? ''} message=${item.errorMessage || ''}`;
      })
      .join(' | ');
    const err = new Error(`qqpd feed detail request failed${summary ? `: ${summary}` : ''}`);
    err.attempts = attempts;
    throw err;
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function unixTimeToText(sec) {
    const value = Number(sec || 0);
    if (!Number.isFinite(value) || value <= 0) return '';
    try {
      return new Date(value * 1000).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return '';
    }
  }

  function extractContentsText(contents) {
    const list = Array.isArray(contents) ? contents : [];
    const parts = [];

    for (const item of list) {
      if (item?.text_content?.text) parts.push(String(item.text_content.text));
      else if (item?.url_content?.url) parts.push(String(item.url_content.url));
      else if (item?.at_content?.nick) parts.push(`@${item.at_content.nick}`);
      else if (item?.emoji_content?.id) parts.push('[emoji]');
    }

    return normalizeText(parts.join(''));
  }

  function pickImageUrl(image) {
    const variants = Array.isArray(image?.vecImageUrl) ? image.vecImageUrl : [];
    const best = variants
      .filter((item) => item?.url)
      .sort((a, b) => Number(b?.width || 0) - Number(a?.width || 0))[0];
    return String(best?.url || image?.picUrl || '');
  }

  function parseFeedResponse(detail, page, seed) {
    const feed = detail?.data?.data?.feed || {};
    const channelInfo = feed?.channelInfo || {};
    const poster = feed?.poster || {};

    return {
      id: String(feed?.id || seed.feedId || ''),
      title: extractContentsText(feed?.title?.contents) || seed.title || '',
      content: extractContentsText(feed?.contents?.contents),
      authorName: String(poster?.nick || ''),
      guildName: String(channelInfo?.guild_name || ''),
      channelName: String(channelInfo?.name || ''),
      guildNumber: String(channelInfo?.guild_number || ''),
      createTime: unixTimeToText(feed?.createTime || seed.feedPublishAt),
      province: String(feed?.ip_location_province || ''),
      commentCount: Number(feed?.commentCount || 0),
      likeCount: Number(feed?.total_like?.like_count || 0),
      preferCount: Number(feed?.total_prefer?.prefer_count || 0),
      collectCount: Number(feed?.total_collect?.collect_count || 0),
      shareCount: Number(feed?.share?.sharedCount || 0),
      viewCount: Number(feed?.visitorInfo?.viewCount || 0),
      images: (Array.isArray(feed?.images) ? feed.images : []).map((item) => pickImageUrl(item)).filter(Boolean),
      url: page?.shortUrl || page?.finalUrl || ''
    };
  }

  function buildReplyText(parsed) {
    const lines = [];
    const body = String(parsed?.content || '');
    const preview = body.length > 1200 ? `${body.slice(0, 1200)}...` : body;

    lines.push(`QQ频道解析 (qqpd): ${parsed?.id || '-'}`);
    if (parsed?.title) lines.push(`标题: ${parsed.title}`);
    if (parsed?.authorName) lines.push(`作者: ${parsed.authorName}`);
    if (parsed?.guildName || parsed?.channelName) lines.push(`频道: ${parsed.guildName || '-'} / ${parsed.channelName || '-'}`);
    if (parsed?.guildNumber) lines.push(`频道号: ${parsed.guildNumber}`);
    if (parsed?.createTime) lines.push(`发布时间: ${parsed.createTime}`);
    if (parsed?.province) lines.push(`IP属地: ${parsed.province}`);

    const stats = [
      parsed?.viewCount > 0 ? `浏览: ${parsed.viewCount}` : null,
      Number.isFinite(parsed?.commentCount) ? `评论: ${parsed.commentCount}` : null,
      Number.isFinite(parsed?.likeCount) ? `点赞: ${parsed.likeCount}` : null,
      parsed?.preferCount > 0 ? `表态: ${parsed.preferCount}` : null,
      parsed?.collectCount > 0 ? `收藏: ${parsed.collectCount}` : null,
      parsed?.shareCount > 0 ? `分享: ${parsed.shareCount}` : null
    ].filter(Boolean);
    if (stats.length) lines.push(stats.join(' / '));

    if (preview) lines.push(`\n正文:\n${preview}`);
    if (Array.isArray(parsed?.images) && parsed.images.length) {
      lines.push(`图片(${parsed.images.length}):`);
      for (const imageUrl of parsed.images.slice(0, 6)) {
        lines.push(imageUrl);
      }
    }
    if (parsed?.url) lines.push(`链接: ${parsed.url}`);

    return lines.join('\n');
  }

  async function process(target) {
    const page = await openSharePage(target.url);
    const seed = extractShareSeed(page);

    if (!seed.feedId && target.feedId) {
      seed.feedId = String(target.feedId);
    }

    if (!seed.feedId || !seed.channelId || !seed.guildId) {
      throw new Error('qqpd share seed missing required fields');
    }

    const detail = await fetchFeedDetail(page, seed);
    const parsed = parseFeedResponse(detail, page, seed);

    return {
      target,
      page,
      seed,
      parsed,
      detail: detail.data,
      replyText: buildReplyText(parsed)
    };
  }

  return {
    name: 'qqpd',
    detect,
    process,
    helpers: {
      openSharePage,
      extractShareSeed,
      fetchFeedDetail
    }
  };
}

module.exports = { buildQqpdPlugin };
