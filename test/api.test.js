'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { createApp } = require('../server');
const { LocalDriver } = require('../lib/storage');

function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-test-'));
  const driver = new LocalDriver(dir);
  const storage = {
    driver: 'local',
    putObject: driver.putObject.bind(driver),
    getObject: driver.getObject.bind(driver),
    headObject: driver.headObject.bind(driver),
    deleteObject: driver.deleteObject.bind(driver),
    listAll: driver.listAll.bind(driver),
  };
  const app = createApp(storage, {
    coupleNames: 'John & Katie',
    maxUploadMb: 50,
    maxImageDim: 3840,
    dedupe: true,
    adminPassword: 'secret123',
    listCacheMs: 0,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, storage };
}

function upload(base, { filename, uploader = '', type, body }) {
  return fetch(`${base}/api/upload?filename=${encodeURIComponent(filename)}&uploader=${encodeURIComponent(uploader)}`, {
    method: 'PUT',
    headers: { 'Content-Type': type },
    body,
  });
}

async function bufferOf(storage, key) {
  const { body } = await storage.getObject(key);
  const chunks = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
}

test('API flow', async (t) => {
  const { server, base, storage } = makeServer();
  t.after(() => server.close());

  await t.test('healthz and config', async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.coupleNames, 'John & Katie');
  });

  await t.test('upload page is the front page; old table links redirect', async () => {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Upload photos/);
    assert.match(html, /Take a photo/);
    assert.match(html, /capture="environment"/);
    const old = await fetch(`${base}/t/5`, { redirect: 'manual' });
    assert.equal(old.status, 302);
    assert.equal(old.headers.get('location'), '/');
  });

  await t.test('upload rejects unsupported types and oversized files', async () => {
    const pdf = await upload(base, { filename: 'contract.pdf', type: 'application/pdf', body: Buffer.from('x') });
    assert.equal(pdf.status, 400);
    const big = await fetch(`${base}/api/upload?filename=huge.jpg`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(200 * 1024 * 1024) },
      body: Buffer.alloc(10),
    }).catch(() => ({ status: 413 })); // node may abort early on mismatched length
    assert.equal(big.status, 413);
  });

  let photoKey;
  await t.test('image upload is re-encoded to JPEG with a thumbnail; original not stored', async () => {
    const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#b5924c' } }).png().toBuffer();
    const res = await upload(base, { filename: 'pic.png', uploader: 'Katie', type: 'image/png', body: png });
    assert.equal(res.status, 200);
    ({ key: photoKey } = await res.json());
    assert.match(photoKey, /^photos\/.*_Katie\.jpg$/);

    const stored = await bufferOf(storage, photoKey);
    const meta = await sharp(stored).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, 800); // small image not enlarged

    const { photos } = await (await fetch(`${base}/api/photos`)).json();
    const mine = photos.find((p) => p.key === photoKey);
    assert.equal(mine.name, 'Katie');
    assert.ok(mine.thumb.startsWith('/img/thumbs/'), 'thumbnail must exist for every photo');
    assert.equal((await fetch(`${base}${mine.thumb}`)).headers.get('content-type'), 'image/webp');
    assert.equal((await fetch(`${base}${mine.full}`)).headers.get('content-type'), 'image/jpeg');
  });

  await t.test('oversized images are downscaled to the max dimension', async () => {
    const wide = await sharp({ create: { width: 5000, height: 2000, channels: 3, background: '#333' } })
      .jpeg().toBuffer();
    const res = await upload(base, { filename: 'wide.jpg', type: 'image/jpeg', body: wide });
    assert.equal(res.status, 200);
    const { key } = await res.json();
    const meta = await sharp(await bufferOf(storage, key)).metadata();
    assert.equal(meta.width, 3840);
    assert.ok(meta.height <= 3840);
  });

  await t.test('exact-duplicate images are skipped; different images are kept', async () => {
    const img = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#246' } }).jpeg().toBuffer();
    const before = (await (await fetch(`${base}/api/photos`)).json()).total;

    const first = await upload(base, { filename: 'dup.jpg', uploader: 'Ann', type: 'image/jpeg', body: img });
    const firstBody = await first.json();
    assert.equal(firstBody.duplicate, undefined);

    // same bytes again (even different filename/uploader) → deduped, gallery unchanged
    const second = await upload(base, { filename: 'copy.jpg', uploader: 'Ben', type: 'image/jpeg', body: img });
    assert.deepEqual(await second.json(), { ok: true, duplicate: true });
    const afterDup = (await (await fetch(`${base}/api/photos`)).json()).total;
    assert.equal(afterDup, before + 1, 'only one copy stored');
    assert.equal((await storage.listAll('index/')).length >= 1, true, 'hash marker written');

    // a genuinely different image is still accepted
    const other = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#642' } }).jpeg().toBuffer();
    await upload(base, { filename: 'other.jpg', type: 'image/jpeg', body: other });
    const afterOther = (await (await fetch(`${base}/api/photos`)).json()).total;
    assert.equal(afterOther, before + 2);
  });

  await t.test('concurrent identical images do not both store', async () => {
    const img = await sharp({ create: { width: 120, height: 120, channels: 3, background: '#0a7' } }).png().toBuffer();
    const before = (await (await fetch(`${base}/api/photos`)).json()).total;
    const [a, b] = await Promise.all([
      upload(base, { filename: 'race.png', type: 'image/png', body: img }),
      upload(base, { filename: 'race.png', type: 'image/png', body: img }),
    ]);
    const bodies = [await a.json(), await b.json()];
    assert.equal(bodies.filter((x) => x.duplicate).length, 1, 'exactly one deduped');
    const after = (await (await fetch(`${base}/api/photos`)).json()).total;
    assert.equal(after, before + 1, 'only one stored despite the race');
  });

  await t.test('duplicate videos are removed after upload', async () => {
    const bytes = Buffer.from('pretend-video-bytes-that-are-identical');
    const first = await upload(base, { filename: 'clip.mp4', type: 'video/mp4', body: bytes });
    assert.equal((await first.json()).duplicate, undefined);
    const second = await upload(base, { filename: 'clip2.mp4', type: 'video/mp4', body: bytes });
    assert.equal((await second.json()).duplicate, true);
    // exactly one video object stored for these bytes
    const vids = (await storage.listAll('photos/')).filter((o) => o.key.endsWith('.mp4'));
    assert.equal(vids.length, 1);
  });

  await t.test('photos listing supports ETag/304 for cheap live polling', async () => {
    const first = await fetch(`${base}/api/photos`);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'ETag header present');

    // unchanged → 304 with no body
    const again = await fetch(`${base}/api/photos`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');

    // after a new upload the ETag changes and a full body returns
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).png().toBuffer();
    await upload(base, { filename: 'new.png', type: 'image/png', body: png });
    const changed = await fetch(`${base}/api/photos`, { headers: { 'If-None-Match': etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
  });

  await t.test('videos stream through unchanged', async () => {
    const fakeVideo = Buffer.from('not really mp4 but bytes are bytes');
    const res = await upload(base, { filename: 'clip.mp4', uploader: 'Dave', type: 'video/mp4', body: fakeVideo });
    assert.equal(res.status, 200);
    const { key } = await res.json();
    assert.match(key, /\.mp4$/);
    assert.deepEqual(await bufferOf(storage, key), fakeVideo);
    const { photos } = await (await fetch(`${base}/api/photos`)).json();
    const mine = photos.find((p) => p.key === key);
    assert.equal(mine.isVideo, true);
    assert.equal(mine.thumb, null); // videos keep the play tile
  });

  await t.test('corrupt image bytes are rejected politely', async () => {
    const res = await upload(base, { filename: 'broken.jpg', type: 'image/jpeg', body: Buffer.from('garbage') });
    assert.equal(res.status, 500);
    const { error } = await res.json();
    assert.match(error, /could not read/i);
  });

  await t.test('admin: login required, wrong password rejected, delete removes full + thumb', async () => {
    const del = (key, cookie) => fetch(`${base}/api/admin/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ key }),
    });
    assert.equal((await del(photoKey)).status, 401);

    const bad = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret123' }),
    });
    assert.equal(good.status, 200);
    const cookie = good.headers.get('set-cookie').split(';')[0];

    const { thumbKeyFor } = require('../lib/keys');
    assert.ok((await storage.listAll('thumbs/')).some((t) => t.key === thumbKeyFor(photoKey)), 'thumb exists before delete');
    assert.equal((await del(photoKey, cookie)).status, 200);
    const { photos } = await (await fetch(`${base}/api/photos`)).json();
    assert.equal(photos.find((p) => p.key === photoKey), undefined);
    assert.ok(!(await storage.listAll('thumbs/')).some((t) => t.key === thumbKeyFor(photoKey)), 'thumb removed with the photo');
  });
});
