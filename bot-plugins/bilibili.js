function buildBilibiliPlugin(ctx) {
  const {
    axios,
    buildBiliCookie,
    getWbiKeys,
    encWbi,
    pickModule,
    secondsToDurationText
  } = ctx;

  const SEARCH_TYPES = new Set([
    'video',
    'media_bangumi',
    'media_ft',
    'live',
    'live_room',
    'live_user',
    'article',
    'topic',
    'bili_user',
    'photo'
  ]);

  function stripHtmlTags(text) {
    return String(text || '').replace(/<[^>]+>/g, '').replace(/"/g, '"').replace(/'/g, "'").replace(/</g, '<').replace(/>/g, '>').replace(/&/g, '&').trim();
  }

  function parseSearchCommand(text) {
    const s = String(text || '').trim();
    if (!s.startsWith('/func-bsearch')) return null;

    const pageMatch = s.match(/-page-(\d+)$/i);
    const page = pageMatch ? Math.max(1, Number(pageMatch[1]) || 1) : 1;
    const body = pageMatch ? s.slice(0, pageMatch.index) : s;

    const prefix = '/func-bsearch';
    let rest = body.slice(prefix.length);
    if (rest.startsWith('-')) rest = rest.slice(1);
    rest = rest.trim();
    if (!rest) return null;

    const firstSep = rest.indexOf('-');
    let searchType = 'video';
    let keyword = rest;

    if (firstSep > 0) {
      const maybeType = rest.slice(0, firstSep).trim();
      const maybeKeyword = rest.slice(firstSep + 1).trim();
      if (SEARCH_TYPES.has(maybeType) && maybeKeyword) {
        searchType = maybeType;
        keyword = maybeKeyword;
      }
    }

    keyword = keyword.trim();
    if (!keyword) return null;
    return { platform: 'bilibili', type: 'search', searchType, keyword, page };
  }

  function detect(text) {
    if (!text) return null;
    const s = String(text);

    const searchCommand = parseSearchCommand(s);
    if (searchCommand) {
      return searchCommand;
    }

    const kurobbsUrlPattern = /kurobbs\.com\/(?:postDetail\.html\?[^\s]*\bpostId=\d+|(?:pns|mc)\/post\/\d+)/i;
    if (kurobbsUrlPattern.test(s)) {
      return null;
    }

    const biliAudioMatch = s.match(/bilibili\.com\/audio\/au(\d+)/i)
      || s.match(/\bau(\d{4,})\b/i)
      || s.match(/[?&]sid=(\d+)/i);
    if (biliAudioMatch) {
      return { platform: 'bilibili', type: 'bili_audio', id: biliAudioMatch[1] };
    }

    const bvMatch = s.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i)
      || s.match(/\b(BV[0-9A-Za-z]{10})\b/i);
    if (bvMatch) {
      return { platform: 'bilibili', type: 'video', id: bvMatch[1] };
    }

    const opusMatch = s.match(/(?:biliopus|opus)\/?-?(\d{5,})/i) || s.match(/bilibili\.com\/opus\/(\d{5,})/i);
    if (opusMatch) {
      return { platform: 'bilibili', type: 'opus', id: opusMatch[1] };
    }

    const dynamicMatch = s.match(/(?:bilidy|dynamic)\/?-?(\d{5,})/i) || s.match(/t\.bilibili\.com\/(\d{5,})/i);
    if (dynamicMatch) {
      return { platform: 'bilibili', type: 'dynamic', id: dynamicMatch[1] };
    }

    const musicMatch = s.match(/music\.bilibili\.com\/(?:h5\/)?h5-?music-detail\?[^\s]*\bmusic_id=(MA\d+)/i)
      || s.match(/music\.bilibili\.com\/(?:h5\/)?music-detail\?[^\s]*\bmusic_id=(MA\d+)/i)
      || s.match(/\bmusic_id=(MA\d+)/i);
    if (musicMatch) {
      return { platform: 'bilibili', type: 'music', id: musicMatch[1] };
    }

    const b23Match = s.match(/https?:\/\/(?:b23\.tv|bili2233\.cn)\/([0-9A-Za-z]+)/i);
    if (b23Match) {
      return { platform: 'bilibili', type: 'b23', url: b23Match[0] };
    }

    const rawId = s.match(/\b(\d{16,20})\b/);
    if (rawId) {
      // 避免把 X/Twitter 的 status id 误判成 B 站 opus id
      const hasXLink = /https?:\/\/(?:x\.com|twitter\.com)\//i.test(s);
      const hasBiliHint = /(?:bilibili\.com|b23\.tv|bili2233\.cn|t\.bilibili\.com|biliopus|opus)/i.test(s);
      if (!hasXLink && hasBiliHint) {
        return { platform: 'bilibili', type: 'opus', id: rawId[1] };
      }
    }

    return null;
  }

  function formatCount(num) {
    const n = Number(num);
    if (!Number.isFinite(n)) return null;
    if (n < 10000) return String(n);
    return `${(n / 10000).toFixed(1)}万`;
  }

  function formatDateTime(sec) {
    const n = Number(sec || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n * 1000).toLocaleString('zh-CN', { hour12: false });
  }

  function normalizeUrl(url) {
    if (!url) return '';
    const s = String(url);
    if (s.startsWith('//')) return `https:${s}`;
    return s;
  }

  function codecLabel(codecid) {
    if (Number(codecid) === 7) return 'AVC';
    if (Number(codecid) === 12) return 'HEVC';
    if (Number(codecid) === 13) return 'AV1';
    return String(codecid || '-');
  }

  function audioQualityLabel(id) {
    if (Number(id) === 30216) return '64K';
    if (Number(id) === 30232) return '132K';
    if (Number(id) === 30280) return '192K';
    if (Number(id) === 30250) return '杜比全景声';
    if (Number(id) === 30251) return 'Hi-Res无损';
    return String(id || '-');
  }

  function buildOpusReplyText(opusId, parsed) {
    const { title, authorName, contentText } = parsed;
    const summary = (contentText || '').slice(0, 1200);
    return [
      `B站动态解析 (opus): ${opusId}`,
      title ? `标题: ${title}` : null,
      authorName ? `作者: ${authorName}` : null,
      summary ? `内容摘要:\n${summary}${contentText.length > summary.length ? '...' : ''}` : null,
      `链接: https://www.bilibili.com/opus/${opusId}`
    ].filter(Boolean).join('\n');
  }

  function buildMusicReplyText(musicId, parsed) {
    const summary = (parsed.summary || '').slice(0, 1200);
    const lyricPreview = (parsed.lyric || '').replace(/\r/g, '').slice(0, 400);
    return [
      `B站音乐解析 (music): ${musicId}`,
      parsed.title ? `标题: ${parsed.title}` : null,
      parsed.authorName ? `作者: ${parsed.authorName}` : null,
      parsed.artistList?.length ? `歌手列表: ${parsed.artistList.join(' / ')}` : null,
      parsed.artistIdentityList?.length ? `参与者: ${parsed.artistIdentityList.join(' / ')}` : null,
      parsed.album ? `专辑: ${parsed.album}` : null,
      parsed.durationText ? `时长: ${parsed.durationText}` : null,
      parsed.supportListen === true ? '支持收听: 是' : parsed.supportListen === false ? '支持收听: 否' : null,
      parsed.wishListen === true ? '已想听: 是' : parsed.wishListen === false ? '已想听: 否' : null,
      typeof parsed.playCount === 'number' ? `播放: ${parsed.playCount}` : null,
      typeof parsed.commentCount === 'number' ? `评论: ${parsed.commentCount}` : null,
      typeof parsed.collectCount === 'number' ? `收藏: ${parsed.collectCount}` : null,
      typeof parsed.shareCount === 'number' ? `分享: ${parsed.shareCount}` : null,
      typeof parsed.wishCount === 'number' ? `想听数: ${parsed.wishCount}` : null,
      typeof parsed.coinCount === 'number' ? `投币: ${parsed.coinCount}` : null,
      typeof parsed.likeCount === 'number' ? `点赞: ${parsed.likeCount}` : null,
      typeof parsed.relationCount === 'number' ? `关联数: ${parsed.relationCount}` : null,
      parsed.rank ? `榜单: ${parsed.rank}` : null,
      typeof parsed.hottestRank === 'number' ? `历史最高排名: ${parsed.hottestRank}` : null,
      typeof parsed.onListTimes === 'number' ? `上榜次数: ${parsed.onListTimes}` : null,
      typeof parsed.hotValue === 'number' ? `当前热度: ${parsed.hotValue}` : null,
      typeof parsed.lastHeat === 'number' ? `最近热度: ${parsed.lastHeat}` : null,
      typeof parsed.maxListId === 'number' ? `榜单ID: ${parsed.maxListId}` : null,
      parsed.achievement?.length ? `成就: ${parsed.achievement.join(' / ')}` : null,
      parsed.tags?.length ? `标签: ${parsed.tags.join(' / ')}` : null,
      summary ? `简介:\n${summary}${parsed.summary.length > summary.length ? '...' : ''}` : null,
      lyricPreview ? `歌词预览:\n${lyricPreview}${parsed.lyric.length > lyricPreview.length ? '...' : ''}` : null,
      parsed.category ? `分类: ${parsed.category}` : null,
      parsed.cname ? `分区: ${parsed.cname}` : null,
      parsed.source ? `来源: ${parsed.source}` : null,
      parsed.pubTime ? `发布时间: ${parsed.pubTime}` : null,
      parsed.bvid ? `关联视频BV: ${parsed.bvid}` : null,
      parsed.aid ? `关联视频AV: ${parsed.aid}` : null,
      parsed.cid ? `关联CID: ${parsed.cid}` : null,
      typeof parsed.mvIndexOrder === 'number' ? `MV分P序号: ${parsed.mvIndexOrder}` : null,
      parsed.cover ? `封面: ${parsed.cover}` : null,
      parsed.bgColor ? `主题色: ${parsed.bgColor}` : null,
      `链接: https://music.bilibili.com/h5/music-detail?music_id=${musicId}`
    ].filter(Boolean).join('\n');
  }

  function buildVideoReplyText(bvid, parsed, playInfo) {
    const summary = (parsed.desc || '').slice(0, 1200);
    const lines = [
      `B站视频解析 (video): ${bvid}`,
      parsed.title ? `标题: ${parsed.title}` : null,
      parsed.ownerName ? `UP主: ${parsed.ownerName}` : null,
      parsed.ownerMid ? `UP主MID: ${parsed.ownerMid}` : null,
      parsed.staffNames?.length ? `合作成员: ${parsed.staffNames.join(' / ')}` : null,
      parsed.aid ? `AV号: ${parsed.aid}` : null,
      parsed.bvid ? `BV号: ${parsed.bvid}` : null,
      parsed.cid ? `CID: ${parsed.cid}` : null,
      parsed.durationText ? `时长: ${parsed.durationText}` : null,
      parsed.copyrightText ? `类型: ${parsed.copyrightText}` : null,
      parsed.tname ? `分区: ${parsed.tname}` : null,
      parsed.pubdateText ? `发布时间: ${parsed.pubdateText}` : null,
      parsed.ctimeText ? `投稿时间: ${parsed.ctimeText}` : null,
      parsed.dimensionText ? `分辨率: ${parsed.dimensionText}` : null,
      typeof parsed.view === 'number' ? `播放: ${formatCount(parsed.view)}` : null,
      typeof parsed.danmaku === 'number' ? `弹幕: ${formatCount(parsed.danmaku)}` : null,
      typeof parsed.reply === 'number' ? `评论: ${formatCount(parsed.reply)}` : null,
      typeof parsed.like === 'number' ? `点赞: ${formatCount(parsed.like)}` : null,
      typeof parsed.coin === 'number' ? `投币: ${formatCount(parsed.coin)}` : null,
      typeof parsed.favorite === 'number' ? `收藏: ${formatCount(parsed.favorite)}` : null,
      typeof parsed.share === 'number' ? `分享: ${formatCount(parsed.share)}` : null,
      typeof parsed.hisRank === 'number' && parsed.hisRank > 0 ? `历史最高排行: ${parsed.hisRank}` : null,
      parsed.dynamic ? `同步动态:\n${parsed.dynamic}` : null,
      parsed.tags?.length ? `标签: ${parsed.tags.join(' / ')}` : null,
      parsed.honorTexts?.length ? `荣誉: ${parsed.honorTexts.join(' / ')}` : null,
      parsed.pic ? `封面: ${parsed.pic}` : null,
      summary ? `简介:\n${summary}${parsed.desc.length > summary.length ? '...' : ''}` : null
    ].filter(Boolean);

    if (parsed.pages?.length) {
      lines.push(`分P数: ${parsed.pages.length}`);
      for (const page of parsed.pages.slice(0, 5)) {
        lines.push(`P${page.page}: ${page.part} (${page.durationText}${page.dimensionText ? ` / ${page.dimensionText}` : ''}) [cid:${page.cid}]`);
      }
      if (parsed.pages.length > 5) lines.push('(仅展示前5个分P)');
    }

    if (parsed.subtitleLanguages?.length) {
      lines.push(`字幕: ${parsed.subtitleLanguages.join(' / ')}`);
    }

    if (playInfo?.bestVideoUrl) {
//      lines.push(`最佳视频流: ${playInfo.bestVideoUrl}`);
    }
    if (playInfo?.bestAudioUrl) {
//      lines.push(`最佳音频流: ${playInfo.bestAudioUrl}`);
    }
    if (playInfo?.mp4Url) {
      lines.push(`MP4视频: ${playInfo.mp4Url}`);
    }
    if (playInfo?.acceptDescription?.length) {
//      lines.push(`可用清晰度: ${playInfo.acceptDescription.join(' / ')}`);
    }
    lines.push(`链接: https://www.bilibili.com/video/${bvid}`);
    return lines.join('\n');
  }

  function searchTypeLabel(type) {
    const map = {
      video: '视频',
      media_bangumi: '番剧',
      media_ft: '影视',
      live: '直播',
      live_room: '直播间',
      live_user: '主播',
      article: '专栏',
      topic: '话题',
      bili_user: '用户',
      photo: '相簿'
    };
    return map[type] || type;
  }

  function normalizeBiliCover(url) {
    const s = normalizeUrl(url || '');
    return s.startsWith('http') ? s : normalizeUrl(`https:${s}`);
  }

  function buildSearchReplyText(command, payload) {
    const data = payload?.data || {};
    const items = Array.isArray(data?.result)
      ? data.result
      : command.searchType === 'live' && data?.result && typeof data.result === 'object'
        ? [...(Array.isArray(data.result.live_room) ? data.result.live_room : []), ...(Array.isArray(data.result.live_user) ? data.result.live_user : [])]
        : [];

    const lines = [
      `B站搜索 (${searchTypeLabel(command.searchType)}): ${command.keyword}`,
      `页码: ${data?.page || command.page}/${data?.numPages || '?'}`,
      typeof data?.numResults === 'number' ? `结果数: ${data.numResults}` : null
    ].filter(Boolean);

    if (!items.length) {
      lines.push('无搜索结果');
      return lines.join('\n');
    }

    for (const item of items.slice(0, 5)) {
      if (command.searchType === 'video') {
        lines.push(`- ${stripHtmlTags(item?.title || '')}`);
        lines.push(`  UP: ${stripHtmlTags(item?.author || '')} | BV: ${item?.bvid || '-'} | 播放: ${formatCount(item?.play) || '-'} | 时长: ${item?.duration || '-'}`);
        lines.push(`  链接: https://www.bilibili.com/video/${item?.bvid || ''}`);
        continue;
      }
      if (command.searchType === 'bili_user') {
        lines.push(`- ${stripHtmlTags(item?.uname || '')}`);
        lines.push(`  UID: ${item?.mid || '-'} | 粉丝: ${formatCount(item?.fans) || '-'} | 视频: ${formatCount(item?.videos) || '-'}`);
        lines.push(`  主页: https://space.bilibili.com/${item?.mid || ''}`);
        continue;
      }
      if (command.searchType === 'article') {
        lines.push(`- ${stripHtmlTags(item?.title || '')}`);
        lines.push(`  作者: ${stripHtmlTags(item?.author || '')} | 阅读: ${formatCount(item?.view) || '-'} | 点赞: ${formatCount(item?.like) || '-'}`);
        if (item?.id) lines.push(`  链接: https://www.bilibili.com/read/cv${item.id}`);
        continue;
      }
      if (command.searchType === 'topic') {
        lines.push(`- ${stripHtmlTags(item?.keyword || item?.title || item?.name || '')}`);
        lines.push(`  话题ID: ${item?.topic_id || item?.id || '-'} | 浏览: ${formatCount(item?.view) || '-'} | 讨论: ${formatCount(item?.discuss) || '-'}`);
        continue;
      }
      if (command.searchType === 'photo') {
        lines.push(`- ${stripHtmlTags(item?.title || item?.description || '')}`);
        lines.push(`  UP: ${stripHtmlTags(item?.author || item?.uname || '')} | 相簿ID: ${item?.id || '-'}`);
        if (item?.arcurl) lines.push(`  链接: ${item.arcurl}`);
        continue;
      }
      if (command.searchType === 'media_bangumi' || command.searchType === 'media_ft') {
        lines.push(`- ${stripHtmlTags(item?.title || item?.org_title || '')}`);
        lines.push(`  评分: ${item?.media_score?.score || item?.score || '-'} | 地区: ${stripHtmlTags(item?.areas || item?.area || '')} | 类型: ${stripHtmlTags(item?.styles || item?.style || '')}`);
        if (item?.media_id) lines.push(`  链接: https://www.bilibili.com/bangumi/media/md${item.media_id}`);
        continue;
      }
      if (command.searchType === 'live_room') {
        lines.push(`- ${stripHtmlTags(item?.title || '')}`);
        lines.push(`  主播: ${stripHtmlTags(item?.uname || '')} | 房间号: ${item?.roomid || '-'} | 在线: ${formatCount(item?.online) || '-'}`);
        if (item?.roomid) lines.push(`  链接: https://live.bilibili.com/${item.roomid}`);
        continue;
      }
      if (command.searchType === 'live_user') {
        lines.push(`- ${stripHtmlTags(item?.uname || '')}`);
        lines.push(`  UID: ${item?.mid || '-'} | 粉丝: ${formatCount(item?.fans) || '-'} | 房间号: ${item?.roomid || '-'}`);
        if (item?.roomid) lines.push(`  直播间: https://live.bilibili.com/${item.roomid}`);
        continue;
      }
      if (command.searchType === 'live') {
        const title = stripHtmlTags(item?.title || item?.uname || '');
        lines.push(`- ${title}`);
        lines.push(`  类型: ${item?.type || '-'} | 在线: ${formatCount(item?.online) || '-'} | 房间号: ${item?.roomid || '-'}`);
        if (item?.roomid) lines.push(`  链接: https://live.bilibili.com/${item.roomid}`);
        continue;
      }

      lines.push(`- ${stripHtmlTags(item?.title || item?.uname || item?.keyword || item?.name || '')}`);
    }

    return lines.join('\n');
  }

  async function fetchBiliSearchType(command) {
    const cookie = await buildBiliCookie();
    try {
      await axios.get('https://www.bilibili.com', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
          Referer: 'https://www.bilibili.com/'
        },
        timeout: 20000
      });
    } catch (_) {}

    const { imgKey, subKey } = await getWbiKeys();
    const params = encWbi({
      search_type: command.searchType,
      keyword: command.keyword,
      page: command.page
    }, imgKey, subKey);

    const resp = await axios.get('https://api.bilibili.com/x/web-interface/wbi/search/type', {
      params,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
        Cookie: cookie,
        Accept: 'application/json, text/plain, */*'
      },
      timeout: 20000
    });
    return resp.data;
  }

  async function fetchOpusDetail(opusId) {
    const cookie = await buildBiliCookie();
    const url = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail';
    const features = 'onlyfansVote,onlyfansAssetsV2,decorationCard,htmlNewStyle,ugcDelete,editable,opusPrivateVisible,tribeeEdit,avatarAutoTheme,avatarTypeOpus';
    const resp = await axios.get(url, {
      params: { id: String(opusId), features },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Referer: `https://www.bilibili.com/opus/${opusId}`,
        Cookie: cookie
      },
      timeout: 20000
    });
    return resp.data;
  }

  async function fetchDynamicDetail(dynamicId) {
    const cookie = await buildBiliCookie();
    const url = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail';
    const features = 'itemOpusStyle,opusBigCover,onlyfansVote,endFooterHidden,decorationCard,onlyfansAssetsV2,ugcDelete,onlyfansQaCard,editable,opusPrivateVisible,avatarAutoTheme,sunflowerStyle,cardsEnhance,eva3CardOpus,eva3CardVideo,eva3CardComment,eva3CardVote,eva3CardUser';
    const { imgKey, subKey } = await getWbiKeys();
    const signedParams = encWbi({
      timezone_offset: -480,
      platform: 'web',
      gaia_source: 'main_web',
      id: String(dynamicId),
      features,
      web_location: '333.1368',
      'x-bili-device-req-json': JSON.stringify({ platform: 'web', device: 'pc', spmid: '333.1368' })
    }, imgKey, subKey);

    const resp = await axios.get(url, {
      params: signedParams,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Accept: '*/*',
        Origin: 'https://t.bilibili.com',
        Referer: `https://t.bilibili.com/${dynamicId}`,
        Cookie: cookie,
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'accept-language': 'zh-CN,zh;q=0.9,ko;q=0.8'
      },
      timeout: 20000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400
    });
    return resp.data;
  }

  async function resolveB23ShortLink(shortUrl) {
    const cookie = await buildBiliCookie();
    const resp = await axios.get(shortUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Referer: 'https://www.bilibili.com/',
        Cookie: cookie
      },
      timeout: 20000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400
    });

    const location = resp.headers?.location || resp.request?.res?.headers?.location || '';
    if (!location) throw new Error('b23短链未返回跳转地址');

    const finalUrl = String(location).startsWith('http') ? String(location) : `https:${location}`;
    const target = detect(finalUrl);
    if (!target || !['dynamic', 'opus', 'music', 'bili_audio', 'video'].includes(target.type)) {
      throw new Error(`b23短链跳转后不是支持的链接: ${finalUrl}`);
    }
    return { ...target, shortUrl, finalUrl };
  }

  async function fetchMusicDetail(musicId) {
    const cookie = await buildBiliCookie();
    const { imgKey, subKey } = await getWbiKeys();
    const params = encWbi({ music_id: String(musicId), relation_from: 'bgm_page' }, imgKey, subKey);
    const resp = await axios.get('https://api.bilibili.com/x/copyright-music-publicity/bgm/detail', {
      params,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Referer: `https://music.bilibili.com/h5/music-detail?music_id=${musicId}`,
        Origin: 'https://music.bilibili.com',
        Cookie: cookie,
        Accept: 'application/json, text/plain, */*'
      },
      timeout: 20000
    });
    return resp.data;
  }

  async function fetchVideoDetail(bvid) {
    const cookie = await buildBiliCookie();
    const resp = await axios.get('https://api.bilibili.com/x/web-interface/view', {
      params: { bvid: String(bvid) },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Referer: `https://www.bilibili.com/video/${bvid}`,
        Cookie: cookie,
        Accept: 'application/json, text/plain, */*'
      },
      timeout: 20000
    });
    return resp.data;
  }

  async function fetchVideoDetailWbi(bvid) {
    const cookie = await buildBiliCookie();
    const { imgKey, subKey } = await getWbiKeys();
    const params = encWbi({ bvid: String(bvid) }, imgKey, subKey);
    const resp = await axios.get('https://api.bilibili.com/x/web-interface/wbi/view/detail', {
      params,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Referer: `https://www.bilibili.com/video/${bvid}`,
        Origin: 'https://www.bilibili.com',
        Cookie: cookie,
        Accept: 'application/json, text/plain, */*'
      },
      timeout: 20000
    });
    return resp.data;
  }

  async function fetchVideoPlayUrl(bvid, cid) {
    const cookie = await buildBiliCookie();
    const { imgKey, subKey } = await getWbiKeys();
    const params = encWbi({
      bvid: String(bvid),
      cid: Number(cid),
      qn: 112,
      fnval: 4048,
      fnver: 0,
      fourk: 1,
      otype: 'json'
    }, imgKey, subKey);

    const resp = await axios.get('https://api.bilibili.com/x/player/wbi/playurl', {
      params,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Referer: `https://www.bilibili.com/video/${bvid}`,
        Origin: 'https://www.bilibili.com',
        Cookie: cookie,
        Accept: 'application/json, text/plain, */*'
      },
      timeout: 20000
    });
    return resp.data;
  }

  async function fetchVideoMp4PlayUrl(bvid, cid) {
    const cookie = await buildBiliCookie();
    const { imgKey, subKey } = await getWbiKeys();
    const params = encWbi({
      bvid: String(bvid),
      cid: Number(cid),
      qn: 80,
      fnval: 1,
      fnver: 0,
      fourk: 0,
      otype: 'json',
      platform: 'html5',
      high_quality: 1,
      try_look: 1
    }, imgKey, subKey);

    const resp = await axios.get('https://api.bilibili.com/x/player/wbi/playurl', {
      params,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Referer: `https://www.bilibili.com/video/${bvid}`,
        Origin: 'https://www.bilibili.com',
        Cookie: cookie,
        Accept: 'application/json, text/plain, */*'
      },
      timeout: 20000
    });
    return resp.data;
  }

  async function fetchAudioStreamUrlWeb(sid) {
    const url = 'https://www.bilibili.com/audio/music-service-c/web/url';
    const resp = await axios.get(url, {
      params: { sid: Number(sid), quality: 2, privilege: 2 },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Referer: 'https://www.bilibili.com/'
      },
      timeout: 20000
    });
    return resp.data;
  }

  function buildAudioReplyText(sid, stream) {
    const data = stream?.data || {};
    const cdns = Array.isArray(data?.cdns) ? data.cdns.filter(Boolean) : [];
    const audioUrl = cdns[0] || '';
    return [
      `B站音频解析 (au): ${sid}`,
      stream?.code === 0 ? null : `状态: code=${stream?.code} msg=${stream?.msg || stream?.message || ''}`,
      typeof data?.type === 'number' ? `音质标识: ${data.type}` : null,
      typeof data?.timeout === 'number' ? `有效期(秒): ${data.timeout}` : null,
      typeof data?.size === 'number' ? `大小: ${data.size}` : null,
      audioUrl ? `音频: ${audioUrl}` : '音频: (未获取到流URL)',
      `链接: https://www.bilibili.com/audio/au${sid}`
    ].filter(Boolean).join('\n');
  }

  function extractPlainTextFromMusicDetail(data) {
    const info = data?.music_detail || data || {};
    const upper = data?.upper || {};
    const passthrough = data?.passthrough || {};
    const musicComment = data?.music_comment || {};
    const stat = info?.stat || data?.stat || {};
    const title = info?.title || info?.music_title || '';
    const artistList = Array.isArray(data?.artists_list) ? data.artists_list.map((item) => item?.name).filter(Boolean) : [];
    const artistIdentityList = Array.isArray(data?.artists_list)
      ? data.artists_list.map((item) => {
          const name = item?.name || '';
          const identity = item?.identity || '';
          return name ? `${name}${identity ? `（${identity}）` : ''}` : '';
        }).filter(Boolean)
      : [];
    const authorName = upper?.name || info?.author || info?.singer || data?.origin_artist || artistList.join('、') || '';
    const album = info?.album || data?.album || '';
    const summary = info?.intro || info?.summary || info?.sub_title || info?.lyric || data?.music_source || '';
    const durationText = secondsToDurationText(info?.duration || info?.play_time || info?.duration_second);
    const playCountRaw = info?.play_num ?? stat?.play ?? stat?.play_num ?? data?.listen_pv;
    const commentCountRaw = musicComment?.nums ?? stat?.reply ?? stat?.comment;
    const collectCountRaw = info?.collect_num ?? stat?.collect ?? stat?.fav ?? data?.mv_fav;
    const shareCountRaw = info?.share_num ?? stat?.share ?? data?.music_shares ?? data?.mv_shares;
    const wishCountRaw = info?.wish_num ?? data?.wish_num ?? data?.wish_count;
    const coinCountRaw = info?.coin_num ?? stat?.coin;
    const likeCountRaw = data?.mv_likes ?? stat?.like;
    const relationCountRaw = data?.music_relation;
    const hotValueRaw = data?.music_hot ?? data?.hot_song_heat?.last_heat;
    const supportListen = typeof data?.support_listen === 'boolean' ? data.support_listen : null;
    const wishListen = typeof data?.wish_listen === 'boolean' ? data.wish_listen : null;
    const pubTime = data?.music_publish || info?.pub_time || info?.ctime || data?.ctime || '';
    const cover = info?.cover || info?.cover_url || data?.cover || data?.mv_cover || '';
    const lyric = info?.lyric || data?.mv_lyric || '';
    const aid = passthrough?.aid || info?.aid || data?.aid || data?.mv_aid || null;
    const cid = passthrough?.cid || info?.cid || data?.cid || data?.mv_cid || null;
    const bvid = info?.bvid || passthrough?.bvid || data?.bvid || data?.mv_bvid || '';
    const cname = passthrough?.cname || info?.cname || '';
    const category = info?.category || data?.category || '';
    const source = info?.source || data?.source || data?.music_source || '';
    const rank = data?.music_rank || data?.recreation_rank || '';
    const achievement = Array.isArray(data?.achievement) ? data.achievement.filter(Boolean) : [];
    const hottestRank = data?.hot_song_rank?.highest_rank;
    const onListTimes = data?.hot_song_rank?.on_list_times;
    const lastHeat = data?.hot_song_heat?.last_heat;
    const maxListId = data?.max_list_id;
    const mvIndexOrder = data?.mv_index_order;
    const bgColor = data?.bg_color || '';
    const tags = Array.isArray(info?.tag)
      ? info.tag.filter(Boolean)
      : Array.isArray(info?.tags)
        ? info.tags.filter(Boolean)
        : Array.isArray(data?.tag)
          ? data.tag.filter(Boolean)
          : [];

    const normalizeNumber = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    return {
      title,
      authorName,
      artistList,
      artistIdentityList,
      album,
      summary,
      durationText,
      playCount: normalizeNumber(playCountRaw),
      commentCount: normalizeNumber(commentCountRaw),
      collectCount: normalizeNumber(collectCountRaw),
      shareCount: normalizeNumber(shareCountRaw),
      wishCount: normalizeNumber(wishCountRaw),
      coinCount: normalizeNumber(coinCountRaw),
      likeCount: normalizeNumber(likeCountRaw),
      relationCount: normalizeNumber(relationCountRaw),
      hotValue: normalizeNumber(hotValueRaw),
      lastHeat: normalizeNumber(lastHeat),
      hottestRank: normalizeNumber(hottestRank),
      onListTimes: normalizeNumber(onListTimes),
      maxListId: normalizeNumber(maxListId),
      mvIndexOrder: normalizeNumber(mvIndexOrder),
      supportListen,
      wishListen,
      rank,
      achievement,
      pubTime: pubTime ? String(pubTime) : '',
      cover: cover ? String(cover) : '',
      lyric: lyric ? String(lyric) : '',
      aid: aid ? String(aid) : '',
      cid: cid ? String(cid) : '',
      bvid,
      cname,
      category,
      source,
      bgColor,
      tags
    };
  }

  function extractPlainTextFromVideoDetail(data, detailData, playData) {
    const view = data?.data || {};
    const stat = view?.stat || {};
    const detail = detailData?.data || {};
    const card = detail?.Card?.card || {};
    const tags = Array.isArray(detail?.Tags) ? detail.Tags.map((tag) => tag?.tag_name).filter(Boolean) : [];
    const honorTexts = Array.isArray(view?.honor_reply?.honor) ? view.honor_reply.honor.map((item) => item?.desc).filter(Boolean) : [];
    const pages = Array.isArray(view?.pages) ? view.pages.map((page) => ({
      cid: page?.cid ? String(page.cid) : '',
      page: Number(page?.page || 0),
      part: page?.part || '',
      durationText: secondsToDurationText(page?.duration),
      dimensionText: page?.dimension?.width && page?.dimension?.height ? `${page.dimension.width}x${page.dimension.height}` : ''
    })) : [];
    const subtitles = Array.isArray(view?.subtitle?.list) ? view.subtitle.list.map((item) => item?.lan_doc || item?.lan).filter(Boolean) : [];
    const staffNames = Array.isArray(view?.staff)
      ? view.staff.map((item) => item?.name || item?.title).filter(Boolean)
      : [];

    const playSummary = extractPlayInfo(playData, playData?.mp4PlayData);

    return {
      bvid: view?.bvid || '',
      aid: view?.aid ? String(view.aid) : '',
      cid: view?.cid ? String(view.cid) : '',
      title: view?.title || '',
      desc: view?.desc || '',
      pic: normalizeUrl(view?.pic || ''),
      ownerName: view?.owner?.name || card?.name || '',
      ownerMid: view?.owner?.mid ? String(view.owner.mid) : (card?.mid ? String(card.mid) : ''),
      ownerFace: normalizeUrl(view?.owner?.face || card?.face || ''),
      durationText: secondsToDurationText(view?.duration),
      tname: view?.tname || '',
      view: Number.isFinite(Number(stat?.view)) ? Number(stat.view) : null,
      danmaku: Number.isFinite(Number(stat?.danmaku)) ? Number(stat.danmaku) : null,
      reply: Number.isFinite(Number(stat?.reply)) ? Number(stat.reply) : null,
      like: Number.isFinite(Number(stat?.like)) ? Number(stat.like) : null,
      coin: Number.isFinite(Number(stat?.coin)) ? Number(stat.coin) : null,
      favorite: Number.isFinite(Number(stat?.favorite)) ? Number(stat.favorite) : null,
      share: Number.isFinite(Number(stat?.share)) ? Number(stat.share) : null,
      hisRank: Number.isFinite(Number(stat?.his_rank)) ? Number(stat.his_rank) : null,
      pubdateText: formatDateTime(view?.pubdate),
      ctimeText: formatDateTime(view?.ctime),
      dynamic: view?.dynamic || '',
      dimensionText: view?.dimension?.width && view?.dimension?.height ? `${view.dimension.width}x${view.dimension.height}` : '',
      subtitleLanguages: subtitles,
      pages,
      tags,
      honorTexts,
      staffNames,
      copyrightText: Number(view?.copyright) === 1 ? '原创' : Number(view?.copyright) === 2 ? '转载' : '',
      playInfo: playSummary
    };
  }

  function extractPlayInfo(playData, mp4PlayData) {
    const data = playData?.data || {};
    const mp4Data = mp4PlayData?.data || {};
    const dash = data?.dash || {};
    const supportFormats = Array.isArray(data?.support_formats) ? data.support_formats : [];
    const formatMap = new Map();
    for (const item of supportFormats) {
      if (item?.quality !== undefined) formatMap.set(Number(item.quality), item);
    }

    const videoStreams = Array.isArray(dash?.video)
      ? dash.video.map((item) => {
          const qualityMeta = formatMap.get(Number(item?.id)) || {};
          return {
            id: Number(item?.id || 0),
            qualityText: qualityMeta.new_description || qualityMeta.display_desc || String(item?.id || '-'),
            codec: item?.codecs || '',
            codecLabel: codecLabel(item?.codecid),
            width: Number(item?.width || 0),
            height: Number(item?.height || 0),
            frameRate: item?.frameRate || item?.frame_rate || '-',
            bandwidth: Number(item?.bandwidth || 0),
            mimeType: item?.mimeType || item?.mime_type || '',
            url: normalizeUrl(item?.baseUrl || item?.base_url || ''),
            backupUrls: Array.isArray(item?.backupUrl || item?.backup_url) ? (item?.backupUrl || item?.backup_url).map(normalizeUrl).filter(Boolean) : []
          };
        }).filter((item) => item.url)
      : [];

    const audioStreams = Array.isArray(dash?.audio)
      ? dash.audio.map((item) => ({
          id: Number(item?.id || 0),
          qualityText: audioQualityLabel(item?.id),
          codec: item?.codecs || '',
          bandwidth: Number(item?.bandwidth || 0),
          mimeType: item?.mimeType || item?.mime_type || '',
          url: normalizeUrl(item?.baseUrl || item?.base_url || ''),
          backupUrls: Array.isArray(item?.backupUrl || item?.backup_url) ? (item?.backupUrl || item?.backup_url).map(normalizeUrl).filter(Boolean) : []
        })).filter((item) => item.url)
      : [];

    videoStreams.sort((a, b) => b.id - a.id || b.bandwidth - a.bandwidth);
    audioStreams.sort((a, b) => b.id - a.id || b.bandwidth - a.bandwidth);

    const durlList = Array.isArray(data?.durl) ? data.durl : [];
    const mp4DurlList = Array.isArray(mp4Data?.durl) ? mp4Data.durl : [];
    const dashMp4Url = durlList[0]?.url ? normalizeUrl(durlList[0].url) : '';
    const directMp4Url = mp4DurlList[0]?.url ? normalizeUrl(mp4DurlList[0].url) : '';
    const mp4Url = directMp4Url || dashMp4Url;

    return {
      quality: Number(data?.quality || 0),
      format: data?.format || '',
      timelength: Number(data?.timelength || 0),
      acceptDescription: Array.isArray(data?.accept_description) ? data.accept_description.filter(Boolean) : [],
      acceptQuality: Array.isArray(data?.accept_quality) ? data.accept_quality.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : [],
      mp4Quality: Number(mp4Data?.quality || 0),
      mp4Format: mp4Data?.format || '',
      mp4AcceptDescription: Array.isArray(mp4Data?.accept_description) ? mp4Data.accept_description.filter(Boolean) : [],
      videoStreams,
      audioStreams,
      mp4Url,
      bestVideoUrl: videoStreams[0]?.url || '',
      bestAudioUrl: audioStreams[0]?.url || ''
    };
  }

  function extractPlainTextFromOpusItem(item) {
    const modules = item?.modules || [];
    const titleModule = pickModule(modules, 'MODULE_TYPE_TITLE');
    const authorModule = pickModule(modules, 'MODULE_TYPE_AUTHOR');
    const contentModule = pickModule(modules, 'MODULE_TYPE_CONTENT');
    const title = titleModule?.module_title?.text || item?.basic?.title || item?.basic?.rid_str || item?.id_str || '';
    const authorName = authorModule?.module_author?.name || '';
    let contentText = '';
    const paragraphs = contentModule?.module_content?.paragraphs || [];
    for (const p of paragraphs) {
      const nodes = p?.text?.nodes;
      if (!Array.isArray(nodes)) continue;
      for (const n of nodes) {
        if (n?.type === 'TEXT_NODE_TYPE_WORD') {
          contentText += n?.word?.words || '';
        } else if (n?.type === 'TEXT_NODE_TYPE_RICH') {
          contentText += n?.rich?.orig_text || n?.rich?.text || '';
        }
      }
      contentText += '\n';
    }
    contentText = contentText.replace(/\n{3,}/g, '\n\n').trim();
    return { title, authorName, contentText };
  }

  function extractPlainTextFromDynamicItem(item) {
    const modules = item?.modules || {};
    const authorModule = modules?.module_author || {};
    const dynamicModule = modules?.module_dynamic || {};
    const title = item?.id_str || '';
    const authorName = authorModule?.name || '';
    let contentText = dynamicModule?.desc?.text || '';

    if (item?.type === 'DYNAMIC_TYPE_FORWARD' && item?.orig) {
      const orig = item.orig;
      const origBasic = orig?.basic || {};
      const origModules = orig?.modules || {};
      const origAuthor = origModules?.module_author || {};
      const origDynamic = origModules?.module_dynamic || {};
      const origMajor = origDynamic?.major || {};
      const origParts = [];
      if (origAuthor?.name) origParts.push(`原动态作者: ${origAuthor.name}`);
      if (origAuthor?.pub_action) origParts.push(`原动态动作: ${origAuthor.pub_action}`);
      if (origDynamic?.desc?.text) origParts.push(`原动态正文: ${origDynamic.desc.text}`);

      if (origMajor?.type === 'MAJOR_TYPE_ARCHIVE' && origMajor?.archive) {
        const archive = origMajor.archive;
        if (archive?.title) origParts.push(`原视频标题: ${archive.title}`);
        if (archive?.desc) origParts.push(`原视频简介: ${archive.desc}`);
        if (archive?.bvid) origParts.push(`原视频BV: ${archive.bvid}`);
        if (archive?.jump_url) {
          const jumpUrl = String(archive.jump_url).startsWith('//') ? `https:${archive.jump_url}` : archive.jump_url;
          origParts.push(`原视频链接: ${jumpUrl}`);
        }
        if (archive?.stat?.play || archive?.stat?.danmaku) {
          origParts.push(`原视频数据: 播放${archive?.stat?.play || '0'} / 弹幕${archive?.stat?.danmaku || '0'}`);
        }
      }

      if (origMajor?.type === 'MAJOR_TYPE_OPUS' && origMajor?.opus) {
        const opus = origMajor.opus;
        if (opus?.title) origParts.push(`原图文标题: ${opus.title}`);
        if (opus?.summary?.text) origParts.push(`原图文摘要: ${opus.summary.text}`);
        if (opus?.jump_url) {
          const jumpUrl = String(opus.jump_url).startsWith('//') ? `https:${opus.jump_url}` : opus.jump_url;
          origParts.push(`原图文链接: ${jumpUrl}`);
        } else if (origBasic?.jump_url) {
          const jumpUrl = String(origBasic.jump_url).startsWith('//') ? `https:${origBasic.jump_url}` : origBasic.jump_url;
          origParts.push(`原图文链接: ${jumpUrl}`);
        }
        if (Array.isArray(opus?.pics) && opus.pics.length > 0) {
          origParts.push(`原图文图片数: ${opus.pics.length}`);
        }
      }

      if (origParts.length > 0) {
        contentText = [contentText, ...origParts].filter(Boolean).join('\n');
      }
    }

    return { title, authorName, contentText };
  }

  async function process(target) {
    let resolvedTarget = target;
    if (target.type === 'b23') {
      resolvedTarget = await resolveB23ShortLink(target.url);
    }

    if (resolvedTarget.type === 'search') {
      const data = await fetchBiliSearchType(resolvedTarget);
      if (data?.code !== 0) throw new Error(`B站搜索失败: ${data?.code} ${data?.message || ''}`);
      const replyText = buildSearchReplyText(resolvedTarget, data);
      return { target: resolvedTarget, replyText, data };
    }

    if (resolvedTarget.type === 'bili_audio') {
      const stream = await fetchAudioStreamUrlWeb(resolvedTarget.id);
      let replyText = buildAudioReplyText(resolvedTarget.id, stream);
      const link = resolvedTarget.finalUrl || `https://www.bilibili.com/audio/au${resolvedTarget.id}`;
      replyText = replyText.replace(`链接: https://www.bilibili.com/audio/au${resolvedTarget.id}`, `链接: ${link}`);
      return { target: resolvedTarget, replyText, stream, link };
    }

    if (resolvedTarget.type === 'video') {
      const data = await fetchVideoDetail(resolvedTarget.id);
      if (data?.code !== 0) throw new Error(`获取视频失败: ${data?.code} ${data?.message || ''}`);

      let detailData = null;
      try {
        detailData = await fetchVideoDetailWbi(resolvedTarget.id);
      } catch (e) {
        console.log('[bilibili] fetchVideoDetailWbi failed:', e?.message || e);
      }

      let playData = null;
      try {
        const cid = data?.data?.cid;
        if (cid) {
          playData = await fetchVideoPlayUrl(resolvedTarget.id, cid);
          try {
            const mp4PlayData = await fetchVideoMp4PlayUrl(resolvedTarget.id, cid);
            if (playData && mp4PlayData) {
              playData.mp4PlayData = mp4PlayData;
            }
          } catch (e2) {
            console.log('[bilibili] fetchVideoMp4PlayUrl failed:', e2?.message || e2);
          }
        }
      } catch (e) {
        console.log('[bilibili] fetchVideoPlayUrl failed:', e?.message || e);
      }

      const parsed = extractPlainTextFromVideoDetail(data, detailData, playData);
      const link = resolvedTarget.finalUrl || `https://www.bilibili.com/video/${resolvedTarget.id}`;
      const replyText = buildVideoReplyText(resolvedTarget.id, parsed, parsed.playInfo).replace(`链接: https://www.bilibili.com/video/${resolvedTarget.id}`, `链接: ${link}`);
      return { target: resolvedTarget, replyText, parsed, detailData, playData, link };
    }

    if (resolvedTarget.type === 'dynamic') {
      const data = await fetchDynamicDetail(resolvedTarget.id);
      if (data?.code !== 0) throw new Error(`获取动态失败: ${data?.code} ${data?.message || ''}`);
      const item = data?.data?.item;
      const parsed = extractPlainTextFromDynamicItem(item);
      const link = resolvedTarget.finalUrl || `https://t.bilibili.com/${resolvedTarget.id}`;
      const replyText = [
        `B站动态解析 (dynamic): ${resolvedTarget.id}`,
        parsed.authorName ? `作者: ${parsed.authorName}` : null,
        parsed.contentText ? `\n引用内容摘要:\n${parsed.contentText.slice(0, 1200)}${parsed.contentText.length > 1200 ? '...' : ''}` : null,
        `链接: ${link}`
      ].filter(Boolean).join('\n');
      return { target: resolvedTarget, replyText, parsed, link };
    }

    if (resolvedTarget.type === 'music') {
      const data = await fetchMusicDetail(resolvedTarget.id);
      if (data?.code !== 0) throw new Error(`获取音乐失败: ${data?.code} ${data?.message || ''}`);
      const parsed = extractPlainTextFromMusicDetail(data?.data);
      const link = resolvedTarget.finalUrl || `https://music.bilibili.com/h5/music-detail?music_id=${resolvedTarget.id}`;
      const replyText = buildMusicReplyText(resolvedTarget.id, parsed).replace(`链接: https://music.bilibili.com/h5/music-detail?music_id=${resolvedTarget.id}`, `链接: ${link}`);
      return { target: resolvedTarget, replyText, parsed, link };
    }

    const data = await fetchOpusDetail(resolvedTarget.id);
    if (data?.code !== 0) throw new Error(`获取动态失败: ${data?.code} ${data?.message || ''}`);
    const item = data?.data?.item;
    const parsed = extractPlainTextFromOpusItem(item);
    const link = resolvedTarget.finalUrl || `https://www.bilibili.com/opus/${resolvedTarget.id}`;
    const replyText = buildOpusReplyText(resolvedTarget.id, parsed).replace(`链接: https://www.bilibili.com/opus/${resolvedTarget.id}`, `链接: ${link}`);
    return { target: resolvedTarget, replyText, parsed, link };
  }

  return {
    name: 'bilibili',
    detect,
    process,
    helpers: {
      resolveB23ShortLink,
      parseSearchCommand,
      fetchBiliSearchType,
      buildSearchReplyText,
      fetchOpusDetail,
      fetchDynamicDetail,
      fetchMusicDetail,
      fetchVideoDetail,
      fetchVideoDetailWbi,
      fetchVideoPlayUrl,
      fetchVideoMp4PlayUrl,
      fetchAudioStreamUrlWeb,
      buildAudioReplyText,
      buildOpusReplyText,
      buildMusicReplyText,
      buildVideoReplyText,
      extractPlayInfo
    }
  };
}

module.exports = { buildBilibiliPlugin };
