'use strict';

// Video processing with ffmpeg. Phones (especially iPhones) record HEVC/H.265
// in .mov, which most browsers can't play — so every uploaded video is
// transcoded to broadly-compatible 1080p H.264 MP4, and a poster frame is
// grabbed for the gallery tile.

const { spawn } = require('child_process');
const fs = require('fs');

// Resolve the ffmpeg/ffprobe binaries: explicit env override, else PATH.
// The Docker image installs ffmpeg via apt (see Dockerfile); dev/CI use PATH.
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function run(bin, args, { wantStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', wantStdout ? 'pipe' : 'ignore', 'pipe'] });
    const out = [];
    const err = [];
    if (wantStdout) child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject); // e.g. binary not found
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${bin} exited ${code}: ${Buffer.concat(err).toString().slice(-400)}`));
    });
  });
}

// True if ffmpeg is actually runnable in this environment.
async function ffmpegAvailable() {
  try {
    await run(FFMPEG, ['-hide_banner', '-version'], { wantStdout: true });
    return true;
  } catch {
    return false;
  }
}

// Transcode to H.264 MP4, downscaling to at most `maxHeight` (never upscaling),
// web-optimised (faststart) so playback can begin before the whole file loads.
async function transcodeToMp4(inputPath, outputPath, { maxHeight = 1080, crf = 26 } = {}) {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-vf', `scale=-2:'min(${maxHeight},ih)':flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath,
  ]);
  return outputPath;
}

// Grab a single frame ~1s in (or the first frame for very short clips) as JPEG bytes.
async function extractPosterJpeg(inputPath) {
  return run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', '1', '-i', inputPath,
    '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1',
  ], { wantStdout: true }).then((buf) => {
    if (buf.length) return buf;
    // clip shorter than 1s: retry from the very start
    return run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath, '-frames:v', '1', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1',
    ], { wantStdout: true });
  });
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

module.exports = { ffmpegAvailable, transcodeToMp4, extractPosterJpeg, fileSize, FFMPEG, FFPROBE };
