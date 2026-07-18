'use strict';

const crypto = require('crypto');

// Object keys are the database. Everything the gallery needs is encoded in the key:
//   photos/20260912T183000123_a1b2c3d4_Auntie-Sue.jpg
//   thumbs/20260912T183000123_a1b2c3d4_Auntie-Sue.webp
const KEY_RE = /^photos\/(\d{8}T\d{9})_([a-f0-9]{8})(?:_([A-Za-z0-9-]{1,20}))?\.([a-z0-9]{2,5})$/;

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'm4v', '3gp', 'avi', 'mkv', 'mpg', 'mpeg']);

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/3gpp': '3gp',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'video/mpeg': 'mpg',
};

function extFor(mimeType, filename) {
  const fromMime = MIME_TO_EXT[(mimeType || '').toLowerCase().split(';')[0]];
  if (fromMime) return fromMime;
  const fromName = (filename || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  if (fromName && (IMAGE_EXTS.has(fromName[1]) || VIDEO_EXTS.has(fromName[1]))) return fromName[1];
  return null;
}

// Spaces become hyphens inside object keys; the UI renders them back as spaces.
function sanitizeName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
}

function makeKey(ext, uploaderName, now = new Date()) {
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').padEnd(17, '0').slice(0, 17);
  const stamp = `${ts.slice(0, 8)}T${ts.slice(8)}`;
  const id = crypto.randomBytes(4).toString('hex');
  const name = sanitizeName(uploaderName);
  const suffix = name ? `_${name}` : '';
  return `photos/${stamp}_${id}${suffix}.${ext}`;
}

function parseKey(key) {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return {
    key,
    ts: m[1],
    id: m[2],
    name: m[3] || null,
    ext: m[4],
    isVideo: VIDEO_EXTS.has(m[4]),
  };
}

function thumbKeyFor(photoKey) {
  return photoKey.replace(/^photos\//, 'thumbs/').replace(/\.[a-z0-9]{2,5}$/, '.webp');
}

// Where a transcoded video lands: same stamp/id/name, extension forced to mp4.
function videoOutputKey(photoKey) {
  return photoKey.replace(/\.[a-z0-9]{2,5}$/, '.mp4');
}

module.exports = { makeKey, parseKey, thumbKeyFor, videoOutputKey, extFor, sanitizeName, IMAGE_EXTS, VIDEO_EXTS };
