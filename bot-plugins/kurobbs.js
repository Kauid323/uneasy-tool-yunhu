function buildKurobbsPlugin(ctx) {
  const {
    axios,
    formatNum,
    crypto,
    safeJsonParse
  } = ctx;

  function percentEncodeAliyun(value) {
    return encodeURIComponent(String(value))
      .replace(/\+/g, '%20')
      .replace(/\*/g, '%2A')
      .replace(/%7E/g, '~');
  }

  function buildAliyunCanonicalQuery(params) {
    return Object.keys(params)
      .sort()
      .map((key) => `${percentEncodeAliyun(key)}=${percentEncodeAliyun(params[key])}`)
      .join('&');
  }

  function aliyunSignQuery(params, accessKeySecret) {
    const canonical = buildAliyunCanonicalQuery(params);
    const stringToSign = `GET&${percentEncodeAliyun('/')}&${percentEncodeAliyun(canonical)}`;
    const signature = crypto.createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
    return { canonical, stringToSign, signature };
  }

  async function refreshKurobbsPlayCode(videoId) {
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      Connection: 'keep-alive',
      Accept: 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      devCode: 'qQEqfNyouMULztWVJcTjXxmZZ6kp85yv',
      source: 'h5',
      version: '2.10.5',
      Origin: 'https://www.kurobbs.com',
      Referer: 'https://www.kurobbs.com/'
    };
    const formBody = new URLSearchParams({ videoId: String(videoId) }).toString();

    console.log('[kurobbs][video] refreshPlayCode request videoId =', videoId);
    console.log('[kurobbs][video] refreshPlayCode request headers:');
    console.log(JSON.stringify(reqHeaders, null, 2));
    console.log('[kurobbs][video] refreshPlayCode request body:');
    console.log(formBody);

    try {
      const resp = await axios.post('https://api.kurobbs.com/forum/video/refreshPlayCode', formBody, {
        headers: reqHeaders,
        timeout: 20000
      });

      const res = resp?.data;
      console.log('[kurobbs][video] refreshPlayCode raw response:');
      console.log(JSON.stringify(res, null, 2));

      if (res?.code !== 200 || !res?.data?.playAuth) {
        throw new Error(res?.msg || 'refreshPlayCode failed');
      }
      return res.data;
    } catch (e) {
      console.log('[kurobbs][video] refreshPlayCode failed');
      console.log('[kurobbs][video] refreshPlayCode error message:', e?.message || e);
      if (e?.response) {
        console.log('[kurobbs][video] refreshPlayCode status:', e.response.status);
        console.log('[kurobbs][video] refreshPlayCode response headers:');
        console.log(JSON.stringify(e.response.headers || {}, null, 2));
        console.log('[kurobbs][video] refreshPlayCode response body raw:');
        console.log(e.response.data);
        console.log('[kurobbs][video] refreshPlayCode response body json:');
        console.log(JSON.stringify(e.response.data || {}, null, 2));
      }
      throw e;
    }
  }

  async function resolveKurobbsVideoPlayInfo(videoId) {
    const playCode = await refreshKurobbsPlayCode(videoId);
    const decodedText = Buffer.from(String(playCode.playAuth), 'base64').toString('utf8');
    const decoded = safeJsonParse(decodedText);
    if (!decoded) {
      throw new Error('playAuth base64 decode failed');
    }

    console.log('[kurobbs][video] refreshPlayCode response:');
    console.log(JSON.stringify(playCode, null, 2));
    console.log('[kurobbs][video] playAuth decoded:');
    console.log(decodedText);

    const authInfo = typeof decoded.AuthInfo === 'string' ? decoded.AuthInfo : JSON.stringify(decoded.AuthInfo || {});
    const nonce = crypto.randomUUID();
    const params = {
      AccessKeyId: decoded.AccessKeyId,
      Action: 'GetPlayInfo',
      AuthInfo: authInfo,
      AuthTimeout: 7200,
      Channel: 'HTML5',
      Definition: 'FD,LD,SD,HD',
      Format: 'JSON',
      Formats: '',
      PlayConfig: '{}',
      PlayerVersion: '2.29.2',
      Rand: crypto.randomUUID(),
      ReAuthInfo: '{}',
      SecurityToken: decoded.SecurityToken,
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: nonce,
      SignatureVersion: '1.0',
      StreamType: 'video',
      Version: '2017-03-21',
      VideoId: decoded.VideoMeta?.VideoId || decoded.videoId || String(videoId)
    };

    const signed = aliyunSignQuery(params, decoded.AccessKeySecret);
    const requestParams = {
      ...params,
      Signature: signed.signature
    };
    const fullUrl = `https://vod.${decoded.Region}.aliyuncs.com?${buildAliyunCanonicalQuery(requestParams)}`;

    console.log('[kurobbs][video] aliyun request params:');
    console.log(JSON.stringify(requestParams, null, 2));
    console.log('[kurobbs][video] aliyun canonical query:');
    console.log(signed.canonical);
    console.log('[kurobbs][video] aliyun stringToSign:');
    console.log(signed.stringToSign);
    console.log('[kurobbs][video] aliyun signature:');
    console.log(signed.signature);
    console.log('[kurobbs][video] aliyun full url:');
    console.log(fullUrl);

    try {
      const resp = await axios.get(`https://vod.${decoded.Region}.aliyuncs.com`, {
        params: requestParams,
        headers: {
          Accept: '*/*',
          Origin: 'https://www.kurobbs.com',
          Referer: 'https://www.kurobbs.com/',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site',
          'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
        },
        timeout: 20000
      });

      const data = resp?.data;
      console.log('[kurobbs][video] aliyun response:');
      console.log(JSON.stringify(data, null, 2));

      const playInfos = Array.isArray(data?.PlayInfoList?.PlayInfo) ? data.PlayInfoList.PlayInfo : [];
      return {
        refreshData: playCode,
        playAuthDecoded: decoded,
        requestMeta: {
          ...signed,
          params: requestParams,
          fullUrl
        },
        response: data,
        playInfos
      };
    } catch (e) {
      console.log('[kurobbs][video] aliyun request failed');
      console.log('[kurobbs][video] error name:', e?.name || '');
      console.log('[kurobbs][video] error code:', e?.code || '');
      console.log('[kurobbs][video] error message:', e?.message || e);
      console.log('[kurobbs][video] request url when failed:');
      console.log(fullUrl);
      if (e?.response) {
        console.log('[kurobbs][video] error status:', e.response.status);
        console.log('[kurobbs][video] error headers:');
        console.log(JSON.stringify(e.response.headers || {}, null, 2));
        console.log('[kurobbs][video] error body raw:');
        console.log(e.response.data);
        console.log('[kurobbs][video] error body json:');
        console.log(JSON.stringify(e.response.data || {}, null, 2));
      } else {
        console.log('[kurobbs][video] no response object on error');
      }
      console.error('[kurobbs][video] detailed error object:', e);
      throw e;
    }
  }

  function detect(text) {
    if (!text) return null;
    const s = String(text);
    if (/kurobbs\.com\/postDetail\.html\?[^\s]*\bpostId=\d+/i.test(s) || /kurobbs\.com\/(?:pns|mc)\/post\/\d+/i.test(s)) {
      return { platform: 'kurobbs', text: s };
    }
    return null;
  }

  function buildReplyText(summary, { maxImages = 4, maxTextBlocks = 6 } = {}) {
    const author = summary?.author || {};
    const stats = summary?.stats || {};
    const lines = [
      '库街区解析 (kurobbs):',
      summary?.title ? `标题: ${summary.title}` : null,
      author?.name ? `作者: ${author.name}` : null,
      summary?.forumName ? `分区: ${summary.forumName}` : null,
      summary?.gameName ? `游戏: ${summary.gameName}` : null,
      summary?.postTime ? `时间: ${summary.postTime}` : null,
      stats?.view ? `浏览: ${stats.view}` : null,
      stats?.like ? `点赞: ${stats.like}` : null,
      stats?.comment ? `评论: ${stats.comment}` : null,
      stats?.collect ? `收藏: ${stats.collect}` : null
    ].filter(Boolean);

    const textBlocks = Array.isArray(summary?.textBlocks) ? summary.textBlocks.filter(Boolean) : [];
    if (textBlocks.length) {
      lines.push('正文:');
      for (const t of textBlocks.slice(0, maxTextBlocks)) lines.push(t);
      if (textBlocks.length > maxTextBlocks) lines.push(`(仅展示前${maxTextBlocks}段)`);
    }

    const imgs = Array.isArray(summary?.imageUrls) ? summary.imageUrls.filter(Boolean) : [];
    if (imgs.length) {
      lines.push(`图片数: ${imgs.length}`);
      for (const u of imgs.slice(0, maxImages)) lines.push(`图片: ${u}`);
      if (imgs.length > maxImages) lines.push(`(仅展示前${maxImages}张)`);
    }

    if (summary?.videoUrl) lines.push(`视频: ${summary.videoUrl}`);
    if (Array.isArray(summary?.videoPlayUrls) && summary.videoPlayUrls.length) {
      lines.push('视频清晰度:');
      for (const item of summary.videoPlayUrls) {
        lines.push(`${item.definition || '-'}: ${item.url}`);
      }
    }
    if (summary?.coverUrl) lines.push(`封面: ${summary.coverUrl}`);
    if (Array.isArray(summary?.topics) && summary.topics.length) lines.push(`话题: ${summary.topics.join(' / ')}`);
    if (summary?.linkCardUrl) lines.push(`链接卡片: ${summary.linkCardTitle ? `${summary.linkCardTitle} ` : ''}${summary.linkCardUrl}`.trim());
    if (summary?.url) lines.push(`链接: ${summary.url}`);

    return lines.join('\n');
  }

  async function process(target) {
    const s = String(target?.text || '');
    const m = s.match(/kurobbs\.com\/postDetail\.html\?[^\s]*\bpostId=(\d+)/i)
      || s.match(/kurobbs\.com\/(?:pns|mc)\/post\/(\d+)/i);
    if (!m) return null;

    const postId = m[1];
    const finalUrl = `https://www.kurobbs.com/postDetail.html?postId=${postId}`;
    const body = new URLSearchParams({
      postId: String(postId),
      isOnlyPublisher: '0',
      showOrderType: '2'
    }).toString();

    const resp = await axios.post('https://api.kurobbs.com/forum/getPostDetail', body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        devCode: 'qQEqfNyouMULztWVJcTjXxmZZ6kp85yv',
        source: 'h5',
        version: '2.10.5',
        Referer: 'https://www.kurobbs.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      },
      timeout: 20000
    });

    const res = resp?.data;
    if (res?.code !== 200 || !res?.data?.postDetail) {
      throw new Error(res?.msg || 'kurobbs api failed');
    }

    const detail = res.data.postDetail;
    const postContent = Array.isArray(detail?.postContent) ? detail.postContent : [];
    const textBlocks = [];
    const imageUrls = [];
    let linkCardTitle = '';
    let linkCardUrl = '';

    for (const item of postContent) {
      if (item?.contentType === 1) {
        const content = String(item?.content || '').replace(/_\[\/[^"]+\]/g, '').replace(/\s+/g, ' ').trim();
        if (content) textBlocks.push(content);
        continue;
      }
      if ((item?.contentType === 2 || item?.contentType === 4) && item?.url) {
        imageUrls.push(String(item.url));
        continue;
      }
      if (item?.contentType === 3 && item?.contentLink?.url) {
        linkCardUrl = String(item.contentLink.url);
        linkCardTitle = String(item.contentLink.title || '');
      }
    }

    const coverUrl = imageUrls[0]
      || (Array.isArray(detail?.coverImages) && detail.coverImages.length ? detail.coverImages[0]?.sourceUrl || detail.coverImages[0]?.url || '' : '');

    let videoUrl = '';
    let videoPlayUrls = [];
    if (detail?.videoId) {
      try {
        console.log('[kurobbs] resolve video play info start, videoId =', detail.videoId);
        const videoInfo = await resolveKurobbsVideoPlayInfo(detail.videoId);
        videoPlayUrls = videoInfo.playInfos
          .filter((x) => x?.Format === 'm3u8' && x?.PlayURL)
          .sort((a, b) => Number(b?.Width || 0) - Number(a?.Width || 0) || Number(b?.Bitrate || 0) - Number(a?.Bitrate || 0))
          .map((x) => ({
            definition: x?.Definition || '',
            width: Number(x?.Width || 0),
            height: Number(x?.Height || 0),
            bitrate: Number(x?.Bitrate || 0),
            url: x?.PlayURL || ''
          }));
        videoUrl = videoPlayUrls[0]?.url || '';
        console.log('[kurobbs] resolve video play info ok, definitions =', videoPlayUrls.map((x) => x.definition).join(','));
      } catch (e) {
        console.log('[kurobbs] resolve video play info failed:', e?.message || e);
        console.log('[kurobbs] resolve video play info error stack:');
        console.log(e?.stack || '');
      }
    }

    const summary = {
      platform: 'kurobbs',
      postId,
      url: finalUrl,
      title: detail?.postTitle || '',
      forumName: detail?.gameForumVo?.name || '',
      gameName: detail?.gameName || '',
      postType: Number(detail?.postType || 0),
      postTime: detail?.postTime || '',
      author: {
        name: detail?.userName || ''
      },
      stats: {
        view: formatNum(Number(detail?.browseCount || 0)),
        like: formatNum(Number(detail?.likeCount || 0)),
        comment: formatNum(Number(detail?.commentCount || 0)),
        collect: formatNum(Number(detail?.collectionCount || 0))
      },
      textBlocks,
      imageUrls,
      videoId: detail?.videoId || '',
      videoUrl,
      videoPlayUrls,
      coverUrl,
      topics: Array.isArray(detail?.topicList) ? detail.topicList.map((x) => x?.topicName).filter(Boolean) : [],
      linkCardTitle,
      linkCardUrl
    };

    return {
      target,
      summary,
      replyText: buildReplyText(summary)
    };
  }

  return {
    name: 'kurobbs',
    detect,
    process,
    helpers: {
      buildReplyText
    }
  };
}

module.exports = { buildKurobbsPlugin };
