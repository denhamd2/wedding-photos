'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { videoOutputKey, thumbKeyFor, makeKey, parseKey } = require('../lib/keys');
const { createApp } = require('../server');
const { LocalDriver } = require('../lib/storage');
const { createVideoQueue, videosNeedingWork } = require('../lib/videoqueue');
const { ffmpegAvailable } = require('../lib/video');

function driverStorage(dir) {
  const d = new LocalDriver(dir);
  return {
    driver: 'local',
    putObject: d.putObject.bind(d),
    getObject: d.getObject.bind(d),
    headObject: d.headObject.bind(d),
    deleteObject: d.deleteObject.bind(d),
    listAll: d.listAll.bind(d),
  };
}

test('videoOutputKey forces the mp4 extension, keeping stamp/id/name', () => {
  assert.equal(videoOutputKey('photos/20260912T183000123_deadbeef_Dave.mov'),
    'photos/20260912T183000123_deadbeef_Dave.mp4');
  assert.equal(videoOutputKey('photos/20260912T183000123_deadbeef.mp4'),
    'photos/20260912T183000123_deadbeef.mp4');
  // the thumb of a transcoded video is a normal webp sibling
  assert.equal(thumbKeyFor(videoOutputKey('photos/20260912T183000123_deadbeef.mov')),
    'thumbs/20260912T183000123_deadbeef.webp');
});

test('range serving returns 206 with the requested bytes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wed-range-'));
  const storage = driverStorage(dir);
  const app = createApp(storage, { coupleNames: 'X', maxUploadMb: 5, adminPassword: 'p', listCacheMs: 0 });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const body = Buffer.from('0123456789abcdefghij'); // 20 bytes
  const key = 'photos/20260912T183000123_deadbeef.mp4';
  await storage.putObject(key, body, 'video/mp4');

  const res = await fetch(`${base}/img/${key}`, { headers: { Range: 'bytes=5-9' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 5-9/20');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(await res.text(), '56789');

  const whole = await fetch(`${base}/img/${key}`);
  assert.equal(whole.status, 200);
  assert.equal(await whole.text(), '0123456789abcdefghij');
});

// Full pipeline against real ffmpeg. Skips cleanly where ffmpeg isn't installed.
test('video queue transcodes to mp4 + poster and removes the original', async (t) => {
  if (!(await ffmpegAvailable())) {
    t.skip('ffmpeg not available in this environment');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wed-vq-'));
  const storage = driverStorage(dir);

  // synthesize a 1-second test clip as .mov input
  const src = path.join(dir, 'src.mov');
  const gen = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-c:a', 'aac', '-t', '1', src,
  ]);
  assert.equal(gen.status, 0, 'test clip generated');

  const key = makeKey('mov', 'Dave');
  await storage.putObject(key, fs.readFileSync(src), 'video/quicktime');

  let listingChanged = false;
  const q = createVideoQueue({ storage, onListingChange: () => { listingChanged = true; }, maxHeight: 720, crf: 30 });
  await q.enqueue(key);
  // let the queue drain
  const outKey = videoOutputKey(key);
  for (let i = 0; i < 60 && !(await storage.listAll('')).some((o) => o.key === outKey); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const keys = (await storage.listAll('')).map((o) => o.key);
  assert.ok(keys.includes(outKey), 'mp4 exists');
  assert.ok(keys.includes(thumbKeyFor(outKey)), 'poster thumbnail exists');
  assert.ok(!keys.includes(key), 'original .mov removed');
  assert.ok(listingChanged, 'listing invalidated');

  // the stored mp4 really is H.264
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name',
    '-of', 'default=nk=1:nw=1', path.join(dir, outKey),
  ]);
  assert.equal(probe.stdout.toString().trim(), 'h264');
});

test('videosNeedingWork: non-mp4 or poster-less videos need work; finished mp4s and photos do not', () => {
  const movKey = 'photos/20260912T183000001_aaaaaaaa.mov';        // needs transcode
  const mp4NoThumb = 'photos/20260912T183000002_bbbbbbbb.mp4';    // interrupted → needs poster
  const mp4Done = 'photos/20260912T183000003_cccccccc.mp4';      // finished
  const photo = 'photos/20260912T183000004_dddddddd.jpg';        // not a video

  const originals = [movKey, mp4NoThumb, mp4Done, photo].map((key) => ({ key }));
  const thumbs = [thumbKeyFor(mp4Done), thumbKeyFor(photo)].map((key) => ({ key }));

  const needing = videosNeedingWork(originals, thumbs);
  assert.deepEqual(needing.sort(), [movKey, mp4NoThumb].sort());
});
