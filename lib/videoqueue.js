'use strict';

const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { parseKey, thumbKeyFor, videoOutputKey } = require('./keys');
const { transcodeToMp4, extractPosterJpeg, ffmpegAvailable } = require('./video');

// Background transcode queue. Concurrency 1 so a dinner-time burst of uploads
// never starves the box — videos convert one at a time while nobody's watching.
// State is in-memory; the reconciler re-derives pending work from the bucket on
// boot, so a restart mid-transcode just re-processes (originals are never lost).
function createVideoQueue({ storage, onListingChange = () => {}, maxHeight = 1080, crf = 26 }) {
  const pending = [];
  const seen = new Set();   // keys queued or processing (dedupe)
  const failed = new Set(); // keys that errored this process (don't hammer)
  let running = false;
  let available = null;     // cached ffmpeg availability

  async function enqueue(key) {
    if (seen.has(key) || failed.has(key)) return;
    if (available === null) available = await ffmpegAvailable();
    if (!available) { // no ffmpeg: leave the original as-is, playable where supported
      console.warn('ffmpeg unavailable — skipping transcode for', key);
      return;
    }
    seen.add(key);
    pending.push(key);
    if (!running) drain();
  }

  async function drain() {
    running = true;
    while (pending.length) {
      const key = pending.shift();
      try {
        await processOne(key);
      } catch (err) {
        console.error('transcode failed for', key, '-', err.message);
        failed.add(key); // keep the original; don't retry this run
      } finally {
        seen.delete(key);
      }
    }
    running = false;
  }

  async function processOne(key) {
    const parsed = parseKey(key);
    if (!parsed || !parsed.isVideo) return;

    const tmp = path.join(os.tmpdir(), `wed-${crypto.randomBytes(6).toString('hex')}`);
    const inPath = `${tmp}.in`;
    const outPath = `${tmp}.mp4`;
    try {
      // 1. pull the original down to a temp file (never buffered in memory)
      const { body } = await storage.getObject(key);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(inPath);
        body.pipe(ws);
        body.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
      });

      // 2 + 3. transcode + poster frame
      await transcodeToMp4(inPath, outPath, { maxHeight, crf });
      const posterJpeg = await extractPosterJpeg(inPath);

      // 4. upload the mp4 and a webp poster thumbnail
      const outKey = videoOutputKey(key);
      const mp4Size = fs.statSync(outPath).size;
      await storage.putObject(outKey, fs.createReadStream(outPath), 'video/mp4', mp4Size);

      if (posterJpeg && posterJpeg.length) {
        const sharp = require('sharp');
        const webp = await sharp(posterJpeg).resize({ width: 640, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
        await storage.putObject(thumbKeyFor(outKey), webp, 'image/webp');
      }

      // 5. drop the original if the transcode produced a different object
      if (outKey !== key) await storage.deleteObject(key).catch(() => {});
      onListingChange();
      console.log(`transcoded ${key} → ${outKey} (${Math.round(mp4Size / 1024)} KB)`);
    } finally {
      await fsp.rm(inPath, { force: true }).catch(() => {});
      await fsp.rm(outPath, { force: true }).catch(() => {});
    }
  }

  // On boot, find videos still needing work: non-mp4 originals, or any video
  // missing its poster thumbnail (e.g. a restart interrupted transcoding).
  async function reconcile() {
    try {
      const [originals, thumbs] = await Promise.all([storage.listAll('photos/'), storage.listAll('thumbs/')]);
      for (const key of videosNeedingWork(originals, thumbs)) enqueue(key);
    } catch (err) {
      console.error('video reconcile failed:', err.message);
    }
  }

  return { enqueue, reconcile, _state: { pending, seen, failed } };
}

// Pure helper: given bucket listings, which video keys still need transcoding?
// A video needs work if it isn't yet an mp4, or it has no poster thumbnail.
function videosNeedingWork(originals, thumbs) {
  const thumbKeys = new Set(thumbs.map((t) => t.key));
  return originals
    .map((o) => parseKey(o.key))
    .filter((p) => p && p.isVideo && (p.ext !== 'mp4' || !thumbKeys.has(thumbKeyFor(p.key))))
    .map((p) => p.key);
}

module.exports = { createVideoQueue, videosNeedingWork };
