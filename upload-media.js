const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Token endpoints
const YUNHU_BASE_URL = 'https://chat-go.jwzhd.com';
const QINIU_QUERY_URL = 'https://api.qiniu.com/v4/query';

// Buckets
const BUCKET_IMAGE = 'chat68';
const BUCKET_FILE = 'chat68-file';
const BUCKET_VIDEO = 'chat68-video';
const BUCKET_AUDIO = 'chat68-audio';

const DEFAULT_UPLOAD_HOST = {
  image: 'upload-z2.qiniup.com',
  file: 'upload-z2.qiniup.com',
  video: 'upload-cn-east-2.qiniup.com',
  audio: 'upload-z2.qiniup.com'
};

function md5Hex(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function guessExtFromFileName(fileName) {
  const ext = path.extname(fileName || '').replace('.', '').trim();
  return ext || 'dat';
}

function guessMimeFromExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'webp') return 'image/webp';
  if (e === 'png') return 'image/png';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'gif') return 'image/gif';
  if (e === 'bmp') return 'image/bmp';
  if (e === 'mp4') return 'video/mp4';
  if (e === 'mov') return 'video/quicktime';
  if (e === 'm4a') return 'audio/mp4';
  if (e === 'mp3') return 'audio/mpeg';
  if (e === 'wav') return 'audio/wav';
  if (e === 'flac') return 'audio/flac';
  return 'application/octet-stream';
}

async function getJson(url, { headers = {}, params = {}, timeout = 20000 } = {}) {
  const resp = await axios.get(url, {
    headers,
    params,
    timeout
  });
  return resp.data;
}

async function getQiniuToken(endpointPath) {
  const token = config?.ws?.token;
  if (!token) throw new Error('config.ws.token 未配置');

  const url = `${YUNHU_BASE_URL}/${endpointPath.replace(/^\/+/, '')}`;
  const data = await getJson(url, {
    headers: {
      token
    }
  });

  // 兼容：部分接口 code=1 或 code=0
  const code = data?.code;
  const t = data?.data?.token;
  if (!t) {
    throw new Error(`获取七牛token失败: code=${code} msg=${data?.msg || data?.message || ''}`);
  }
  return String(t);
}

async function queryUploadHost({ uploadToken, bucket, fallbackHost }) {
  const ak = String(uploadToken).split(':')[0];
  if (!ak) return fallbackHost;

  try {
    const queryUrl = `${QINIU_QUERY_URL}`;
    const query = await getJson(queryUrl, {
      params: {
        ak,
        bucket
      },
      timeout: 20000
    });

    const host = query?.hosts?.[0]?.up?.domains?.[0];
    return host ? String(host) : fallbackHost;
  } catch (e) {
    return fallbackHost;
  }
}

async function createMultipart({ fields, fileFieldName, fileBuffer, filename, contentType }) {
  // 优先用 Node 18+ 的 FormData（undici），否则尝试 form-data 包
  if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined') {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields || {})) {
      form.append(k, String(v));
    }
    const blob = new Blob([fileBuffer], { type: contentType || 'application/octet-stream' });
    form.append(fileFieldName, blob, filename);
    return { kind: 'undici', form };
  }

  // eslint-disable-next-line global-require
  const FormDataPkg = require('form-data');
  const form = new FormDataPkg();
  for (const [k, v] of Object.entries(fields || {})) {
    form.append(k, String(v));
  }
  form.append(fileFieldName, fileBuffer, { filename, contentType });
  return { kind: 'form-data', form };
}

