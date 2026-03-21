// aritcle游客（未登录）只能解析一半


function buildZhihuPlugin(ctx) {
  const { axios, crypto, config, fetchHtmlWithRedirect, safeJsonParse } = ctx;

  const ZSE93 = '101_3_3.0';
  const ZK = [
    1170614578, 1024848638, 1413669199, 3951632832, 3528873006, 2921909214, 4151847688, 3997739139,
    1933479194, 3323781115, 3888513386, 460404854, 3747539722, 2403641034, 2615871395, 2119585428,
    2265697227, 2035090028, 2773447226, 4289380121, 4217216195, 2200601443, 3051914490, 1579901135,
    1321810770, 456816404, 2903323407, 4065664991, 330002838, 3506006750, 363569021, 2347096187
  ];
  const ZB = [
    20, 223, 245, 7, 248, 2, 194, 209, 87, 6, 227, 253, 240, 128, 222, 91, 237, 9, 125, 157, 230,
    93, 252, 205, 90, 79, 144, 199, 159, 197, 186, 167, 39, 37, 156, 198, 38, 42, 43, 168, 217,
    153, 15, 103, 80, 189, 71, 191, 97, 84, 247, 95, 36, 69, 14, 35, 12, 171, 28, 114, 178, 148,
    86, 182, 32, 83, 158, 109, 22, 255, 94, 238, 151, 85, 77, 124, 254, 18, 4, 26, 123, 176, 232,
    193, 131, 172, 143, 142, 150, 30, 10, 146, 162, 62, 224, 218, 196, 229, 1, 192, 213, 27, 110,
    56, 231, 180, 138, 107, 242, 187, 54, 120, 19, 44, 117, 228, 215, 203, 53, 239, 251, 127, 81,
    11, 133, 96, 204, 132, 41, 115, 73, 55, 249, 147, 102, 48, 122, 145, 106, 118, 74, 190, 29, 16,
    174, 5, 177, 129, 63, 113, 99, 31, 161, 76, 246, 34, 211, 13, 60, 68, 207, 160, 65, 111, 82,
    165, 67, 169, 225, 57, 112, 244, 155, 51, 236, 200, 233, 58, 61, 47, 100, 137, 185, 64, 17, 70,
    234, 163, 219, 108, 170, 166, 59, 149, 52, 105, 24, 212, 78, 173, 45, 0, 116, 226, 119, 136,
    206, 135, 175, 195, 25, 92, 121, 208, 126, 139, 3, 75, 141, 21, 130, 98, 241, 40, 154, 66, 184,
    49, 181, 46, 243, 88, 101, 183, 8, 23, 72, 188, 104, 179, 210, 134, 250, 201, 164, 89, 216,
    202, 220, 50, 221, 152, 140, 33, 235, 214
  ];
  const ALPHABET = '6fpLRqJO8M/c3jnYxFkUVC4ZIG12SiH=5v0mXDazWBTsuw7QetbKdoPyAl+hN9rgE';
  const KEY16 = Buffer.from('059053f7d15e01d7', 'utf8');
  const ANDROID_HEADERS = {
    'x-api-version': '3.1.8',
    'x-app-version': '10.61.0',
    'x-app-za':
      'OS=Android&Release=12&Model=sdk_gphone64_arm64&VersionName=10.61.0&VersionCode=26107&Product=com.zhihu.android&Width=1440&Height=2952&Installer=%E7%81%B0%E5%BA%A6&DeviceType=AndroidPhone&Brand=google'
  };
  const ANDROID_USER_AGENT =
    'com.zhihu.android/Futureve/10.61.0 Mozilla/5.0 (Linux; Android 12; sdk_gphone64_arm64 Build/SE1A.220630.001.A1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.1000.10 Mobile Safari/537.36';

  function getZhihuConfig() {
    return config?.zhihu || {};
  }

  function getCookieMap() {
    const zhihuCfg = getZhihuConfig();
    return {
      d_c0: String(zhihuCfg.d_c0 || ''),
      z_c0: String(zhihuCfg.z_c0 || ''),
      q_c1: String(zhihuCfg.q_c1 || '')
    };
  }

  function extractTarget(text) {
    if (!text) return null;
    const s = String(text);
    const answerMatch =
      s.match(/https?:\/\/www\.zhihu\.com\/question\/(\d+)\/answer\/(\d+)(?:[/?#][^\s]*)?/i) ||
      s.match(/https?:\/\/www\.zhihu\.com\/answer\/(\d+)(?:[/?#][^\s]*)?/i);
    if (answerMatch) {
      const questionId = answerMatch[2] ? answerMatch[1] : '';
      const answerId = answerMatch[2] || answerMatch[1];
      return {
        platform: 'zhihu',
        type: 'answer',
        questionId: questionId ? String(questionId) : '',
        answerId: String(answerId),
        url: answerMatch[0]
      };
    }

    const articleMatch = s.match(/https?:\/\/zhuanlan\.zhihu\.com\/p\/(\d+)(?:[/?#][^\s]*)?/i);
    if (articleMatch) {
      return {
        platform: 'zhihu',
        type: 'article',
        articleId: String(articleMatch[1]),
        url: articleMatch[0]
      };
    }
    return null;
  }

  function detect(text) {
    return extractTarget(text);
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
        .replace(/<\/li>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '')
    )
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function formatTime(sec) {
    const n = Number(sec || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date(n * 1000).toLocaleString('zh-CN', { hour12: false });
  }

  function encodeUriComponentBytes(input) {
    return Buffer.from(encodeURIComponent(String(input)), 'utf8');
  }

  function normalizeUrl(url) {
    const s = String(url || '').trim();
    if (!s) return '';
    return s.startsWith('//') ? `https:${s}` : s;
  }

  function collectImagesFromHtml(html) {
    const urls = [];
    const srcRegex = /(?:data-original|data-actualsrc|src)=["']([^"']+)["']/gi;
    let m;
    while ((m = srcRegex.exec(String(html || '')))) {
      const url = normalizeUrl(m[1]);
      if (/^https?:\/\//i.test(url) && /\.(?:jpg|jpeg|png|webp|gif)(?:[?#].*)?$/i.test(url)) urls.push(url);
    }
    return Array.from(new Set(urls)).slice(0, 9);
  }

  function readU32Be(buf, off) {
    return buf.readInt32BE(off);
  }

  function writeU32Be(value, out, off) {
    out.writeInt32BE(value | 0, off);
  }

  function rotateLeft(v, n) {
    return ((v << n) | (v >>> (32 - n))) | 0;
  }

  function gTransform(tt) {
    const te0 = (tt >>> 24) & 0xff;
    const te1 = (tt >>> 16) & 0xff;
    const te2 = (tt >>> 8) & 0xff;
    const te3 = tt & 0xff;
    const ti =
      ((ZB[te0] & 0xff) << 24) |
      ((ZB[te1] & 0xff) << 16) |
      ((ZB[te2] & 0xff) << 8) |
      (ZB[te3] & 0xff);
    return (ti ^ rotateLeft(ti, 2) ^ rotateLeft(ti, 10) ^ rotateLeft(ti, 18) ^ rotateLeft(ti, 24)) | 0;
  }

  function rBlock(input16) {
    const tr = new Int32Array(36);
    tr[0] = readU32Be(input16, 0);
    tr[1] = readU32Be(input16, 4);
    tr[2] = readU32Be(input16, 8);
    tr[3] = readU32Be(input16, 12);
    for (let i = 0; i < 32; i += 1) {
      const ta = gTransform((tr[i + 1] ^ tr[i + 2] ^ tr[i + 3] ^ (ZK[i] | 0)) | 0);
      tr[i + 4] = (tr[i] ^ ta) | 0;
    }
    const out = Buffer.alloc(16);
    writeU32Be(tr[35], out, 0);
    writeU32Be(tr[34], out, 4);
    writeU32Be(tr[33], out, 8);
    writeU32Be(tr[32], out, 12);
    return out;
  }

  function xBlocks(data, iv0) {
    let iv = Buffer.from(iv0);
    const out = Buffer.alloc(data.length);
    for (let off = 0; off < data.length; off += 16) {
      const mixed = Buffer.alloc(16);
      for (let i = 0; i < 16; i += 1) mixed[i] = (data[off + i] ^ iv[i]) & 0xff;
      iv = rBlock(mixed);
      iv.copy(out, off, 0, 16);
    }
    return out;
  }

  function customEncode(bytesIn) {
    let bytes = Buffer.from(bytesIn);
    const rem = bytes.length % 3;
    if (rem !== 0) bytes = Buffer.concat([bytes, Buffer.alloc(3 - rem)]);

    let out = '';
    let i = 0;
    for (let p = bytes.length - 1; p >= 0; p -= 3) {
      let v = 0;
      const b0 = bytes[p] & 0xff;
      const m0 = (58 >>> (8 * (i % 4))) & 0xff;
      i += 1;
      v |= (b0 ^ m0) & 0xff;

      const b1 = bytes[p - 1] & 0xff;
      const m1 = (58 >>> (8 * (i % 4))) & 0xff;
      i += 1;
      v |= ((b1 ^ m1) & 0xff) << 8;

      const b2 = bytes[p - 2] & 0xff;
      const m2 = (58 >>> (8 * (i % 4))) & 0xff;
      i += 1;
      v |= ((b2 ^ m2) & 0xff) << 16;

      out += ALPHABET[v & 63];
      out += ALPHABET[(v >>> 6) & 63];
      out += ALPHABET[(v >>> 12) & 63];
      out += ALPHABET[(v >>> 18) & 63];
    }
    return out;
  }

  function encryptZseV4(input) {
    const inputBytes = encodeUriComponentBytes(input);
    let plain = Buffer.concat([Buffer.from([210, 0]), inputBytes]);
    plain[0] = 12;
    const pad = 16 - (plain.length % 16);
    plain = Buffer.concat([plain, Buffer.alloc(pad, pad)]);

    const first = Buffer.alloc(16);
    for (let i = 0; i < 16; i += 1) first[i] = (plain[i] ^ KEY16[i] ^ 42) & 0xff;

    const c0 = rBlock(first);
    const cipher = Buffer.alloc(plain.length);
    c0.copy(cipher, 0, 0, 16);
    if (plain.length > 16) xBlocks(plain.subarray(16), c0).copy(cipher, 16);
    return customEncode(cipher);
  }

  function buildCookieHeader() {
    return Object.entries(getCookieMap())
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  function buildSignedHeaders(url, body = '', extraHeaders = {}) {
    const cookies = getCookieMap();
    const urlObj = new URL(url);
    const pathname = `${urlObj.pathname}${urlObj.search}`;
    const signSource = [ZSE93, pathname, cookies.d_c0 || '', body || ''].join('+');
    const md5 = crypto.createHash('md5').update(signSource).digest('hex');
    const headers = {
      'User-Agent':
        getZhihuConfig().userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: extraHeaders.Referer || 'https://www.zhihu.com/',
      Origin: extraHeaders.Origin || 'https://www.zhihu.com',
      'x-zse-93': ZSE93,
      'x-zse-96': `2.0_${encryptZseV4(md5)}`,
      'x-requested-with': 'fetch',
      ...extraHeaders
    };
    const cookieHeader = buildCookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;
    return headers;
  }

  async function fetchAnswerApi(answerId) {
    const url =
      `https://www.zhihu.com/api/v4/answers/${answerId}` +
      '?include=content,paid_info,can_comment,excerpt,thanks_count,voteup_count,comment_count,visited_count,' +
      'reaction,ip_info,pagination_info,question.title,question.id,author.name,author.headline,author.url_token,' +
      'created_time,updated_time';
    const resp = await axios.get(url, { timeout: 20000, headers: buildSignedHeaders(url) });
    return resp?.data;
  }

  async function fetchAnswerAppApi(answerId) {
    const url = `https://api.zhihu.com/answers/${answerId}`;
    const headers = {
      ...ANDROID_HEADERS,
      'User-Agent': ANDROID_USER_AGENT,
      Accept: 'application/json, text/plain, */*'
    };
    const cookieHeader = buildCookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;
    const resp = await axios.get(url, {
      timeout: 20000,
      headers
    });
    return resp?.data;
  }

  async function fetchArticleApi(articleId) {
    const url =
      `https://www.zhihu.com/api/v4/articles/${articleId}` +
      '?include=content,topics,paid_info,can_comment,excerpt,thanks_count,voteup_count,comment_count,visited_count,' +
      'relationship,ip_info,author.name,author.headline,author.url_token,created,updated';
    const resp = await axios.get(url, {
      timeout: 20000,
      headers: buildSignedHeaders(url, '', {
        Referer: `https://zhuanlan.zhihu.com/p/${articleId}`,
        Origin: 'https://zhuanlan.zhihu.com'
      })
    });
    return resp?.data;
  }

  async function fetchArticleAppApi(articleId) {
    const url = `https://api.zhihu.com/articles/${articleId}`;
    const headers = {
      ...ANDROID_HEADERS,
      'User-Agent': ANDROID_USER_AGENT,
      Accept: 'application/json, text/plain, */*'
    };
    const cookieHeader = buildCookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;
    const resp = await axios.get(url, {
      timeout: 20000,
      headers
    });
    return resp?.data;
  }

  function parseAnswerApi(data, target) {
    const html = data?.content || '';
    const questionId = data?.question?.id ? String(data.question.id) : target.questionId || '';
    const answerId = data?.id ? String(data.id) : target.answerId;
    return {
      type: 'answer',
      id: answerId,
      title: data?.question?.title || '',
      authorName: data?.author?.name || '',
      authorHeadline: data?.author?.headline || '',
      voteupCount: Number(data?.voteup_count || 0),
      thanksCount: Number(data?.thanks_count || 0),
      commentCount: Number(data?.comment_count || 0),
      createdAt: formatTime(data?.created_time),
      updatedAt: formatTime(data?.updated_time),
      excerpt: stripHtml(data?.excerpt || ''),
      content: stripHtml(html) || stripHtml(data?.excerpt || ''),
      images: collectImagesFromHtml(html),
      url: questionId
        ? `https://www.zhihu.com/question/${questionId}/answer/${answerId}`
        : `https://www.zhihu.com/answer/${answerId}`,
      source: 'api'
    };
  }

  function parseAnswerAppApi(data, target) {
    const html = data?.content || '';
    const questionId = data?.question?.id ? String(data.question.id) : target.questionId || '';
    const answerId = data?.id ? String(data.id) : target.answerId;
    return {
      type: 'answer',
      id: answerId,
      title: data?.question?.title || '',
      authorName: data?.author?.name || '',
      authorHeadline: data?.author?.headline || '',
      voteupCount: Number(data?.voteup_count || 0),
      thanksCount: Number(data?.thanks_count || 0),
      commentCount: Number(data?.comment_count || 0),
      createdAt: formatTime(data?.created_time),
      updatedAt: formatTime(data?.updated_time),
      excerpt: stripHtml(data?.excerpt || data?.excerpt_new || ''),
      content: stripHtml(html) || stripHtml(data?.excerpt || data?.excerpt_new || ''),
      images: collectImagesFromHtml(html),
      url: questionId
        ? `https://www.zhihu.com/question/${questionId}/answer/${answerId}`
        : `https://www.zhihu.com/answer/${answerId}`,
      source: 'app_api'
    };
  }

  function parseArticleApi(data, target) {
    const html = data?.content || '';
    return {
      type: 'article',
      id: data?.id ? String(data.id) : target.articleId,
      title: data?.title || '',
      authorName: data?.author?.name || '',
      authorHeadline: data?.author?.headline || '',
      voteupCount: Number(data?.voteup_count || 0),
      thanksCount: Number(data?.thanks_count || 0),
      commentCount: Number(data?.comment_count || 0),
      createdAt: formatTime(data?.created),
      updatedAt: formatTime(data?.updated),
      excerpt: stripHtml(data?.excerpt || ''),
      content: stripHtml(html) || stripHtml(data?.excerpt || ''),
      images: collectImagesFromHtml(html),
      topics: Array.isArray(data?.topics) ? data.topics.map((item) => item?.name).filter(Boolean) : [],
      url: `https://zhuanlan.zhihu.com/p/${data?.id || target.articleId}`,
      source: 'api'
    };
  }

  function parseArticleAppApi(data, target) {
    const html = data?.content || '';
    return {
      type: 'article',
      id: data?.id ? String(data.id) : target.articleId,
      title: data?.title || '',
      authorName: data?.author?.name || '',
      authorHeadline: data?.author?.headline || '',
      voteupCount: Number(data?.voteup_count || 0),
      thanksCount: Number(data?.thanks_count || 0),
      commentCount: Number(data?.comment_count || 0),
      createdAt: formatTime(data?.created || data?.created_time),
      updatedAt: formatTime(data?.updated || data?.updated_time),
      excerpt: stripHtml(data?.excerpt || data?.excerpt_new || ''),
      content: stripHtml(html) || stripHtml(data?.excerpt || data?.excerpt_new || ''),
      images: collectImagesFromHtml(html),
      topics: Array.isArray(data?.topics) ? data.topics.map((item) => item?.name).filter(Boolean) : [],
      url: `https://zhuanlan.zhihu.com/p/${data?.id || target.articleId}`,
      source: 'app_api'
    };
  }

  function extractJsonFromHtml(html, markerRegex) {
    const m = String(html || '').match(markerRegex);
    if (!m || !m[1]) return null;
    return safeJsonParse ? safeJsonParse(m[1]) : null;
  }

  function extractJsonAssignments(html) {
    const results = [];
    const patterns = [
      /<script[^>]+id=["']js-initialData["'][^>]*>([\s\S]*?)<\/script>/gi,
      /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?/gi,
      /window\.__INITIAL_DATA__\s*=\s*({[\s\S]*?})\s*;?/gi,
      /window\.__NEXT_DATA__\s*=\s*({[\s\S]*?})\s*;?/gi,
      /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(String(html || '')))) {
        const parsed = safeJsonParse ? safeJsonParse(String(match[1] || '').trim()) : null;
        if (parsed && typeof parsed === 'object') results.push(parsed);
      }
    }

    return results;
  }

  function walkObjects(value, visitor, seen = new Set()) {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    visitor(value);

    if (Array.isArray(value)) {
      for (const item of value) walkObjects(item, visitor, seen);
      return;
    }

    for (const child of Object.values(value)) {
      walkObjects(child, visitor, seen);
    }
  }

  function findBestAnswerFromJsonCandidates(candidates, answerId) {
    const idStr = String(answerId);
    const matched = [];

    for (const candidate of candidates) {
      walkObjects(candidate, (node) => {
        if (!node || Array.isArray(node)) return;
        const nodeId = node.id !== undefined && node.id !== null ? String(node.id) : '';
        const hasAnswerShape =
          node.type === 'answer' ||
          node.answer_type ||
          node.question ||
          node.content ||
          node.excerpt ||
          node.url?.includes?.('/answers/');
        if (nodeId === idStr && hasAnswerShape) matched.push(node);
      });
    }

    matched.sort((a, b) => String(b.content || '').length - String(a.content || '').length);
    return matched[0] || null;
  }

  function findBestArticleFromJsonCandidates(candidates, articleId) {
    const idStr = String(articleId);
    const matched = [];

    for (const candidate of candidates) {
      walkObjects(candidate, (node) => {
        if (!node || Array.isArray(node)) return;
        const nodeId = node.id !== undefined && node.id !== null ? String(node.id) : '';
        const hasArticleShape =
          node.type === 'article' ||
          node.title ||
          node.content ||
          node.excerpt ||
          node.topics ||
          node.url?.includes?.('/articles/') ||
          node.url?.includes?.('/p/');
        if (nodeId === idStr && hasArticleShape) matched.push(node);
      });
    }

    matched.sort((a, b) => String(b.content || '').length - String(a.content || '').length);
    return matched[0] || null;
  }

  function normalizeTopics(topics) {
    return Array.isArray(topics) ? topics.map((item) => item?.name || item?.title || '').filter(Boolean) : [];
  }

  function contentLengthOf(parsed) {
    return String(parsed?.content || parsed?.excerpt || '').length;
  }

  function pickBestParsedResult(results, label) {
    const valid = results.filter((item) => item && contentLengthOf(item.parsed) > 0);
    const chosen = valid.sort((a, b) => contentLengthOf(b.parsed) - contentLengthOf(a.parsed))[0] || results[0] || null;
    if (chosen) {
      console.log(
        `[zhihu] choose ${label} source=${chosen.parsed?.source || 'unknown'} contentLen=${contentLengthOf(chosen.parsed)}`
      );
    }
    return chosen?.parsed || null;
  }

  function findMeta(html, key) {
    const a = String(html || '').match(new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i'));
    const b = String(html || '').match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${key}["']`, 'i'));
    return decodeHtml((a && a[1]) || (b && b[1]) || '');
  }

  async function fetchArticlePage(articleId) {
    return fetchHtmlWithRedirect(`https://zhuanlan.zhihu.com/p/${articleId}`, {
      headers: {
        'User-Agent':
          getZhihuConfig().userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        Referer: 'https://www.zhihu.com/'
      },
      timeout: 20000
    });
  }

  async function fetchAnswerPage(target) {
    const url = target.questionId
      ? `https://www.zhihu.com/question/${target.questionId}/answer/${target.answerId}`
      : `https://www.zhihu.com/answer/${target.answerId}`;
    return fetchHtmlWithRedirect(url, {
      headers: {
        'User-Agent':
          getZhihuConfig().userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        Referer: 'https://www.zhihu.com/'
      },
      timeout: 20000
    });
  }

  function parseArticlePage(html, finalUrl, target) {
    const candidates = extractJsonAssignments(html);
    const state = extractJsonFromHtml(html, /<script[^>]+id=["']js-initialData["'][^>]*>([\s\S]*?)<\/script>/i);
    const article =
      state?.initialState?.entities?.articles?.[String(target.articleId)] ||
      findBestArticleFromJsonCandidates(candidates, target.articleId) ||
      null;
    const title = article?.title || findMeta(html, 'og:title');
    const excerpt = article?.excerpt || findMeta(html, 'og:description');
    const htmlContent = article?.content || '';
    return {
      type: 'article',
      id: String(target.articleId),
      title: title || '',
      authorName: article?.author?.name || '',
      authorHeadline: article?.author?.headline || '',
      voteupCount: Number(article?.voteupCount || article?.voteup_count || 0),
      thanksCount: Number(article?.thanksCount || article?.thanks_count || 0),
      commentCount: Number(article?.commentCount || article?.comment_count || 0),
      createdAt: formatTime(article?.created || article?.createdTime),
      updatedAt: formatTime(article?.updated || article?.updatedTime),
      excerpt: stripHtml(excerpt || ''),
      content: stripHtml(htmlContent) || stripHtml(excerpt || ''),
      images: collectImagesFromHtml(htmlContent || html),
      topics: normalizeTopics(article?.topics),
      url: finalUrl || `https://zhuanlan.zhihu.com/p/${target.articleId}`,
      source: 'page'
    };
  }

  function parseAnswerPage(html, finalUrl, target) {
    const candidates = extractJsonAssignments(html);
    const answer = findBestAnswerFromJsonCandidates(candidates, target.answerId) || null;
    const htmlContent = answer?.content || answer?.preview_text || '';
    const title = answer?.question?.title || answer?.title || findMeta(html, 'og:title');
    const excerpt = answer?.excerpt || answer?.excerpt_new || findMeta(html, 'og:description');
    const author = answer?.author || {};
    const questionId =
      answer?.question?.id !== undefined && answer?.question?.id !== null
        ? String(answer.question.id)
        : target.questionId || '';
    return {
      type: 'answer',
      id: String(target.answerId),
      title: title || '',
      authorName: author?.name || '',
      authorHeadline: author?.headline || '',
      voteupCount: Number(answer?.voteup_count || answer?.voteupCount || 0),
      thanksCount: Number(answer?.thanks_count || answer?.thanksCount || 0),
      commentCount: Number(answer?.comment_count || answer?.commentCount || 0),
      createdAt: formatTime(answer?.created_time || answer?.createdTime),
      updatedAt: formatTime(answer?.updated_time || answer?.updatedTime),
      excerpt: stripHtml(excerpt || ''),
      content: stripHtml(htmlContent) || stripHtml(excerpt || ''),
      images: collectImagesFromHtml(htmlContent || html),
      url:
        finalUrl ||
        (questionId
          ? `https://www.zhihu.com/question/${questionId}/answer/${target.answerId}`
          : `https://www.zhihu.com/answer/${target.answerId}`),
      source: 'page'
    };
  }

  function buildReplyText(parsed) {
    const lines = [];
    lines.push(`知乎解析 (${parsed.type === 'answer' ? 'answer' : 'article'}): ${parsed.id}`);
    if (parsed.title) lines.push(`标题: ${parsed.title}`);
    if (parsed.authorName) lines.push(`作者: ${parsed.authorName}${parsed.authorHeadline ? ` (${parsed.authorHeadline})` : ''}`);
    if (parsed.createdAt) lines.push(`发布时间: ${parsed.createdAt}`);
    if (parsed.updatedAt) lines.push(`更新时间: ${parsed.updatedAt}`);
    if (parsed.type === 'article' && Array.isArray(parsed.topics) && parsed.topics.length) {
      lines.push(`话题: ${parsed.topics.slice(0, 6).join(' / ')}`);
    }

    const stats = [
      parsed.voteupCount > 0 ? `赞同: ${parsed.voteupCount}` : null,
      parsed.thanksCount > 0 ? `感谢: ${parsed.thanksCount}` : null,
      parsed.commentCount > 0 ? `评论: ${parsed.commentCount}` : null
    ].filter(Boolean).join(' / ');
    if (stats) lines.push(stats);

    const body = parsed.content || parsed.excerpt;
    if (body) lines.push(`\n正文:\n${body}`);
    if (Array.isArray(parsed.images) && parsed.images.length) lines.push(`图片: ${parsed.images.join(' ')}`);
    if (parsed.url) lines.push(`链接: ${parsed.url}`);
    if (parsed.source === 'page') lines.push('备注: API 受限，已回退到网页解析');
    return lines.filter(Boolean).join('\n');
  }

  async function process(target) {
    if (target.type === 'answer') {
      const parsedCandidates = [];
      try {
        const data = await fetchAnswerApi(target.answerId);
        if (data?.id) {
          const parsed = parseAnswerApi(data, target);
          console.log(`[zhihu] answer api ok contentLen=${contentLengthOf(parsed)}`);
          parsedCandidates.push({ parsed });
        }
      } catch (error) {
        console.log('[zhihu] answer api failed:', error?.response?.status || error?.message || error);
      }
      try {
        const data = await fetchAnswerAppApi(target.answerId);
        if (data?.id) {
          const parsed = parseAnswerAppApi(data, target);
          console.log(`[zhihu] answer app api ok contentLen=${contentLengthOf(parsed)}`);
          parsedCandidates.push({ parsed });
        }
      } catch (error) {
        console.log('[zhihu] answer app api failed:', error?.response?.status || error?.message || error);
      }
      try {
        const page = await fetchAnswerPage(target);
        const parsed = parseAnswerPage(page.html, page.finalUrl, target);
        console.log(`[zhihu] answer page ok contentLen=${contentLengthOf(parsed)}`);
        parsedCandidates.push({ parsed });
      } catch (error) {
        console.log('[zhihu] answer page failed:', error?.response?.status || error?.message || error);
      }
      const parsed = pickBestParsedResult(parsedCandidates, 'answer');
      if (!parsed) throw new Error('知乎回答无可用数据源');
      return { target, parsed, replyText: buildReplyText(parsed) };
    }

    if (target.type === 'article') {
      const parsedCandidates = [];
      try {
        const page = await fetchArticlePage(target.articleId);
        const parsed = parseArticlePage(page.html, page.finalUrl, target);
        console.log(`[zhihu] article page ok contentLen=${contentLengthOf(parsed)}`);
        parsedCandidates.push({ parsed });
      } catch (error) {
        console.log('[zhihu] article page failed:', error?.response?.status || error?.message || error);
      }
      try {
        const data = await fetchArticleApi(target.articleId);
        if (data?.id) {
          const parsed = parseArticleApi(data, target);
          console.log(`[zhihu] article api ok contentLen=${contentLengthOf(parsed)}`);
          parsedCandidates.push({ parsed });
        }
      } catch (error) {
        console.log('[zhihu] article api failed:', error?.response?.status || error?.message || error);
      }
      try {
        const data = await fetchArticleAppApi(target.articleId);
        if (data?.id) {
          const parsed = parseArticleAppApi(data, target);
          console.log(`[zhihu] article app api ok contentLen=${contentLengthOf(parsed)}`);
          parsedCandidates.push({ parsed });
        }
      } catch (error) {
        console.log('[zhihu] article app api failed:', error?.response?.status || error?.message || error);
      }
      const parsed = pickBestParsedResult(parsedCandidates, 'article');
      if (!parsed) throw new Error('知乎文章无可用数据源');
      return { target, parsed, replyText: buildReplyText(parsed) };
    }

    throw new Error(`不支持的知乎目标类型: ${target.type || 'unknown'}`);
  }

  return {
    name: 'zhihu',
    detect,
    process,
    helpers: {
      extractTarget,
      buildSignedHeaders,
      encryptZseV4,
      fetchAnswerApi,
      fetchAnswerAppApi,
      fetchArticleApi,
      fetchArticleAppApi
    }
  };
}

module.exports = { buildZhihuPlugin };
