'use strict';

// Turns an uploaded image into what we actually store: a size-capped JPEG
// plus a gallery thumbnail. Originals are never persisted — this is the whole
// space-saving strategy. HEIC/HEIF (iPhone originals) are decoded via
// heic-convert since prebuilt sharp has no HEIF codec.

const THUMB_WIDTH = 640;

async function processImage(input, ext, maxDim) {
  const sharp = require('sharp');

  let buffer = input;
  if (ext === 'heic' || ext === 'heif') {
    const heicConvert = require('heic-convert');
    buffer = Buffer.from(await heicConvert({ buffer: input, format: 'JPEG', quality: 0.9 }));
  }

  const base = sharp(buffer, { failOn: 'truncated' }).rotate(); // respect EXIF orientation

  const full = await base
    .clone()
    .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  const thumb = await sharp(full)
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();

  return { full, thumb };
}

module.exports = { processImage, THUMB_WIDTH };