async function uploadToQiniu({ bucket, uploadToken, key, fileBuffer, filename, mimeType, kind }) {
  const uploadHost = await queryUploadHost({
    uploadToken,
    bucket,
    fallbackHost: DEFAULT_UPLOAD_HOST[kind] || 'upload-z2.qiniup.com'
  });

  const uploadUrl = `https://${uploadHost}/`;

  const { kind: fdKind, form } = await createMultipart({
    fields: {
      token: uploadToken,
      key
    },
    fileFieldName: 'file',
    fileBuffer,
    filename,
    contentType: mimeType
  });

  const headers = {
    'user-agent': 'QiniuDart',
    'accept-encoding': 'gzip'
  };

  // form-data 包需要补 headers
  if (fdKind === 'form-data') {
    Object.assign(headers, form.getHeaders());
  }

  const resp = await axios.post(uploadUrl, form, {
    headers,
    timeout: kind === 'video' ? 180000 : 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  return resp.data;
}

async function maybeCompressToWebp(buffer, { enabled, quality }) {
  if (!enabled) return { buffer, ext: null, mime: null };

  // 可选依赖：sharp
  let sharp;
  try {
    // eslint-disable-next-line global-require
    sharp = require('sharp');
  } catch (e) {
    return { buffer, ext: null, mime: null, warn: 'sharp 未安装，无法webp压缩，已退回原图' };
  }

  const q = Number.isFinite(Number(quality)) ? Number(quality) : 95;
  const out = await sharp(buffer).webp({ quality: q }).toBuffer();
  return { buffer: out, ext: 'webp', mime: 'image/webp' };
}

// ==================== Token APIs ====================
async function getQiniuImageToken() {
  return getQiniuToken('v1/misc/qiniu-token');
}

async function getQiniuFileToken() {
  return getQiniuToken('v1/misc/qiniu-token2');
}

async function getQiniuVideoToken() {
  return getQiniuToken('v1/misc/qiniu-token-video');
}

async function getQiniuAudioToken() {
  return getQiniuToken('v1/misc/qiniu-token-audio');
}

// ==================== Upload APIs ====================
async function uploadImageFromPath(imagePath, { originalName } = {}) {
  const input = fs.readFileSync(imagePath);
  const md5 = md5Hex(input);

  const uploadToken = await getQiniuImageToken();

  // config 开关：upload.image.webp
  const webpCfg = config?.upload?.image?.webp || {};
  const useWebp = !!webpCfg.enabled;
  const quality = webpCfg.quality ?? 95;

  const compressed = await maybeCompressToWebp(input, { enabled: useWebp, quality });

  const ext = compressed.ext || guessExtFromFileName(originalName || imagePath);
  const mimeType = compressed.mime || guessMimeFromExt(ext);
  const key = `${md5}.${ext}`;

  const resp = await uploadToQiniu({
    bucket: BUCKET_IMAGE,
    uploadToken,
    key,
    fileBuffer: compressed.buffer,
    filename: `${md5}.${ext}`,
    mimeType,
    kind: 'image'
  });

  return { key, md5, bucket: BUCKET_IMAGE, resp, warn: compressed.warn || '' };
}

async function uploadFileFromPath(filePath, { originalName } = {}) {
  const input = fs.readFileSync(filePath);
  const md5 = md5Hex(input);

  const uploadToken = await getQiniuFileToken();

  const ext = guessExtFromFileName(originalName || filePath);
  const mimeType = guessMimeFromExt(ext);

  // Kotlin: disk/MD5.ext
  const key = `disk/${md5}.${ext}`;

  const resp = await uploadToQiniu({
    bucket: BUCKET_FILE,
    uploadToken,
    key,
    fileBuffer: input,
    filename: originalName || path.basename(filePath),
    mimeType,
    kind: 'file'
  });

  return { key, md5, bucket: BUCKET_FILE, resp };
}

async function uploadVideoFromPath(videoPath, { originalName } = {}) {
  const input = fs.readFileSync(videoPath);
  const md5 = md5Hex(input);

  const uploadToken = await getQiniuVideoToken();

  const ext = guessExtFromFileName(originalName || videoPath);
  const mimeType = guessMimeFromExt(ext);

  const key = `${md5}.${ext}`;

  const resp = await uploadToQiniu({
    bucket: BUCKET_VIDEO,
    uploadToken,
    key,
    fileBuffer: input,
    filename: originalName || path.basename(videoPath),
    mimeType,
    kind: 'video'
  });

  return { key, md5, bucket: BUCKET_VIDEO, resp };
}

async function uploadAudioFromPath(audioPath, { originalName } = {}) {
  const input = fs.readFileSync(audioPath);
  const md5 = md5Hex(input);

  const uploadToken = await getQiniuAudioToken();

  const ext = guessExtFromFileName(originalName || audioPath);
  const mimeType = guessMimeFromExt(ext);

  const key = `${md5}.${ext}`;

  const resp = await uploadToQiniu({
    bucket: BUCKET_AUDIO,
    uploadToken,
    key,
    fileBuffer: input,
    filename: originalName || path.basename(audioPath),
    mimeType,
    kind: 'audio'
  });

  return { key, md5, bucket: BUCKET_AUDIO, resp };
}

module.exports = {
  // token
  getQiniuImageToken,
  getQiniuFileToken,
  getQiniuVideoToken,
  getQiniuAudioToken,

  // upload
  uploadImageFromPath,
  uploadFileFromPath,
  uploadVideoFromPath,
  uploadAudioFromPath,

  // low level
  queryUploadHost,
  uploadToQiniu
};
