'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../server');
const { LocalDriver } = require('../lib/storage');

// 1x1 red pixel PNG — enough for sharp to make a real thumbnail from.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
    presignPut: driver.presignPut.bind(driver),
  };
  const app = createApp(storage, {
    coupleNames: 'John & Katie',
    maxUploadMb: 5,
    adminPassword: 'secret123',
    listCacheMs: 0,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

test('API flow', async (t) => {
  const { server, base } = makeServer();
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

  await t.test('presign validates type and size', async () => {
    const presign = (body) => fetch(`${base}/api/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal((await presign({ files: [{ name: 'a.pdf', type: 'application/pdf', size: 100 }] })).status, 400);
    assert.equal((await presign({ files: [{ name: 'a.jpg', type: 'image/jpeg', size: 99 * 1024 * 1024 }] })).status, 400);
    assert.equal((await presign({ files: [] })).status, 400);
    const ok = await presign({ files: [{ name: 'a.jpg', type: 'image/jpeg', size: 100 }], uploaderName: 'Dave' });
    assert.equal(ok.status, 200);
    const { uploads } = await ok.json();
    assert.match(uploads[0].key, /^photos\/.*_Dave\.jpg$/);
  });

  let photoKey;
  await t.test('full upload flow: presign → PUT → confirm → listed with thumb', async () => {
    const res = await fetch(`${base}/api/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploaderName: 'Katie', files: [{ name: 'pic.png', type: 'image/png', size: TINY_PNG.length }] }),
    });
    const { uploads } = await res.json();
    photoKey = uploads[0].key;

    const put = await fetch(`${base}${uploads[0].url}`, {
      method: 'PUT',
      headers: uploads[0].headers,
      body: TINY_PNG,
    });
    assert.equal(put.status, 200);

    const confirm = await fetch(`${base}/api/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: photoKey }),
    });
    const confirmBody = await confirm.json();
    assert.equal(confirm.status, 200);
    assert.equal(confirmBody.thumbed, true);

    const { photos, total } = await (await fetch(`${base}/api/photos`)).json();
    assert.ok(total >= 1);
    const mine = photos.find((p) => p.key === photoKey);
    assert.equal(mine.name, 'Katie');
    assert.ok(mine.thumb.startsWith('/img/thumbs/'));

    const img = await fetch(`${base}${mine.full}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    const thumb = await fetch(`${base}${mine.thumb}`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
  });

  await t.test('confirm rejects unknown or malformed keys', async () => {
    const confirm = (key) => fetch(`${base}/api/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    assert.equal((await confirm('photos/20260912T183000123_deadbeef.jpg')).status, 404);
    assert.equal((await confirm('../../etc/passwd')).status, 400);
  });

  await t.test('admin: login required, wrong password rejected, delete works', async () => {
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

    assert.equal((await del(photoKey, cookie)).status, 200);
    const { photos } = await (await fetch(`${base}/api/photos`)).json();
    assert.equal(photos.find((p) => p.key === photoKey), undefined);
  });
});
