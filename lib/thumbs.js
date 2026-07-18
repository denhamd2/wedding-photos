'use strict';

const { parseKey, thumbKeyFor } = require('./keys');

const THUMB_WIDTH = 640;

// Generate a gallery thumbnail for an uploaded photo. Videos and formats sharp
// can't decode (e.g. HEIC without libheif) are skipped — the gallery falls back
// to a placeholder card for those.
async function generateThumb(storage, photoKey) {
  const parsed = parseKey(photoKey);
  if (!parsed || parsed.isVideo) return { thumbed: false, reason: 'not-an-image' };

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return { thumbed: false, reason: 'sharp-unavailable' };
  }

  try {
    const { body } = await storage.getObject(photoKey);
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const input = Buffer.concat(chunks);

    const webp = await sharp(input, { failOn: 'truncated' })
      .rotate() // respect EXIF orientation
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();

    await storage.putObject(thumbKeyFor(photoKey), webp, 'image/webp');
    return { thumbed: true };
  } catch (err) {
    return { thumbed: false, reason: err.message };
  }
}

module.exports = { generateThumb, THUMB_WIDTH };
