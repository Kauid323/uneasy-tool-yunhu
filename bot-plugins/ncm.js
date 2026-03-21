function buildNcmPlugin(ctx) {
  const {
    axios,
    fs,
    path,
    ncmRequest,
    ncmSongDetail,
    ncmPlaylistDetail,
    ncmSongUrlV1,
    ncmSongUrl,
    secondsToDurationText
  } = ctx;
  const ncmPlaylistTrackAll = require('../api-enhanced-main/api-enhanced-main/module/playlist_track_all');
  const ncmSearch = require('../api-enhanced-main/api-enhanced-main/module/search');
  const ncmCloudSearch = require('../api-enhanced-main/api-enhanced-main/module/cloudsearch');
  const ncmSearchMultimatch = require('../api-enhanced-main/api-enhanced-main/module/search_multimatch');
  const ncmAudioMatch = require('../api-enhanced-main/api-enhanced-main/module/audio_match');
  const { eapi, aesDecrypt } = require('../api-enhanced-main/api-enhanced-main/util/crypto');
  const nodeCrypto = require('crypto');
  const zlib = require('zlib');
  const { spawn } = require('child_process');

  const fsp = fs?.promises;

  function ensureBase64Globals() {
    if (typeof globalThis.atob !== 'function') {
      globalThis.atob = (b64) => Buffer.from(String(b64), 'base64').toString('binary');
    }
    if (typeof globalThis.btoa !== 'function') {
      globalThis.btoa = (bin) => Buffer.from(String(bin), 'binary').toString('base64');
    }
  }

  function resolveTmpDir() {
    if (process.platform === 'win32') {
      return path.resolve(process.cwd(), 'tmp');
    }
    return '/tmp';
  }

  async function safeUnlink(p) {
    if (!p) return;
    try {
      await fsp.unlink(p);
    } catch {}
  }

  async function downloadToFile(url, outPath, { referer } = {}) {
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    const writer = fs.createWriteStream(outPath);
    const resp = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000,
      headers: referer ? { Referer: referer } : undefined
    });

    await new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        err ? reject(err) : resolve();
      };
      writer.on('finish', () => finish());
      writer.on('error', (e) => finish(e));
      resp.data.on('error', (e) => finish(e));
      resp.data.pipe(writer);
    });

    return outPath;
  }

  async function runFfmpeg(args) {
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args, { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (e) => reject(e));
      child.on('close', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg failed (code=${code}): ${stderr || '(no stderr)'}`));
      });
    });
  }

  function sanitizeId(s) {
    return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || `audio_${Date.now()}`;
  }

  function getFileExtFromUrl(url) {
    try {
      const u = new URL(String(url));
      const ext = path.extname(u.pathname || '');
      return ext && ext.length <= 8 ? ext : '';
    } catch {
      return '';
    }
  }

  async function audioUrlToFingerprint({ audioUrl, durationSec, workId }) {
    ensureBase64Globals();

    const tmpDir = resolveTmpDir();
    await fsp.mkdir(tmpDir, { recursive: true });

    const ext = getFileExtFromUrl(audioUrl) || '.m4a';
    const base = sanitizeId(workId);
    const srcPath = path.join(tmpDir, `${base}${ext}`);
    const pcmPath = path.join(tmpDir, `${base}.f32`);

    try {
      await downloadToFile(audioUrl, srcPath, { referer: 'http://myapp.jwznb.com' });

      const dur = Math.max(1, Math.min(15, Number(durationSec) || 3));
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        srcPath,
        '-t',
        String(dur),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        'f32le',
        pcmPath
      ]);

      const buf = await fsp.readFile(pcmPath);
      const usable = buf.byteLength - (buf.byteLength % 4);
      const floatView = new Float32Array(buf.buffer, buf.byteOffset, usable / 4);

      const targetLen = dur * 8000;
      const samples = new Float32Array(targetLen);
      if (floatView.length >= targetLen) {
        samples.set(floatView.subarray(0, targetLen), 0);
      } else {
        samples.set(floatView, 0);
      }

      const { GenerateFP } = require('../api-enhanced-main/api-enhanced-main/public/audio_match_demo/afp.js');
      const fp = await GenerateFP(samples);
      return { fp, duration: dur, cleanupPaths: [srcPath, pcmPath] };
    } catch (e) {
      await safeUnlink(srcPath);
      await safeUnlink(pcmPath);
      throw e;
    }
  }

  function formatAudioMatchReply(resultItems = [], { durationSec } = {}) {
    const items = Array.isArray(resultItems) ? resultItems : [];
    if (items.length === 0) return null;

    const lines = [];
    lines.push(`听歌识曲(约${Number(durationSec) || 3}s)结果:`);
    for (const [idx, item] of items.slice(0, 3).entries()) {
      const entry = item?.song || item?.data?.song || item;
      const song = entry?.song || entry;
      const songId = song?.id || song?.songId || song?.song?.id;
      const songName = song?.name || song?.song?.name || '未知歌曲';
      const albumName = song?.album?.name || song?.al?.name || '';
      const artists = song?.artists || song?.ar || [];
      const artistName = Array.isArray(artists) ? artists.map(a => a?.name).filter(Boolean).join(' / ') : '';
      const startSec = Number(item?.startTime) ? `${Math.max(0, Math.floor(Number(item.startTime) / 1000))}s` : '';
      const link = songId ? `https://music.163.com/song?id=${songId}` : '';
      const tail = [albumName ? `《${albumName}》` : '', startSec ? `@${startSec}` : '', link].filter(Boolean).join(' ');
      lines.push(`${idx + 1}. ${songName}${artistName ? ' - ' + artistName : ''}${tail ? ' ' + tail : ''}`);
    }
    return lines.join('\n');
  }

  async function handleAudioPushMessage(msg) {
    const audioUrl = msg?.content?.audioUrl;
    if (!audioUrl) return null;

    const workId = msg?.msgId || msg?.content?.audioUrl || Date.now();
    const durationSec = msg?.content?.audioTime || 3;

    const { fp, duration, cleanupPaths } = await audioUrlToFingerprint({ audioUrl, durationSec, workId });
    try {
      const matchRes = await ncmAudioMatch({ duration, audioFP: fp });
      const resultItems = matchRes?.body?.data?.result || matchRes?.body?.data?.data?.result || matchRes?.body?.data?.resultSongs || [];
      const replyText = formatAudioMatchReply(resultItems, { durationSec: duration });
      return replyText ? { replyText, raw: matchRes?.body?.data } : null;
    } finally {
      for (const p of cleanupPaths || []) {
        await safeUnlink(p);
      }
    }
  }

  function extractSongId(text) {
    if (!text) return null;
    const s = String(text);

    const cmdMatch = s.match(/\/wyy-get-music-(\d+)/i);
    if (cmdMatch) return cmdMatch[1];

    const m1 = s.match(/https?:\/\/music\.163\.com\/song\/(\d+)/i);
    if (m1) return m1[1];

    const m2 = s.match(/music\.163\.com\/#\/song\?id=(\d+)/i);
    if (m2) return m2[1];

    const m3 = s.match(/music\.163\.com\/song\?[^\s]*\bid=(\d+)/i);
    if (m3) return m3[1];

    const m4 = s.match(/music\.163\.com\/m\/song\?[^\s]*\bid=(\d+)/i);
    if (m4) return m4[1];

    return null;
  }

  function extractPlaylistId(text) {
    if (!text) return null;
    const s = String(text);

    const m1 = s.match(/https?:\/\/music\.163\.com\/playlist\/(\d+)/i);
    if (m1) return m1[1];

    const m2 = s.match(/music\.163\.com\/#\/playlist\?id=(\d+)/i);
    if (m2) return m2[1];

    const m3 = s.match(/music\.163\.com\/playlist\?[^\s]*\bid=(\d+)/i);
    if (m3) return m3[1];

    const m4 = s.match(/music\.163\.com\/m\/playlist\?[^\s]*\bid=(\d+)/i);
    if (m4) return m4[1];

    const m5 = s.match(/music\.163\.com\/m\/playlist\?(?:[^\s]*&)?id=(\d+)/i);
    if (m5) return m5[1];

    return null;
  }

  function extractEventTarget(text) {
    if (!text) return null;
    const s = String(text);

    const share = s.match(/https?:\/\/music\.163\.com\/(?:#\/)?event\?(?:[^\s#&]*&)*id=(\d+)(?:[^\s#&]*&)*uid=(\d+)/i)
      || s.match(/https?:\/\/music\.163\.com\/(?:#\/)?event\?(?:[^\s#&]*&)*id=(\d+)/i);
    if (share) {
      const id = share[1];
      const uid = share[2] || '';
      return {
        type: 'ncm_event',
        id,
        userId: uid,
        sourceScene: '24',
        url: share[0]
      };
    }

    // 直接 eapi 链接：https://interface3.music.163.com/eapi/event/detail/get/v1?id=...&sourceScene=24&userId=...
    const eapiUrl = s.match(/https?:\/\/interface3\.music\.163\.com\/eapi\/event\/detail\/get\/v1\?[^\s]+/i);
    if (eapiUrl) {
      try {
        const u = new URL(eapiUrl[0]);
        const id = u.searchParams.get('id') || '';
        const sourceScene = u.searchParams.get('sourceScene') || '24';
        const userId = u.searchParams.get('userId') || '';
        if (id) {
          return {
            type: 'ncm_event',
            id,
            userId,
            sourceScene,
            url: eapiUrl[0]
          };
        }
      } catch {}
    }

    return null;
  }

  function eapiDecryptToBuffer(cipherBuf) {
    const key = Buffer.from('e82ckenh8dichen8', 'utf8');
    const decipher = nodeCrypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
  }

  function tryDecompressToUtf8(buf) {
    if (!buf || !buf.length) return '';

    // gzip
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        return zlib.gunzipSync(buf).toString('utf8');
      } catch {}
    }

    // zlib/deflate (common zlib header)
    if (buf.length >= 2 && buf[0] === 0x78) {
      try {
        return zlib.inflateSync(buf).toString('utf8');
      } catch {}
    }

    // zstd frame magic: 28 B5 2F FD
    if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
      try {
        return zlib.zstdDecompressSync(buf).toString('utf8');
      } catch {}
    }

    // brotli isn't used by NCM eapi body usually, but keep it for completeness
    try {
      return zlib.brotliDecompressSync(buf).toString('utf8');
    } catch {}

    return buf.toString('utf8');
  }

  function eapiResDecryptSmart(raw) {
    if (raw == null) return null;

    if (typeof raw === 'object' && !Buffer.isBuffer(raw) && !(raw instanceof ArrayBuffer)) {
      return raw;
    }

    let buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (!buf.length) return null;

    // try utf8 text first
    const asText = buf.toString('utf8').trim();
    const looksJson = asText.startsWith('{') || asText.startsWith('[');
    if (looksJson) {
      try {
        return JSON.parse(asText);
      } catch {}
    }

    // maybe it's hex string text
    const hexText = asText.replace(/\s+/g, '');
    const looksHex = hexText.length >= 32 && hexText.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hexText);
    if (looksHex) {
      try {
        const decrypted = aesDecrypt(hexText, 'e82ckenh8dichen8', '', 'hex');
        return JSON.parse(decrypted);
      } catch {}
      try {
        const plainBuf = eapiDecryptToBuffer(Buffer.from(hexText, 'hex'));
        const s = tryDecompressToUtf8(plainBuf).trim();
        return s ? JSON.parse(s) : null;
      } catch {}
      return null;
    }

    // treat as raw ciphertext bytes
    try {
      const plainBuf = eapiDecryptToBuffer(buf);
      const s = tryDecompressToUtf8(plainBuf).trim();
      if (!s) return null;
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function normalizeSearchType(type) {
    const raw = String(type || '').trim();
    const map = {
      '1': '1',
      '单曲': '1',
      '歌曲': '1',
      '10': '10',
      '专辑': '10',
      '100': '100',
      '歌手': '100',
      '艺人': '100',
      '1000': '1000',
      '歌单': '1000',
      '播放列表': '1000',
      '1002': '1002',
      '用户': '1002',
      '网易云用户': '1002',
      '1004': '1004',
      'mv': '1004',
      'MV': '1004',
      '1006': '1006',
      '歌词': '1006',
      '1009': '1009',
      '电台': '1009',
      '1014': '1014',
      '视频': '1014'
    };
    return map[raw] || raw || '1';
  }

  function searchTypeLabel(type) {
    const map = {
      '1': '单曲',
      '10': '专辑',
      '100': '歌手',
      '1000': '歌单',
      '1002': '用户',
      '1004': 'MV',
      '1006': '歌词',
      '1009': '电台',
      '1014': '视频'
    };
    return map[String(type || '')] || String(type || '1');
  }

  function parseSearchCommand(text) {
    const s = String(text || '').trim();
    if (!s.startsWith('/wy-search-')) return null;

    let rest = s.slice('/wy-search-'.length).trim();
    if (!rest) return null;

    let limit;
    let offset;
    const tailMatch = rest.match(/-limit-(\d+)-offest-(\d+)$/i);
    if (tailMatch) {
      limit = Number(tailMatch[1]);
      offset = Number(tailMatch[2]);
      rest = rest.slice(0, tailMatch.index).trim();
    }

    if (!rest) return null;

    const firstDash = rest.indexOf('-');
    let searchType = '1';
    let keyword = rest;

    if (firstDash > 0) {
      const maybeType = rest.slice(0, firstDash).trim();
      const normalizedType = normalizeSearchType(maybeType);
      const knownTypes = new Set(['1', '10', '100', '1000', '1002', '1004', '1006', '1009', '1014']);
      if (knownTypes.has(normalizedType)) {
        searchType = normalizedType;
        keyword = rest.slice(firstDash + 1).trim();
      }
    }

    if (!keyword) return null;
    return {
      type: 'ncm_search',
      searchType,
      keyword,
      limit,
      offset
    };
  }

  function detect(text) {
    if (!text) return null;

    const multiSearchCmd = String(text).match(/^\/wy-multisearch-(.+)$/i);
    if (multiSearchCmd && multiSearchCmd[1]?.trim()) {
      return {
        type: 'ncm_multi_search',
        keyword: multiSearchCmd[1].trim()
      };
    }

    const searchCmd = parseSearchCommand(text);
    if (searchCmd) {
      return searchCmd;
    }

    const musicCmd = String(text).match(/\/wyy-get-music-(\d+)/i);
    if (musicCmd) {
      return {
        type: 'ncm_song_command',
        id: musicCmd[1],
        unblock: false
      };
    }

    const playlistTracksCmd = String(text).match(/\/wyy-get-playlist-(\d+)-limit-(\d+)-offest-(\d+)/i);
    if (playlistTracksCmd) {
      return {
        type: 'ncm_playlist_tracks',
        id: playlistTracksCmd[1],
        limit: Number(playlistTracksCmd[2]),
        offset: Number(playlistTracksCmd[3])
      };
    }

    const ncmUbMatch = text.match(/\/gbbot-ncm-ubmusic-(https?:\/\/\S+)/i);
    if (ncmUbMatch) {
      const maybeUrl = ncmUbMatch[1];
      const songId = extractSongId(maybeUrl);
      if (songId) return { type: 'ncm_song', id: songId, url: maybeUrl, unblock: true };

      const short163 = String(maybeUrl).match(/https?:\/\/163cn\.tv\/[A-Za-z0-9]+/i);
      if (short163) return { type: 'ncm_short_song', url: short163[0], unblock: true };
    }

    const songId = extractSongId(text);
    if (songId) return { type: 'ncm_song', id: songId, unblock: false };

    const playlistId = extractPlaylistId(text);
    if (playlistId) return { type: 'ncm_playlist', id: playlistId, unblock: false };

    const short163 = String(text).match(/https?:\/\/163cn\.tv\/[A-Za-z0-9]+/i);
    if (short163) return { type: 'ncm_short_song', url: short163[0], unblock: false };

    const eventTarget = extractEventTarget(text);
    if (eventTarget) return eventTarget;

    return null;
  }

  async function fetchSongDetail(songId) {
    const query = { ids: String(songId) };
    console.log('[NCM] song_detail request:', JSON.stringify(query));
    const res = await ncmSongDetail(query, ncmRequest);
    console.log('[NCM] song_detail response status:', res?.status);
    console.log('[NCM] song_detail response body(code):', res?.body?.code);
    return res;
  }

  async function fetchPlaylistDetail(playlistId) {
    const query = { id: String(playlistId), s: 8 };
    console.log('[NCM] playlist_detail request:', JSON.stringify(query));
    const res = await ncmPlaylistDetail(query, ncmRequest);
    console.log('[NCM] playlist_detail response status:', res?.status);
    console.log('[NCM] playlist_detail response body(code):', res?.body?.code);
    return res;
  }

  async function fetchPlaylistTracks(playlistId, { limit = 10, offset = 0, s = 8 } = {}) {
    const query = {
      id: String(playlistId),
      limit: Number(limit),
      offset: Number(offset),
      s: Number(s)
    };
    console.log('[NCM] playlist_track_all request:', JSON.stringify(query));
    const res = await ncmPlaylistTrackAll(query, ncmRequest);
    console.log('[NCM] playlist_track_all response status:', res?.status);
    console.log('[NCM] playlist_track_all response body(code):', res?.body?.code);
    return res;
  }

  async function fetchEventDetailEapi({ id, userId = '', sourceScene = '24' } = {}) {
    const apiPath = '/api/event/detail/get/v1';
    const postUrl = 'https://interface3.music.163.com/eapi/event/detail/get/v1';
    const data = {
      id: String(id),
      sourceScene: String(sourceScene || '24'),
      userId: String(userId || ''),
      header: '{}',
      e_r: true
    };

    const enc = eapi(apiPath, data);
    const form = new URLSearchParams({ params: enc.params }).toString();

    const resp = await axios.post(postUrl, form, {
      timeout: 20000,
      headers: {
        'User-Agent': 'NeteaseMusic/9.4.32.251220220530(9004032);Dalvik/2.1.0 (Linux; U; Android 11; Redmi 6A Build/RQ3A.211001.001)',
        Connection: 'keep-alive',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-os': 'android',
        'x-osver': '11',
        'x-appver': '9.4.32',
        cookie: 'appver=9.4.32'
      },
      responseType: 'arraybuffer',
      transformResponse: (r) => r
    });

    const decrypted = eapiResDecryptSmart(resp?.data);
    if (!decrypted) {
      throw new Error('eapi event detail decrypt failed');
    }
    return decrypted;
  }

  function buildEventReplyText({ event, code } = {}, { id, userId } = {}) {
    if (!event) return `网易云解析 (event): ${id || ''}\n解析失败: event empty`;

    const lines = [];
    lines.push(`网易云解析 (event): ${event?.id || id || ''}`);

    const user = event?.user || {};
    if (user?.nickname) lines.push(`作者: ${user.nickname}${user?.userId ? ` (${user.userId})` : ''}`);
    if (user?.signature) lines.push(`签名: ${user.signature}`);
    if (user?.avatarUrl) lines.push(`头像: ${user.avatarUrl}`);

    const ts = Number(event?.eventTime || event?.showTime || 0);
    if (ts > 0) {
      const d = new Date(ts);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      lines.push(`时间: ${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`);
    }

    if (event?.actName) lines.push(`活动: ${event.actName}`);

    let note = null;
    try {
      note = JSON.parse(String(event?.json || ''));
    } catch {}
    if (note?.title) lines.push(`标题: ${note.title}`);
    if (typeof note?.msg === 'string' && note.msg.trim()) {
      const rawMsg = note.msg.replace(/\r/g, '').trim();
      const tags = [];
      const re = /#([^#\s]+)#/g;
      let m;
      while ((m = re.exec(rawMsg))) {
        const t = String(m[1] || '').trim();
        if (t) tags.push(t);
      }
      const uniqueTags = Array.from(new Set(tags));
      if (uniqueTags.length) lines.push(`标签: ${uniqueTags.map((t) => `#${t}#`).join(' ')}`);

      const cleanedMsg = rawMsg.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
      lines.push(`内容: ${cleanedMsg.length > 240 ? cleanedMsg.slice(0, 240) + '…' : cleanedMsg}`);
    }

    const pics = Array.isArray(event?.pics) ? event.pics : [];
    const firstPic = pics[0]?.originUrl || pics[0]?.squareUrl || pics[0]?.pcSquareUrl || pics[0]?.rectangleUrl || '';
    if (firstPic) lines.push(`图片: ${firstPic}`);
    if (pics.length > 1) lines.push(`图片数: ${pics.length}`);

    const song = note?.song || null;
    if (song?.id && song?.name) {
      const artists = Array.isArray(song?.artists) ? song.artists.map(a => a?.name).filter(Boolean).join(' / ') : '';
      lines.push(`配乐: ${song.name}${artists ? ' - ' + artists : ''}`);
      lines.push(`歌曲: https://music.163.com/song?id=${song.id}`);
    }

    const liked = event?.info?.likedCount;
    const comments = event?.info?.commentCount;
    if (Number.isFinite(Number(liked)) || Number.isFinite(Number(comments))) {
      lines.push(`互动: 赞 ${Number(liked) || 0} · 评论 ${Number(comments) || 0}`);
    }

    const ipLoc = event?.ipLocation?.location;
    if (ipLoc) lines.push(`IP属地: ${ipLoc}`);

    const linkUid = user?.userId || userId || '';
    lines.push(`链接: https://music.163.com/event?id=${event?.id || id}${linkUid ? `&uid=${linkUid}` : ''}`);
    return lines.join('\n');
  }

  async function fetchMultiSearch(keyword) {
    const query = { keywords: String(keyword), type: 1 };
    console.log('[NCM] search_multimatch request:', JSON.stringify(query));
    const res = await ncmSearchMultimatch(query, ncmRequest);
    console.log('[NCM] search_multimatch response status:', res?.status);
    console.log('[NCM] search_multimatch response body(code):', res?.body?.code);
    console.log('[NCM] search_multimatch response body raw:');
    console.log(JSON.stringify(res?.body || {}, null, 2));
    return res;
  }

  async function fetchCloudSearch({ keyword, type = '1', limit, offset } = {}) {
    const query = {
      keywords: String(keyword),
      type: String(type),
      timestamp: Date.now()
    };
    if (limit !== undefined && Number.isFinite(Number(limit))) query.limit = Number(limit);
    if (offset !== undefined && Number.isFinite(Number(offset))) query.offset = Number(offset);
    console.log('[NCM] cloudsearch module request:', JSON.stringify(query));
    const res = await ncmCloudSearch(query, ncmRequest);
    console.log('[NCM] cloudsearch module response status:', res?.status);
    console.log('[NCM] cloudsearch module response body(code):', res?.body?.code);
    console.log('[NCM] cloudsearch module response body raw:');
    console.log(JSON.stringify(res?.body || {}, null, 2));
    return res;
  }

  async function fetchSearch({ keyword, type = '1', limit, offset } = {}) {
    const query = {
      keywords: String(keyword),
      type: String(type)
    };
    if (limit !== undefined && Number.isFinite(Number(limit))) query.limit = Number(limit);
    if (offset !== undefined && Number.isFinite(Number(offset))) query.offset = Number(offset);

    try {
      const cloudRes = await fetchCloudSearch({ keyword, type, limit, offset });
      console.log('[NCM] search selected source: cloudsearch-module');
      return cloudRes;
    } catch (e) {
      console.log('[NCM] cloudsearch module failed, fallback to module/search:', e?.message || e);
    }

    console.log('[NCM] search request:', JSON.stringify(query));
    const res = await ncmSearch(query, ncmRequest);
    console.log('[NCM] search response status:', res?.status);
    console.log('[NCM] search response body(code):', res?.body?.code);
    console.log('[NCM] search response body raw:');
    console.log(JSON.stringify(res?.body || {}, null, 2));
    return res;
  }

  async function fetchSongAudio(songId, { unblock = false, source = 'unm', level = 'standard' } = {}) {
    const tryOld = async () => {
      const query = { id: String(songId), br: 999000 };
      console.log('[NCM] song_url request:', JSON.stringify(query));
      const res = await ncmSongUrl(query, ncmRequest);
      console.log('[NCM] song_url response status:', res?.status);
      console.log('[NCM] song_url response body(code):', res?.body?.code);
      return res;
    };

    const tryV1Official = async () => {
      const query = {
        id: String(songId),
        level: String(level),
        unblock: unblock ? 'true' : 'false',
        source: String(source)
      };
      console.log('[NCM] song_url_v1(official) request:', JSON.stringify(query));
      const res = await ncmSongUrlV1(query, ncmRequest);
      console.log('[NCM] song_url_v1(official) response status:', res?.status);
      console.log('[NCM] song_url_v1(official) response body(code):', res?.body?.code);
      return res;
    };

    const withTimeout = (promise, ms, tag) => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${tag} timeout after ${ms}ms`)), ms);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };

    const tryLocalUnblockModules = async () => {
      const pathMod = path || require('path');
      const unblockDir = pathMod.resolve(__dirname, '..', 'UnblockNeteaseMusic-utils-main', 'modules');
      const candidates = [
        { name: 'unm', file: pathMod.join(unblockDir, 'unm.js'), method: 'unm' },
        { name: 'baka', file: pathMod.join(unblockDir, 'baka.js'), method: 'baka' },
        { name: 'gdmusic', file: pathMod.join(unblockDir, 'gdmusic.js'), method: 'gdmusic' },
        { name: 'msls', file: pathMod.join(unblockDir, 'msls.js'), method: 'msls' },
        { name: 'qijieya', file: pathMod.join(unblockDir, 'qijieya.js'), method: 'qijieya' },
        { name: 'bikonoo', file: pathMod.join(unblockDir, 'bikonoo.js'), method: 'bikonoo' }
      ];

      for (const c of candidates) {
        let mod;
        try {
          mod = require(c.file);
        } catch (e) {
          console.log(`[NCM][unblock] skip ${c.name}: cannot require ${c.file}:`, e?.message || e);
          continue;
        }

        const fn = mod?.[c.method];
        if (typeof fn !== 'function') {
          console.log(`[NCM][unblock] skip ${c.name}: method ${c.method} not found`);
          continue;
        }

        try {
          console.log(`[NCM][unblock] try source=${c.name} songId=${songId}`);
          const url = await withTimeout(Promise.resolve(fn(String(songId))), 15000, `unblock:${c.name}`);
          if (typeof url === 'string' && url.startsWith('http')) {
            return { source: `unblock:${c.name}`, url };
          }
          console.log(`[NCM][unblock] ${c.name} returned empty url`);
        } catch (e) {
          console.log(`[NCM][unblock] ${c.name} failed:`, e?.message || e);
        }
      }

      return null;
    };

    if (unblock) {
      const ub = await tryLocalUnblockModules();
      if (ub?.url) return { source: ub.source, res: null, url: ub.url };
    }

    const r2 = await tryOld();
    const url2 = r2?.body?.data?.[0]?.url;
    if (url2) return { source: 'song_url', res: r2, url: url2 };

    const r3 = await tryV1Official();
    const url3 = r3?.body?.data?.[0]?.url;
    return { source: 'song_url_v1_official', res: r3, url: url3 || '' };
  }

  function parseSongDetail(body) {
    const songs = body?.songs;
    const song = Array.isArray(songs) && songs.length ? songs[0] : null;
    if (!song) return null;

    const name = song?.name || '';
    const artists = Array.isArray(song?.ar) ? song.ar.map((a) => a?.name).filter(Boolean) : [];
    const album = song?.al?.name || '';
    const picUrl = song?.al?.picUrl || '';
    const durationMs = Number(song?.dt || 0);
    const durationText = durationMs > 0 ? secondsToDurationText(Math.floor(durationMs / 1000)) : '';

    return { name, artists, album, picUrl, durationText };
  }

  function parsePlaylistDetail(body) {
    const playlist = body?.playlist;
    if (!playlist) return null;

    const creator = playlist?.creator || {};
    return {
      name: playlist?.name || '',
      description: playlist?.description || '',
      coverImgUrl: playlist?.coverImgUrl || '',
      creatorName: creator?.nickname || '',
      trackCount: Number(playlist?.trackCount || 0),
      playCount: Number(playlist?.playCount || 0),
      subscribedCount: Number(playlist?.subscribedCount || 0),
      commentCount: Number(playlist?.commentCount || 0),
      shareCount: Number(playlist?.shareCount || 0),
      createTime: Number(playlist?.createTime || 0),
      updateTime: Number(playlist?.updateTime || 0),
      tags: Array.isArray(playlist?.tags) ? playlist.tags.filter(Boolean) : []
    };
  }

  function parsePlaylistTracks(body) {
    const songs = Array.isArray(body?.songs) ? body.songs : [];
    return songs.map((song, index) => {
      const artists = Array.isArray(song?.ar) ? song.ar.map((a) => a?.name).filter(Boolean) : [];
      const durationMs = Number(song?.dt || 0);
      return {
        index: index + 1,
        id: song?.id ? String(song.id) : '',
        name: song?.name || '',
        artists,
        album: song?.al?.name || '',
        durationText: durationMs > 0 ? secondsToDurationText(Math.floor(durationMs / 1000)) : ''
      };
    });
  }

  function stripHtml(text) {
    return String(text || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').trim();
  }

  function parseMultiSearch(body) {
    console.log('[NCM] parseMultiSearch input keys:', Object.keys(body || {}));
    const result = body?.result || body || {};
    console.log('[NCM] parseMultiSearch result keys:', Object.keys(result || {}));
    const parsed = {
      songs: Array.isArray(result?.songs) ? result.songs.map((song) => ({
        id: song?.id ? String(song.id) : '',
        name: song?.name || '',
        artists: Array.isArray(song?.artists) ? song.artists.map((a) => a?.name).filter(Boolean) : [],
        album: song?.album?.name || ''
      })) : [],
      artists: Array.isArray(result?.artists) ? result.artists.map((artist) => ({
        id: artist?.id ? String(artist.id) : '',
        name: artist?.name || '',
        alias: Array.isArray(artist?.alias) ? artist.alias.filter(Boolean) : []
      })) : [],
      albums: Array.isArray(result?.albums) ? result.albums.map((album) => ({
        id: album?.id ? String(album.id) : '',
        name: album?.name || '',
        artist: album?.artist?.name || ''
      })) : [],
      playlists: Array.isArray(result?.playlists) ? result.playlists.map((playlist) => ({
        id: playlist?.id ? String(playlist.id) : '',
        name: playlist?.name || '',
        creator: playlist?.creator?.nickname || '',
        trackCount: Number(playlist?.trackCount || 0)
      })) : []
    };
    console.log('[NCM] parseMultiSearch parsed counts:', JSON.stringify({
      songs: parsed.songs.length,
      artists: parsed.artists.length,
      albums: parsed.albums.length,
      playlists: parsed.playlists.length
    }));
    return parsed;
  }

  function buildKeywordMatcher(keyword) {
    const normalized = String(keyword || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const compact = normalized.replace(/\s+/g, '');
    return {
      normalized,
      compact,
      score(text) {
        const src = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const srcCompact = src.replace(/\s+/g, '');
        if (!normalized || !src) return 0;
        if (src === normalized) return 200;
        if (srcCompact === compact) return 180;
        if (src.startsWith(normalized)) return 120;
        if (srcCompact.startsWith(compact)) return 110;
        if (src.includes(` ${normalized} `) || src.includes(normalized)) return 80;
        if (srcCompact.includes(compact)) return 70;
        return 0;
      }
    };
  }

  function rankByKeyword(items, keyword, fields = [], popularityGetter = null, { minScore = 1 } = {}) {
    const matcher = buildKeywordMatcher(keyword);
    return [...(Array.isArray(items) ? items : [])]
      .map((item, index) => {
        const fieldScore = fields.reduce((sum, field) => {
          const value = typeof field === 'function' ? field(item) : item?.[field];
          return sum + matcher.score(Array.isArray(value) ? value.join(' / ') : value);
        }, 0);
        const primary = fields.length ? (typeof fields[0] === 'function' ? fields[0](item) : item?.[fields[0]]) : '';
        const exactBonus = matcher.score(Array.isArray(primary) ? primary.join(' / ') : primary) >= 180 ? 1000 : 0;
        const popularity = typeof popularityGetter === 'function' ? Number(popularityGetter(item) || 0) : 0;
        return { item, index, score: exactBonus + fieldScore * 10 + popularity / 1000, rawFieldScore: fieldScore };
      })
      .filter((entry) => entry.rawFieldScore >= minScore)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((x) => x.item);
  }

  function rankSongSearchItems(items, keyword) {
    return rankByKeyword(items, keyword, [
      'name',
      (item) => Array.isArray(item?.artists) ? item.artists.join(' / ') : '',
      'album'
    ], (item) => item?.pop || item?.popularity || 0);
  }

  function parseSearch(body, searchType, keyword = '') {
    console.log('[NCM] parseSearch input keys:', Object.keys(body || {}));
    const result = body?.result || body || {};
    const type = String(searchType || '1');
    const strictFilterTypes = new Set(['10', '100', '1000', '1002', '1004', '1006', '1009', '1014']);
    const minScore = strictFilterTypes.has(type) ? 1 : 0;
    console.log('[NCM] parseSearch result keys:', Object.keys(result || {}));
    console.log('[NCM] parseSearch type:', type, 'keyword:', keyword, 'minScore:', minScore);
    if (type === '1') {
      const items = Array.isArray(result?.songs) ? result.songs.map((song) => ({
        id: song?.id ? String(song.id) : '',
        name: song?.name || '',
        artists: Array.isArray(song?.artists) ? song.artists.map((a) => a?.name).filter(Boolean) : [],
        album: song?.album?.name || '',
        popularity: Number(song?.popularity || song?.score || song?.pop || 0),
        durationText: secondsToDurationText(Math.floor(Number(song?.duration || 0) / 1000))
      })) : [];
      return {
        items: rankSongSearchItems(items, keyword),
        total: Number(result?.songCount || 0)
      };
    }
    if (type === '10') {
      const items = Array.isArray(result?.albums) ? result.albums.map((album) => ({
        id: album?.id ? String(album.id) : '',
        name: album?.name || '',
        artist: album?.artist?.name || '',
        size: Number(album?.size || 0)
      })) : [];
      return {
        items: rankByKeyword(items, keyword, ['name', 'artist'], (item) => item?.size || 0, { minScore }),
        total: Number(result?.albumCount || 0)
      };
    }
    if (type === '100') {
      const items = Array.isArray(result?.artists) ? result.artists.map((artist) => ({
        id: artist?.id ? String(artist.id) : '',
        name: artist?.name || '',
        albumSize: Number(artist?.albumSize || 0),
        musicSize: Number(artist?.musicSize || 0)
      })) : [];
      return {
        items: rankByKeyword(items, keyword, ['name'], (item) => (item?.musicSize || 0) + (item?.albumSize || 0), { minScore }),
        total: Number(result?.artistCount || 0)
      };
    }
    if (type === '1000') {
      const items = Array.isArray(result?.playlists) ? result.playlists.map((playlist) => ({
        id: playlist?.id ? String(playlist.id) : '',
        name: playlist?.name || '',
        creator: playlist?.creator?.nickname || '',
        description: playlist?.description || '',
        trackCount: Number(playlist?.trackCount || 0),
        playCount: Number(playlist?.playCount || 0)
      })) : [];
      return {
        items: rankByKeyword(items, keyword, ['name', 'creator', 'description'], (item) => item?.playCount || 0, { minScore }),
        total: Number(result?.playlistCount || 0)
      };
    }
    if (type === '1002') {
      const items = Array.isArray(result?.userprofiles) ? result.userprofiles.map((user) => ({
        id: user?.userId ? String(user.userId) : '',
        name: user?.nickname || '',
        signature: user?.signature || '',
        playlistCount: Number(user?.playlistCount || 0)
      })) : [];
      return {
        items: rankByKeyword(items, keyword, ['name', 'signature'], (item) => item?.playlistCount || 0, { minScore }),
        total: Number(result?.userprofileCount || 0)
      };
    }
    if (type === '1004') {
      const items = Array.isArray(result?.mvs) ? result.mvs.map((mv) => ({
        id: mv?.id ? String(mv.id) : '',
        name: mv?.name || '',
        artist: mv?.artistName || '',
        playCount: Number(mv?.playCount || 0)
      })) : [];
      return {
        items: rankByKeyword(items, keyword, ['name', 'artist'], (item) => item?.playCount || 0, { minScore }),
        total: Number(result?.mvCount || 0)
      };
    }
    if (type === '1006') {
      const items = Array.isArray(result?.songs) ? result.songs.map((song) => ({
        id: song?.id ? String(song.id) : '',
        name: song?.name || '',
        artists: Array.isArray(song?.artists) ? song.artists.map((a) => a?.name).filter(Boolean) : []
      })) : [];
      return {
        items: rankByKeyword(items, keyword, ['name', (item) => Array.isArray(item?.artists) ? item.artists.join(' / ') : ''], null, { minScore }),
        total: Number(result?.songCount || 0)
      };
    }
    if (type === '1009') {
      const items = Array.isArray(result?.djRadios) ? result.djRadios.map((radio) => ({
        id: radio?.id ? String(radio.id) : '',
        name: radio?.name || '',
        dj: radio?.dj?.nickname || '',
        subCount: Number(radio?.subCount || 0)
      })) : [];
      return {
        items: rankByKeyword(items, keyword, ['name', 'dj'], (item) => item?.subCount || 0, { minScore }),
        total: Number(result?.djRadiosCount || 0)
      };
    }
    if (type === '1014') {
      const items = Array.isArray(result?.videos) ? result.videos.map((video) => ({
        id: video?.vid ? String(video.vid) : '',
        title: video?.title || '',
        creator: Array.isArray(video?.creator) ? video.creator.map((c) => c?.userName).filter(Boolean) : [],
        durationText: secondsToDurationText(Math.floor(Number(video?.durationms || 0) / 1000))
      })) : [];
      return {
        items: rankByKeyword(items, keyword, ['title', (item) => Array.isArray(item?.creator) ? item.creator.join(' / ') : ''], null, { minScore }),
        total: Number(result?.videoCount || 0)
      };
    }
    return { items: [], total: 0 };
  }

  function buildMultiSearchReplyText(keyword, parsed) {
    const lines = [`网易云搜索 (multi): ${keyword}`];

    if (parsed?.songs?.length) {
      lines.push('单曲:');
      for (const song of parsed.songs.slice(0, 3)) {
        lines.push(`- ${song.name} - ${song.artists.join(' / ') || '-'}${song.album ? ` | ${song.album}` : ''} | id:${song.id}`);
      }
    }
    if (parsed?.artists?.length) {
      lines.push('歌手:');
      for (const artist of parsed.artists.slice(0, 3)) {
        lines.push(`- ${artist.name}${artist.alias?.length ? ` (${artist.alias.join(' / ')})` : ''} | id:${artist.id}`);
      }
    }
    if (parsed?.albums?.length) {
      lines.push('专辑:');
      for (const album of parsed.albums.slice(0, 3)) {
        lines.push(`- ${album.name}${album.artist ? ` - ${album.artist}` : ''} | id:${album.id}`);
      }
    }
    if (parsed?.playlists?.length) {
      lines.push('歌单:');
      for (const playlist of parsed.playlists.slice(0, 3)) {
        lines.push(`- ${playlist.name}${playlist.creator ? ` - ${playlist.creator}` : ''} | ${playlist.trackCount}首 | id:${playlist.id}`);
      }
    }

    if (lines.length === 1) lines.push('无搜索结果');
    return lines.join('\n');
  }

  function buildSearchReplyText({ keyword, searchType, limit, offset }, parsed) {
    const displayLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.min(Number(limit), 50)
      : 8;
    const lines = [
      `网易云搜索 (${searchTypeLabel(searchType)}): ${keyword}`,
      `类型代码: ${searchType}`,
      parsed?.total !== undefined ? `总数: ${parsed.total}` : null,
      limit !== undefined ? `limit: ${limit}` : null,
      offset !== undefined ? `offset: ${offset}` : null,
      `展示数量: ${Math.min(displayLimit, Array.isArray(parsed?.items) ? parsed.items.length : 0)}`
    ].filter(Boolean);

    if (!parsed?.items?.length) {
      lines.push('无搜索结果');
      return lines.join('\n');
    }

    for (const item of parsed.items.slice(0, displayLimit)) {
      if (String(searchType) === '1') {
        lines.push(`- ${item.name} - ${item.artists.join(' / ') || '-'}${item.album ? ` | ${item.album}` : ''}${item.durationText ? ` | ${item.durationText}` : ''} | id:${item.id}`);
      } else if (String(searchType) === '10') {
        lines.push(`- ${item.name}${item.artist ? ` - ${item.artist}` : ''} | ${item.size}首 | id:${item.id}`);
      } else if (String(searchType) === '100') {
        lines.push(`- ${item.name} | 专辑:${item.albumSize} | 单曲:${item.musicSize} | id:${item.id}`);
      } else if (String(searchType) === '1000') {
        lines.push(`- ${item.name}${item.creator ? ` - ${item.creator}` : ''} | ${item.trackCount}首 | 播放:${item.playCount} | id:${item.id}`);
      } else if (String(searchType) === '1002') {
        lines.push(`- ${item.name} | 歌单:${item.playlistCount} | id:${item.id}${item.signature ? ` | ${stripHtml(item.signature).slice(0, 40)}` : ''}`);
      } else if (String(searchType) === '1004') {
        lines.push(`- ${item.name}${item.artist ? ` - ${item.artist}` : ''} | 播放:${item.playCount} | id:${item.id}`);
      } else if (String(searchType) === '1006') {
        lines.push(`- ${item.name} - ${item.artists.join(' / ') || '-'} | id:${item.id}`);
      } else if (String(searchType) === '1009') {
        lines.push(`- ${item.name}${item.dj ? ` - ${item.dj}` : ''} | 订阅:${item.subCount} | id:${item.id}`);
      } else if (String(searchType) === '1014') {
        lines.push(`- ${stripHtml(item.title)}${item.creator?.length ? ` - ${item.creator.join(' / ')}` : ''}${item.durationText ? ` | ${item.durationText}` : ''} | id:${item.id}`);
      } else {
        lines.push(`- ${item.name || item.title || item.id || '(鏈煡缁撴灉)'}`);
      }
    }

    return lines.join('\n');
  }

  function buildSongReplyText(songId, parsed, audio) {
    const displayName = parsed?.name || '';
    const artistText = parsed?.artists?.length ? parsed.artists.join(' / ') : '';
    const album = parsed?.album || '';

    return [
      `网易云解析 (ncm): ${songId}`,
      displayName ? `歌曲: ${displayName}` : null,
      artistText ? `歌手: ${artistText}` : null,
      album ? `专辑: ${album}` : null,
      parsed?.durationText ? `时长: ${parsed.durationText}` : null,
      parsed?.picUrl ? `封面: ${parsed.picUrl}` : null,
      audio?.url ? `音频: ${audio.url}` : '音频: (未获取到可用链接)',
      `链接: https://music.163.com/song/${songId}`
    ].filter(Boolean).join('\n');
  }

  function buildSongCommandReplyText(songId, parsed, audio) {
    const displayName = parsed?.name || '';
    const artistText = parsed?.artists?.length ? parsed.artists.join(' / ') : '';
    const album = parsed?.album || '';
    return [
      `网易云歌曲详情: ${songId}`,
      displayName ? `歌曲: ${displayName}` : null,
      artistText ? `歌手: ${artistText}` : null,
      album ? `专辑: ${album}` : null,
      parsed?.durationText ? `时长: ${parsed.durationText}` : null,
      parsed?.picUrl ? `封面: ${parsed.picUrl}` : null,
      audio?.source ? `音频来源: ${audio.source}` : null,
      audio?.url ? `播放URL: ${audio.url}` : '播放URL: (未获取到可用链接)',
      `链接: https://music.163.com/song/${songId}`,
      `指令: /wyy-get-music-${songId}`
    ].filter(Boolean).join('\n');
  }

  function buildPlaylistReplyText(playlistId, parsed) {
    const desc = (parsed?.description || '').replace(/\r/g, '').slice(0, 800);
    return [
      `网易云解析 (playlist): ${playlistId}`,
      parsed?.name ? `歌单: ${parsed.name}` : null,
      parsed?.creatorName ? `创建者: ${parsed.creatorName}` : null,
      parsed?.tags?.length ? `标签: ${parsed.tags.join(' / ')}` : null,
      Number.isFinite(parsed?.trackCount) ? `歌曲数: ${parsed.trackCount}` : null,
      Number.isFinite(parsed?.playCount) ? `播放: ${parsed.playCount}` : null,
      Number.isFinite(parsed?.subscribedCount) ? `收藏: ${parsed.subscribedCount}` : null,
      Number.isFinite(parsed?.commentCount) ? `评论: ${parsed.commentCount}` : null,
      Number.isFinite(parsed?.shareCount) ? `分享: ${parsed.shareCount}` : null,
      parsed?.coverImgUrl ? `封面: ${parsed.coverImgUrl}` : null,
      desc ? `简介:\n${desc}${(parsed?.description || '').length > desc.length ? '...' : ''}` : null,
      `链接: https://music.163.com/playlist?id=${playlistId}`
    ].filter(Boolean).join('\n');
  }

  function buildPlaylistTracksReplyText(playlistId, tracks, { limit = 10, offset = 0 } = {}) {
    const lines = [
      `网易云解析 (playlist): ${playlistId}`,
      `歌曲列表`,
      `limit: ${limit}`,
      `offset: ${offset}`,
      `返回数量: ${tracks.length}`
    ];

    if (!tracks.length) {
      lines.push('结果: 空');
      return lines.join('\n');
    }

    lines.push('歌曲列表:');
    for (const track of tracks) {
      const parts = [
        `${Number(offset) + track.index}. ${track.name || '(无标题)'}`,
        track.artists?.length ? `- ${track.artists.join(' / ')}` : '',
        track.album ? `- ${track.album}` : '',
        track.durationText ? `- ${track.durationText}` : '',
        track.id ? `- id:${track.id}` : ''
      ].filter(Boolean);
      lines.push(parts.join(' '));
    }

    lines.push(`指令: /wyy-get-playlist-${playlistId}-limit-${limit}-offest-${offset}`);
    lines.push(`链接: https://music.163.com/playlist?id=${playlistId}`);
    return lines.join('\n');
  }

  async function resolveShortSong(target) {
    const shortResp = await axios.get(target.url, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        Referer: 'https://music.163.com/'
      }
    });
    const location = shortResp.headers?.location || shortResp.request?.res?.headers?.location || '';
    const finalUrl = location
      ? (String(location).startsWith('http') ? String(location) : `https:${location}`)
      : target.url;
    const realSongId = extractSongId(finalUrl);
    if (!realSongId) {
      throw new Error(`163短链未解析到歌曲ID: ${finalUrl}`);
    }
    return {
      type: 'ncm_song',
      id: realSongId,
      url: target.url,
      finalUrl,
      unblock: !!target.unblock
    };
  }

  async function process(target) {
    let resolvedTarget = target;
    if (resolvedTarget.type === 'ncm_short_song') {
      resolvedTarget = await resolveShortSong(resolvedTarget);
    }

    if (resolvedTarget.type === 'ncm_event') {
      if (!resolvedTarget?.id) throw new Error('ncm_event missing id');
      const decrypted = await fetchEventDetailEapi({
        id: resolvedTarget.id,
        userId: resolvedTarget.userId,
        sourceScene: resolvedTarget.sourceScene
      });
      const replyText = buildEventReplyText(decrypted, { id: resolvedTarget.id, userId: resolvedTarget.userId });
      return { target: resolvedTarget, replyText, parsed: decrypted };
    }

    if (resolvedTarget.type === 'ncm_multi_search') {
      const searchRes = await fetchMultiSearch(resolvedTarget.keyword);
      const body = searchRes?.body;
      if (body?.code !== 200) throw new Error(body?.msg || body?.message || '网易云多类型搜索失败');
      console.log('[NCM] ncm_multi_search body keys:', Object.keys(body || {}));
      console.log('[NCM] ncm_multi_search body.result keys:', Object.keys(body?.result || {}));
      const parsed = parseMultiSearch(body?.result ? body : body?.data ? body.data : body);
      console.log('[NCM] ncm_multi_search parsed preview:');
      console.log(JSON.stringify({
        songs: parsed?.songs?.slice(0, 3),
        artists: parsed?.artists?.slice(0, 3),
        albums: parsed?.albums?.slice(0, 3),
        playlists: parsed?.playlists?.slice(0, 3)
      }, null, 2));
      const replyText = buildMultiSearchReplyText(resolvedTarget.keyword, parsed);
      console.log('[NCM] ncm_multi_search replyText:\n' + replyText);
      return { target: resolvedTarget, replyText, parsed };
    }

    if (resolvedTarget.type === 'ncm_search') {
      const searchRes = await fetchSearch({
        keyword: resolvedTarget.keyword,
        type: resolvedTarget.searchType || '1',
        limit: resolvedTarget.limit,
        offset: resolvedTarget.offset
      });
      const body = searchRes?.body;
      if (body?.code !== 200) throw new Error(body?.msg || body?.message || '网易云搜索失败');
      console.log('[NCM] ncm_search body keys:', Object.keys(body || {}));
      console.log('[NCM] ncm_search body.result keys:', Object.keys(body?.result || {}));
      const parsed = parseSearch(body?.result ? body : body?.data ? body.data : body, resolvedTarget.searchType || '1', resolvedTarget.keyword || '');
      console.log('[NCM] ncm_search parsed items preview:');
      console.log(JSON.stringify((parsed?.items || []).slice(0, 5), null, 2));
      const replyText = buildSearchReplyText({
        keyword: resolvedTarget.keyword,
        searchType: resolvedTarget.searchType || '1',
        limit: resolvedTarget.limit,
        offset: resolvedTarget.offset
      }, parsed);
      console.log('[NCM] ncm_search replyText:\n' + replyText);
      return { target: resolvedTarget, replyText, parsed };
    }

    if (resolvedTarget.type === 'ncm_song_command') {
      const detailRes = await fetchSongDetail(resolvedTarget.id);
      const parsedSong = parseSongDetail(detailRes?.body);
      const audio = await fetchSongAudio(resolvedTarget.id, { unblock: false });
      const replyText = buildSongCommandReplyText(resolvedTarget.id, parsedSong, audio);
      return { target: resolvedTarget, replyText, parsed: parsedSong, audio, link: `https://music.163.com/song/${resolvedTarget.id}` };
    }

    if (resolvedTarget.type === 'ncm_playlist_tracks') {
      const limit = Number.isFinite(Number(resolvedTarget.limit)) ? Number(resolvedTarget.limit) : 10;
      const offset = Number.isFinite(Number(resolvedTarget.offset)) ? Number(resolvedTarget.offset) : 0;
      const trackRes = await fetchPlaylistTracks(resolvedTarget.id, { limit, offset });
      const tracks = parsePlaylistTracks(trackRes?.body);
      const replyText = buildPlaylistTracksReplyText(resolvedTarget.id, tracks, { limit, offset });
      return { target: resolvedTarget, replyText, tracks };
    }

    if (resolvedTarget.type === 'ncm_playlist') {
      const detailRes = await fetchPlaylistDetail(resolvedTarget.id);
      const parsedPlaylist = parsePlaylistDetail(detailRes?.body);
      let replyText = buildPlaylistReplyText(resolvedTarget.id, parsedPlaylist);
      const link = resolvedTarget.url || `https://music.163.com/playlist?id=${resolvedTarget.id}`;
      replyText = replyText.replace(`链接: https://music.163.com/playlist?id=${resolvedTarget.id}`, `链接: ${link}`);
      return { target: resolvedTarget, replyText, parsed: parsedPlaylist, link };
    }

    if (resolvedTarget.type === 'ncm_song') {
      const detailRes = await fetchSongDetail(resolvedTarget.id);
      const parsedSong = parseSongDetail(detailRes?.body);
      const audio = await fetchSongAudio(resolvedTarget.id, { unblock: !!resolvedTarget.unblock });
      let replyText = buildSongReplyText(resolvedTarget.id, parsedSong, audio);
      const link = resolvedTarget.url || `https://music.163.com/song/${resolvedTarget.id}`;
      replyText = replyText.replace(`链接: https://music.163.com/song/${resolvedTarget.id}`, `链接: ${link}`);
      return { target: resolvedTarget, replyText, parsed: parsedSong, audio, link };
    }

    throw new Error(`unsupported ncm target type: ${resolvedTarget?.type || 'unknown'}`);
  }

  return {
    name: 'ncm',
    detect,
    process,
    handlePushMessage: async (msg) => {
      try {
        // contentType=11: 音频（根据云湖 push_message 样例）
        if (msg?.contentType === 11 || msg?.content?.audioUrl) {
          return await handleAudioPushMessage(msg);
        }
      } catch (e) {
        console.log('[NCM] audio_match failed:', e?.message || e);
      }
      return null;
    },
    helpers: {
      extractSongId,
      extractPlaylistId,
      normalizeSearchType,
      searchTypeLabel,
      parseSearchCommand,
      fetchSongDetail,
      fetchPlaylistDetail,
      fetchPlaylistTracks,
      fetchMultiSearch,
      fetchCloudSearch,
      fetchSearch,
      fetchSongAudio,
      parseSongDetail,
      parsePlaylistDetail,
      parsePlaylistTracks,
      parseMultiSearch,
      parseSearch,
      rankByKeyword,
      rankSongSearchItems,
      buildSongReplyText,
      buildSongCommandReplyText,
      buildPlaylistReplyText,
      buildPlaylistTracksReplyText,
      buildMultiSearchReplyText,
      buildSearchReplyText
    }
  };
}

module.exports = { buildNcmPlugin };

