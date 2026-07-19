'use strict';

const crypto = require('crypto');
const { parseKey, thumbKeyFor } = require('./keys');

// One-time reconcile for photos uploaded before dedup was live: fingerprint
// every stored image (by the bytes we actually keep) so future re-uploads are
// caught, and delete any byte-identical extras already in the gallery (keeping
// the earliest). Gated by an `index/.backfilled` sentinel so it runs once and
// is safe to re-run if it never finished. Videos are skipped — their stored
// bytes change after transcode, and the upload path already fingerprints them.

const SENTINEL = 'index/.backfilled';
const indexKeyFor = (hash) => `index/${hash}`;
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif|heic|heif|avif)$/i;

async function readAll(storage, key) {
  const { body } = await storage.getObject(key);
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function exists(storage, key) {
  try { await storage.headObject(key); return true; } catch { return false; }
}

async function backfillDedupe({ storage, onChange = () => {} }) {
  if (await exists(storage, SENTINEL)) return { skipped: true };

  const images = (await storage.listAll('photos/'))
    .filter((o) => parseKey(o.key) && IMAGE_EXT_RE.test(o.key))
    .sort((a, b) => (a.key < b.key ? -1 : 1)); // oldest first — earliest copy wins

  let registered = 0;
  let removed = 0;
  for (const o of images) {
    let hash;
    try {
      hash = crypto.createHash('sha256').update(await readAll(storage, o.key)).digest('hex');
    } catch (err) {
      console.error('backfill: could not read', o.key, '-', err.message);
      continue;
    }
    if (await exists(storage, indexKeyFor(hash))) {
      // an earlier photo with identical bytes is already kept — drop this copy
      await storage.deleteObject(o.key).catch(() => {});
      await storage.deleteObject(thumbKeyFor(o.key)).catch(() => {});
      removed += 1;
      onChange();
      console.log('backfill: removed exact duplicate', o.key);
    } else {
      await storage.putObject(indexKeyFor(hash), Buffer.from(o.key), 'text/plain');
      registered += 1;
    }
  }

  await storage.putObject(SENTINEL, Buffer.from(new Date().toISOString()), 'text/plain');
  console.log(`backfill: done — ${registered} fingerprinted, ${removed} duplicate(s) removed`);
  return { registered, removed };
}

module.exports = { backfillDedupe, SENTINEL };
