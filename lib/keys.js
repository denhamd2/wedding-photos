'use strict';

const crypto = require('crypto');

// Object keys are the database. Everything the gallery needs is encoded in the key:
//   photos/table-05/20260912T183000123_a1b2c3d4_Dave.jpg
//   thumbs/table-05/20260912T183000123_a1b2c3d4_Dave.webp
const KEY_RE = /^photos\/table-(\d{2})\/(\d{8}T\d{9})_([a-f0-9]{8})(?:_([A-Za-z0-9-]{1,20}))?\.([a-z0-9]{2,5})$/;

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'm4v', '3gp']);

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

function makeKey(table, ext, uploaderName, now = new Date()) {
  const ts = now.toISOString().replace(/[-:.TZ]/g, '').padEnd(17, '0').slice(0, 17);
  const stamp = `${ts.slice(0, 8)}T${ts.slice(8)}`;
  const id = crypto.randomBytes(4).toString('hex');
  const name = sanitizeName(uploaderName);
  const suffix = name ? `_${name}` : '';
  return `photos/table-${String(table).padStart(2, '0')}/${stamp}_${id}${suffix}.${ext}`;
}

function parseKey(key) {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return {
    key,
    table: parseInt(m[1], 10),
    ts: m[2],
    id: m[3],
    name: m[4] || null,
    ext: m[5],
    isVideo: VIDEO_EXTS.has(m[5]),
  };
}

function thumbKeyFor(photoKey) {
  return photoKey.replace(/^photos\//, 'thumbs/').replace(/\.[a-z0-9]{2,5}$/, '.webp');
}

module.exports = { makeKey, parseKey, thumbKeyFor, extFor, sanitizeName, IMAGE_EXTS, VIDEO_EXTS };
