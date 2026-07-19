'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { LocalDriver } = require('../lib/storage');
const { backfillDedupe, SENTINEL } = require('../lib/backfill');
const { makeKey, thumbKeyFor } = require('../lib/keys');

function store(dir) {
  const d = new LocalDriver(dir);
  return {
    putObject: d.putObject.bind(d),
    getObject: d.getObject.bind(d),
    headObject: d.headObject.bind(d),
    deleteObject: d.deleteObject.bind(d),
    listAll: d.listAll.bind(d),
  };
}

async function seedPhoto(storage, key, jpeg) {
  await storage.putObject(key, jpeg, 'image/jpeg');
  await storage.putObject(thumbKeyFor(key), Buffer.from('thumb'), 'image/webp');
}

test('backfill registers photos, removes byte-identical extras (keeps earliest), once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wed-bf-'));
  const storage = store(dir);

  const buddha = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#caa' } }).jpeg().toBuffer();
  const other = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#5a7' } }).jpeg().toBuffer();

  // two byte-identical copies (earliest + later) and one unique
  const early = makeKey('jpg', 'A', new Date('2026-07-19T02:00:00Z'));
  const late = makeKey('jpg', 'B', new Date('2026-07-19T07:00:00Z'));
  const unique = makeKey('jpg', 'C', new Date('2026-07-19T09:00:00Z'));
  await seedPhoto(storage, early, buddha);
  await seedPhoto(storage, late, buddha);
  await seedPhoto(storage, unique, other);

  let changes = 0;
  const res = await backfillDedupe({ storage, onChange: () => { changes += 1; } });
  assert.equal(res.registered, 2, 'two distinct images fingerprinted');
  assert.equal(res.removed, 1, 'one exact duplicate removed');
  assert.ok(changes >= 1);

  const photos = (await storage.listAll('photos/')).map((o) => o.key);
  assert.ok(photos.includes(early), 'earliest kept');
  assert.ok(!photos.includes(late), 'later identical copy removed');
  assert.ok(photos.includes(unique), 'unique kept');
  // the removed copy's thumb is gone too
  assert.ok(!(await storage.listAll('thumbs/')).some((t) => t.key === thumbKeyFor(late)));
  // markers + sentinel written
  assert.equal((await storage.listAll('index/')).filter((o) => o.key !== SENTINEL).length, 2);
  assert.ok(await storage.headObject(SENTINEL).then(() => true));

  // second run is a no-op (sentinel present)
  const again = await backfillDedupe({ storage, onChange: () => {} });
  assert.deepEqual(again, { skipped: true });
});

test('backfill on an already-clean bucket just fingerprints', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wed-bf2-'));
  const storage = store(dir);
  const a = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123' } }).jpeg().toBuffer();
  const b = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#456' } }).jpeg().toBuffer();
  await seedPhoto(storage, makeKey('jpg', '', new Date('2026-07-19T01:00:00Z')), a);
  await seedPhoto(storage, makeKey('jpg', '', new Date('2026-07-19T02:00:00Z')), b);

  const res = await backfillDedupe({ storage, onChange: () => {} });
  assert.equal(res.removed, 0);
  assert.equal(res.registered, 2);
});
