function buildKuaishouPlugin(ctx) {
  const {
    axios,
    randomChoice,
    safeJsonParse,
    formatNum,
    fetchHtmlWithRedirect,
    ksDecodeInitState
  } = ctx;

  function detect(text) {
    if (!text) return null;
    const s = String(text);
    const m = s.match(/https?:\/\/(v\.kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+|(?:www\.)?kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+|(?:v\.m\.)?chenzhongtech\.com\/fw\/[A-Za-z\d._?%&+\-=/#]+)/i)
      || s.match(/\b(v\.kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+|(?:www\.)?kuaishou\.com\/[A-Za-z\d._?%&+\-=/#]+|(?:v\.m\.)?chenzhongtech\.com\/fw\/[A-Za-z\d._?%&+\-=/#]+)\b/i);
    if (!m) return null;
    const url = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;
    return { platform: 'kuaishou', url };
  }

  function buildReplyText(summary) {
    const author = summary?.author || {};
    const stats = summary?.stats || {};
    const imgs = Array.isArray(summary?.imageUrls) ? summary.imageUrls : [];
    const lines = [
      '快手解析 (kuaishou):',
      summary?.caption ? `标题: ${summary.caption}` : null,
      author?.name ? `作者: ${author.name}` : null,
      author?.avatarUrl ? `头像: ${author.avatarUrl}` : null,
      stats?.view ? `浏览: ${stats.view}` : null,
      stats?.like ? `点赞: ${stats.like}` : null,
      stats?.comment ? `评论: ${stats.comment}` : null,
      stats?.share ? `分享: ${stats.share}` : null,
      summary?.videoUrl ? `视频: ${summary.videoUrl}` : null,
      summary?.coverUrl ? `封面: ${summary.coverUrl}` : null,
      summary?.finalUrl ? `链接: ${summary.finalUrl}` : null
    ].filter(Boolean);

    if (imgs.length) {
      lines.push(`图片数: ${imgs.length}`);
      lines.push('图片:');
      for (const u of imgs) lines.push(u);
    }

    return lines.join('\n');
  }

  async function process(target) {
    const inputUrl = target.url;
    const shortLinkHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      Referer: 'https://www.kuaishou.com/'
    };

    const r1 = await fetchHtmlWithRedirect(inputUrl, {
      headers: shortLinkHeaders,
      timeout: 20000
    });
    let realUrl = r1.finalUrl || inputUrl;

    if (realUrl === inputUrl) {
      try {
        const r1b = await axios.get(inputUrl, {
          headers: shortLinkHeaders,
          timeout: 20000
        });
        const html1 = typeof r1b?.data === 'string' ? r1b.data : '';
        const m1 = html1.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i)
          || html1.match(/http-equiv=['"]refresh['"][^>]*url=([^"'>\s]+)/i);
        if (m1 && m1[1]) {
          const u = String(m1[1]);
          realUrl = u.startsWith('http') ? u : `https:${u}`;
        }
      } catch {}
    }

    realUrl = realUrl.replace('/fw/long-video/', '/fw/photo/');

    const pageHeaders = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://www.kuaishou.com/'
    };

    const r2 = await axios.get(realUrl, {
      headers: pageHeaders,
      timeout: 20000
    });
    let html = typeof r2?.data === 'string' ? r2.data : '';

    if (!/window\.INIT_STATE|__NEXT_DATA__|__INITIAL_STATE__|__NUXT__/i.test(html)) {
      try {
        const r2b = await axios.get(realUrl, {
          headers: pageHeaders,
          timeout: 20000
        });
        const html2 = typeof r2b?.data === 'string' ? r2b.data : '';
        if (html2) html = html2;
      } catch {}
    }

    let initJsonText = '';
    const initAnchorCandidates = [
      'window.INIT_STATE = ',
      'window.INIT_STATE=',
      'self.INIT_STATE = ',
      'self.INIT_STATE='
    ];
    for (const initAnchor of initAnchorCandidates) {
      const initStart = html.indexOf(initAnchor);
      if (initStart >= 0) {
        const afterAnchor = html.slice(initStart + initAnchor.length);
        const scriptEnd = afterAnchor.indexOf('</script>');
        if (scriptEnd >= 0) {
          initJsonText = afterAnchor.slice(0, scriptEnd).trim();
          initJsonText = initJsonText.replace(/;\s*$/, '').trim();
          break;
        }
      }
    }
    if (!initJsonText) {
      const initMatch = html.match(/(?:window|self)\.INIT_STATE\s*=\s*(\{[\s\S]*\})\s*;?\s*<\/script>/i);
      if (initMatch && initMatch[1]) {
        initJsonText = initMatch[1];
      }
    }
    if (!initJsonText) {
      const nextMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
      if (nextMatch && nextMatch[1]) {
        const nextData = safeJsonParse(nextMatch[1]);
        initJsonText =
          (typeof nextData?.props?.pageProps?.INIT_STATE === 'string' && nextData.props.pageProps.INIT_STATE) ||
          (typeof nextData?.props?.pageProps?.initState === 'string' && nextData.props.pageProps.initState) ||
          (nextData?.props?.pageProps?.INIT_STATE && JSON.stringify(nextData.props.pageProps.INIT_STATE)) ||
          (typeof nextData?.props?.initialState === 'string' && nextData.props.initialState) ||
          (nextData?.props?.initialState && JSON.stringify(nextData.props.initialState)) ||
          '';
      }
    }
    if (!initJsonText) {
      const universalStateMatch = html.match(/<script[^>]*>\s*self\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i)
        || html.match(/<script[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i)
        || html.match(/<script[^>]*>\s*self\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i)
        || html.match(/<script[^>]*>\s*window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i);
      if (universalStateMatch && universalStateMatch[1]) {
        initJsonText = universalStateMatch[1];
      }
    }

    if (!initJsonText) {
      throw new Error("can't find window.INIT_STATE in html");
    }

    const initObj = safeJsonParse(initJsonText);
    if (!initObj) {
      throw new Error('failed to JSON.parse init state');
    }

    const decoded = ksDecodeInitState(initObj);
    const info = decoded['/rest/wd/ugH5App/photo/simple/info'];
    const author = decoded['/rest/wd/user/profile/author'];
    const photo = info?.photo;
    if (!photo) {
      throw new Error("window.init_state don't contains videos or pics");
    }

    const coverUrl = Array.isArray(photo?.coverUrls) && photo.coverUrls.length ? randomChoice(photo.coverUrls)?.url : '';
    const videoUrl = Array.isArray(photo?.mainMvUrls) && photo.mainMvUrls.length ? randomChoice(photo.mainMvUrls)?.url : '';
    const atlas = photo?.ext_params?.atlas || {};
    const cdn = Array.isArray(atlas?.cdnList) && atlas.cdnList.length ? randomChoice(atlas.cdnList)?.cdn : '';
    const routes = Array.isArray(atlas?.list) ? atlas.list : [];
    const imageUrls = cdn && routes.length ? routes.map((u) => `https://${cdn}/${u}`) : [];

    const summary = {
      platform: 'kuaishou',
      inputUrl,
      finalUrl: realUrl,
      caption: photo?.caption || '',
      timestamp: Number(photo?.timestamp || 0),
      duration: Number(photo?.duration || 0),
      author: {
        name: (author?.userProfile?.profile?.user_name || photo?.userName || '未知用户').replace(/\u3164/g, '').trim(),
        avatarUrl: author?.userProfile?.profile?.headurl || photo?.headUrl || ''
      },
      stats: {
        view: formatNum(photo?.viewCount),
        like: formatNum(photo?.likeCount),
        comment: formatNum(photo?.commentCount),
        share: formatNum(photo?.shareCount)
      },
      videoUrl,
      coverUrl,
      imageUrls
    };

    return {
      target,
      summary,
      replyText: buildReplyText(summary)
    };
  }

  return {
    name: 'kuaishou',
    detect,
    process,
    helpers: {
      buildReplyText
    }
  };
}

module.exports = { buildKuaishouPlugin };
