'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeKey, parseKey, thumbKeyFor, extFor, sanitizeName } = require('../lib/keys');

test('makeKey/parseKey round-trip with uploader name', () => {
  const key = makeKey(5, 'jpg', 'Auntie Sue!', new Date('2026-09-12T18:30:00.123Z'));
  assert.match(key, /^photos\/table-05\/20260912T183000123_[a-f0-9]{8}_Auntie-Sue\.jpg$/);
  const parsed = parseKey(key);
  assert.equal(parsed.table, 5);
  assert.equal(parsed.name, 'Auntie-Sue');
  assert.equal(parsed.ext, 'jpg');
  assert.equal(parsed.isVideo, false);
});

test('makeKey without a name omits the name segment', () => {
  const key = makeKey(12, 'mp4', '');
  const parsed = parseKey(key);
  assert.equal(parsed.table, 12);
  assert.equal(parsed.name, null);
  assert.equal(parsed.isVideo, true);
});

test('parseKey rejects foreign keys', () => {
  assert.equal(parseKey('photos/table-05/../../etc/passwd'), null);
  assert.equal(parseKey('thumbs/table-05/20260912T183000123_deadbeef.webp'), null);
  assert.equal(parseKey('photos/table-XX/20260912T183000123_deadbeef.jpg'), null);
  assert.equal(parseKey(''), null);
});

test('keys sort newest-first by timestamp segment', () => {
  const older = makeKey(3, 'jpg', '', new Date('2026-09-12T18:00:00Z'));
  const newer = makeKey(3, 'jpg', '', new Date('2026-09-12T21:15:00Z'));
  assert.ok(parseKey(newer).ts > parseKey(older).ts);
});

test('thumbKeyFor maps original to webp thumb', () => {
  assert.equal(
    thumbKeyFor('photos/table-05/20260912T183000123_deadbeef_Dave.heic'),
    'thumbs/table-05/20260912T183000123_deadbeef_Dave.webp',
  );
});

test('extFor prefers mime type, falls back to filename, rejects junk', () => {
  assert.equal(extFor('image/jpeg', 'x.bin'), 'jpg');
  assert.equal(extFor('video/quicktime', 'clip'), 'mov');
  assert.equal(extFor('', 'IMG_1234.HEIC'), 'heic');
  assert.equal(extFor('application/pdf', 'contract.pdf'), null);
  assert.equal(extFor('', 'malware.exe'), null);
});

test('sanitizeName keeps spaces as hyphens, strips the rest, caps length', () => {
  assert.equal(sanitizeName('Auntie Sue & co'), 'Auntie-Sue-co');
  assert.equal(sanitizeName('  <script>alert(1)</script>  '), 'scriptalert1script');
  assert.equal(sanitizeName(undefined), '');
});
