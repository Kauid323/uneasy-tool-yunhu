function buildTiebaPlugin(ctx) {
  const { axios, crypto, path } = ctx;
  const protobuf = require('protobufjs');
  const nodeProcess = require('process');

  const TIEBA_PB_BASE_URL = 'https://tiebac.baidu.com';
  const BOUNDARY = '--------7da3d81520810*';
  const CLIENT_VERSION = '12.52.1.0';
  const DEFAULT_UA =
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/135.0.0.0 Mobile Safari/537.36 tieba/' +
    CLIENT_VERSION;

  let pbTypesPromise = null;

  function extractThreadId(text) {
    if (!text) return null;
    const s = String(text);
    const m1 = s.match(/tieba\.baidu\.com\/p\/(\d+)/i) || s.match(/tiebac\.baidu\.com\/p\/(\d+)/i);
    if (m1) return m1[1];
    const m2 = s.match(/[?&]kz=(\d+)/i);
    if (m2) return m2[1];
    return null;
  }

  function detect(text) {
    const threadId = extractThreadId(text);
    if (!threadId) return null;
    const s = String(text);
    const seeLzMatch = s.match(/[?&]see_lz=(\d+)/i);
    const seeLz = seeLzMatch ? Number(seeLzMatch[1]) : 0;
    return { platform: 'tieba', type: 'pb_page', threadId: String(threadId), url: s, seeLz };
  }

  function randHex(n) {
    try {
      return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
    } catch {
      return String(Date.now()) + String(Math.random()).slice(2);
    }
  }

  function formatEventDay(d = new Date()) {
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const dd = d.getDate();
    // Kotlin: SimpleDateFormat("yyyyMdd") -> 月不补零，日补零
    return `${y}${m}${String(dd).padStart(2, '0')}`;
  }

  function buildCommonRequest() {
    const now = Date.now();
    const cuid = `w_${randHex(16)}`;
    const aid = randHex(16);
    const androidIdRaw = '0000000000000000';
    const androidIdB64 = Buffer.from(androidIdRaw, 'utf8').toString('base64');

    return {
      _client_type: 2,
      _client_version: CLIENT_VERSION,
      _client_id: `wappc_${now}_${Math.floor(Math.random() * 1000)}`,
      _phone_imei: '000000000000000',
      from: '1020031h',
      cuid,
      _timestamp: now,
      model: 'K',
      net_type: 1,
      _phone_newimei: '000000000000000',
      pversion: '1.0.3',
      _os_version: '30',
      brand: 'generic',
      lego_lib_version: '3.0.0',
      cuid_galaxy2: cuid,
      c3_aid: aid,
      scr_w: 1080,
      scr_h: 1920,
      scr_dip: 3,
      sdk_ver: '2.34.0',
      framework_ver: '3340042',
      swan_game_ver: '1038000',
      active_timestamp: now,
      first_install_time: now,
      last_update_time: now,
      event_day: formatEventDay(new Date()),
      android_id: androidIdB64,
      cmode: 1,
      start_type: 1,
      user_agent: DEFAULT_UA,
      personalized_rec_switch: 1,
      device_score: '0'
    };
  }

  function buildMultipartBody(parts) {
    const boundary = BOUNDARY;
    const chunks = [];
    for (const p of parts) {
      chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
      const disp = p.filename
        ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`
        : `Content-Disposition: form-data; name="${p.name}"\r\n`;
      chunks.push(Buffer.from(disp, 'utf8'));
      if (p.contentType) {
        chunks.push(Buffer.from(`Content-Type: ${p.contentType}\r\n`, 'utf8'));
      }
      chunks.push(Buffer.from('\r\n', 'utf8'));
      chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data || ''), 'utf8'));
      chunks.push(Buffer.from('\r\n', 'utf8'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return Buffer.concat(chunks);
  }

  async function getPbTypes() {
    if (pbTypesPromise) return pbTypesPromise;

    pbTypesPromise = (async () => {
      const pathMod = path || require('path');
      const protoRoot = pathMod.resolve(nodeProcess.cwd(), 'TiebaLite-4.0-dev', 'app', 'src', 'main', 'protos');

      const root = new protobuf.Root();
      root.resolvePath = function resolvePath(origin, target) {
        if (pathMod.isAbsolute(target)) return target;
        return pathMod.join(protoRoot, target);
      };

      await root.load(pathMod.join(protoRoot, 'PbPage', 'PbPageRequest.proto'), { keepCase: true });
      await root.load(pathMod.join(protoRoot, 'PbPage', 'PbPageResponse.proto'), { keepCase: true });
      root.resolveAll();

      const PbPageRequest = root.lookupType('tieba.pbPage.PbPageRequest');
      const PbPageResponse = root.lookupType('tieba.pbPage.PbPageResponse');
      return { root, PbPageRequest, PbPageResponse };
    })();

    return pbTypesPromise;
  }

  function extractPlainFromPbContents(contents) {
    const arr = Array.isArray(contents) ? contents : [];
    const texts = [];
    const images = [];
    for (const c of arr) {
      const text = c?.text ? String(c.text) : '';
      if (text) texts.push(text);
      const img =
        c?.bigCdnSrc ||
        c?.cdnSrc ||
        c?.bigSrc ||
        c?.src ||
        c?.originSrc ||
        c?.cdnSrcActive ||
        '';
      if (img && typeof img === 'string') {
        const u = img.startsWith('//') ? `https:${img}` : img;
        if (/^https?:\/\//i.test(u)) images.push(u);
      }
      const link = c?.link ? String(c.link) : '';
      if (link && /^https?:\/\//i.test(link)) texts.push(link);
    }
    const contentText = texts.join('').trim();
    return { contentText, images: Array.from(new Set(images)) };
  }

  function buildReplyText(target, decodedObj) {
    const err = decodedObj?.error || {};
    const data = decodedObj?.data || {};
    const thread = data?.thread || {};
    const forum = data?.forum || {};

    const title = thread?.title || '';
    const forumName = forum?.name || '';
    const authorName = thread?.author?.nameShow || thread?.author?.name || '';
    const viewNum = Number(thread?.viewNum || 0);
    const replyNum = Number(thread?.replyNum || 0);

    const postList = Array.isArray(data?.post_list) ? data.post_list : [];
    const firstFloor =
      postList.find((p) => Number(p?.floor) === 1) || data?.first_floor_post || postList[0] || null;

    const parsed = extractPlainFromPbContents(firstFloor?.content);
    const contentPreview =
      parsed.contentText.length > 1200 ? `${parsed.contentText.slice(0, 1200)}...` : parsed.contentText;

    const lines = [];
    lines.push(`贴吧解析 (tieba): ${target.threadId}`);
    if (title) lines.push(`标题: ${title}`);
    if (forumName) lines.push(`吧: ${forumName}`);
    if (authorName) lines.push(`作者: ${authorName}`);
    if (viewNum || replyNum) lines.push(`浏览: ${viewNum || 0} / 回复: ${replyNum || 0}`);
    if (contentPreview) lines.push(`\n正文:\n${contentPreview}`);
    if (parsed.images.length) lines.push(`图片: ${parsed.images.slice(0, 6).join(' ')}`);
    lines.push(`链接: https://tieba.baidu.com/p/${target.threadId}`);

    if (Number(err?.error_code || 0) !== 0) {
      const msg = err?.user_msg || err?.error_msg || '';
      lines.push(`\n错误: ${err.error_code}${msg ? ' ' + msg : ''}`);
    }
    return lines.filter(Boolean).join('\n');
  }

  async function pbPage(threadId) {
    const { PbPageRequest, PbPageResponse } = await getPbTypes();

    const common = buildCommonRequest();
    const requestData = {
      common,
      kz: Number(threadId),
      pid: 0,
      pn: 1,
      r: 0,
      lz: 0,
      rn: 15,
      q_type: 2,
      with_floor: 1,
      floor_rn: 4,
      floor_sort_type: 1,
      scr_w: 1080,
      scr_h: 1920,
      scr_dip: 3,
      st_type: '',
      mark: 0,
      source_type: 2,
      ad_param: { load_count: 0, refresh_count: 1, yoga_lib_version: '1.0', is_req_ad: 1 },
      app_pos: { ap_connected: true, ap_mac: '02:00:00:00:00:00', coordinate_type: 'BD09LL', addr_timestamp: 0 },
      back: 0,
      banner: 0,
      broadcast_id: 0,
      from_push: 0,
      from_smart_frs: 0,
      immersion_video_comment_source: 0,
      is_comm_reverse: 0,
      is_fold_comment_req: 0,
      is_jumpfloor: 0,
      jumpfloor_num: 0,
      need_repost_recommend_forum: 0,
      obj_locate: '',
      obj_param1: '10',
      obj_source: '',
      ori_ugc_type: 0,
      request_times: 0,
      s_model: 0,
      similar_from: 0,
      thread_type: 0,
      weipost: 0
    };

    const payload = { data: requestData };
    const err = PbPageRequest.verify(payload);
    if (err) throw new Error(`PbPageRequest verify failed: ${err}`);
    const message = PbPageRequest.create(payload);
    const bytes = PbPageRequest.encode(message).finish();

    const body = buildMultipartBody([
      { name: 'data', filename: 'file', contentType: 'application/octet-stream', data: Buffer.from(bytes) }
    ]);

    const cuid = common.cuid || `w_${randHex(16)}`;
    const c3Aid = common.c3_aid || randHex(16);
    const url = `${TIEBA_PB_BASE_URL}/c/f/pb/page?cmd=302001&format=protobuf`;

    const resp = await axios.post(url, body, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
        Charset: 'UTF-8',
        client_type: '2',
        x_bd_data_type: 'protobuf',
        cuid,
        cuid_galaxy2: cuid,
        cuid_gid: '',
        c3_aid: c3Aid,
        'User-Agent': DEFAULT_UA,
        cookie: `ka:open; CUID:${cuid}; TBBRAND:K`
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    const buf = new Uint8Array(resp.data);
    const decoded = PbPageResponse.decode(buf);
    const obj = PbPageResponse.toObject(decoded, { longs: Number, enums: String, bytes: String, defaults: true });
    return obj;
  }

  async function processTarget(target) {
    const data = await pbPage(target.threadId);
    const replyText = buildReplyText(target, data);
    return { target, replyText, data };
  }

  return {
    name: 'tieba',
    detect,
    process: processTarget,
    helpers: { extractThreadId, pbPage }
  };
}

module.exports = { buildTiebaPlugin };
